import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RibContext } from "@keelson/shared";
import { composeMemberSystemPrompt } from "./compose.ts";
import { extractTrailingJsonObject } from "./control-json.ts";
import { runConfinedTurn } from "./turn-runner.ts";
import type { Member } from "./types.ts";

// The workflow-authoring arm (#20 P3): the coordinator delegates "design a reusable
// workflow for this recurring sub-task" to a member, who authors a Keelson workflow DAG
// (the node taxonomy: prompt/bash/command/loop/script/approval/cancel). We STRUCTURALLY
// validate it (the rib peer-deps only @keelson/shared, not the @keelson/workflows
// loader, so this is a shape check, not full schema validation) and persist it as a
// durable, inspectable artifact under the data home. With the ctx.runWorkflow seam the
// coordinator can ALSO auto-run an authored workflow (confined to the project root) —
// but only when screenWorkflowForRun clears it. That screen is the SOLE pre-execution
// guard: a workflow's bash/script/command/loop-until_bash nodes run on the host
// executor WITHOUT passing through the RAI policy engine, and ctx.runWorkflow takes no
// sandbox (cwd is not confinement), so the screen allowlists only node shapes that
// can't run un-gated code (see screenWorkflowForRun). Everything else stays author-only,
// an artifact the operator installs/runs explicitly. Authoring + running a governed DAG
// is the keelson-unique capability the original squad (a Copilot prompt, no DAG
// substrate) structurally cannot have.

// The node-type keys; a node must carry EXACTLY one of these.
const NODE_TYPES = ["prompt", "bash", "command", "loop", "script", "approval", "cancel"] as const;

const DEFAULT_AUTHOR_TIMEOUT_MS = 180_000;

export interface AuthoredWorkflowNode {
  id: string;
  // Ordering edges. The keelson executor keys ordering on `depends_on` (its DAG
  // schema), so the authored DAG MUST use that field — `needs` is an unknown field
  // the loader warns-and-drops, which would silently flatten every node to a
  // concurrent root and void any intended ordering.
  depends_on?: string[];
  when?: string;
  [k: string]: unknown;
}
export interface AuthoredWorkflow {
  name: string;
  description: string;
  nodes: AuthoredWorkflowNode[];
}

export type ValidateResult = { ok: true; def: AuthoredWorkflow } | { ok: false; error: string };

// Slug-safe name for the artifact filename; empty when nothing usable remains.
function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

// Structural validation of an authored workflow: a name, a non-empty node list, each
// node with a unique id and exactly one node-type key, and any `depends_on` referencing
// a real node. Lenient like keelson's loader (unknown fields pass), strict on the shape
// that makes a DAG well-formed. Never throws.
export function validateWorkflowDef(obj: unknown): ValidateResult {
  if (!obj || typeof obj !== "object") return { ok: false, error: "not an object" };
  const o = obj as Record<string, unknown>;
  const name = typeof o.name === "string" ? o.name.trim() : "";
  if (!name) return { ok: false, error: "missing name" };
  const description = typeof o.description === "string" ? o.description.trim() : "";
  if (!Array.isArray(o.nodes) || o.nodes.length === 0) {
    return { ok: false, error: "missing or empty nodes" };
  }

  const ids = new Set<string>();
  const nodes: AuthoredWorkflowNode[] = [];
  for (const raw of o.nodes) {
    if (!raw || typeof raw !== "object") return { ok: false, error: "a node is not an object" };
    const n = raw as Record<string, unknown>;
    const id = typeof n.id === "string" ? n.id.trim() : "";
    if (!id) return { ok: false, error: "a node is missing an id" };
    if (ids.has(id)) return { ok: false, error: `duplicate node id: ${id}` };
    const typeKeys = NODE_TYPES.filter((t) => n[t] !== undefined);
    if (typeKeys.length !== 1) {
      return {
        ok: false,
        error: `node "${id}" must have exactly one of ${NODE_TYPES.join("/")} (has ${typeKeys.length})`,
      };
    }
    ids.add(id);
    nodes.push(n as AuthoredWorkflowNode);
  }

  for (const n of nodes) {
    const deps = Array.isArray(n.depends_on) ? n.depends_on : [];
    for (const dep of deps) {
      if (typeof dep !== "string" || !ids.has(dep)) {
        return { ok: false, error: `node "${n.id}" depends_on unknown node "${String(dep)}"` };
      }
    }
  }
  return { ok: true, def: { name, description, nodes } };
}

function authorPrompt(task: string): string {
  return `Design a reusable Keelson workflow (a DAG) that accomplishes this recurring task:
${task}

A workflow is a JSON object: {"name":"kebab-case-name","description":"one line","nodes":[ ... ]}.
Each node has an "id" and EXACTLY ONE of these node-type fields:
- "prompt": a string instruction for an agent turn
- "bash": a shell command string
- "command": a slash-command string
- "loop": a loop spec
- "script": a script string
- "approval": a human-approval gate spec
- "cancel": a cancel spec
A node MAY also carry "depends_on": ["<earlier node id>", ...] to order it after others, and "when": "<expression>" to branch. Put an "approval" node before any consequential or irreversible step.

Keep it small and concrete (2-5 nodes). Emit EXACTLY ONE JSON object as your entire reply — no prose, no code fence.`;
}

export interface AuthorWorkflowOptions {
  runAgentTurn: NonNullable<RibContext["runAgentTurn"]>;
  membersRoot: string;
  dataHome: string;
  member: Member;
  task: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}

export type AuthorWorkflowResult =
  | {
      ok: true;
      name: string;
      path: string;
      nodeCount: number;
      description: string;
      def: AuthoredWorkflow;
    }
  | { ok: false; error: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

// Whether a squad-authored workflow is safe for the coordinator to AUTO-RUN via
// ctx.runWorkflow. This is an allowlist by node SHAPE, not a content denylist, because
// a denylist is the wrong shape for the boundary: workflow bash/script/command nodes
// (and a loop's `until_bash` probe) run on the host executor WITHOUT the RAI policy
// engine, ctx.runWorkflow has no sandbox (cwd is not confinement — rib.ts: "the CALLER
// owns trusting the definition"), and an LLM-authored `bash` node can invoke an
// interpreter (`python3 -c …`) to defeat ANY pattern list. So the only sound auto-run
// rule is "no un-gated execution at all": a workflow auto-runs only when EVERY node is
// a policy-GATED agent turn (`prompt`, or a `loop` whose body is a prompt and which has
// no `until_bash` shell probe) or inert (`cancel`). Everything else — bash, script,
// command, an `approval` gate that can't resolve in an autonomous run, or any unknown
// future node type — stays author-only: a durable artifact the operator runs.
export function screenWorkflowForRun(
  def: AuthoredWorkflow,
): { ok: true } | { ok: false; reason: string } {
  for (const node of def.nodes) {
    if (typeof node.prompt === "string") continue; // an agent turn — policy-gated
    if (node.cancel !== undefined) continue; // an inert termination reason
    if (isRecord(node.loop)) {
      // A loop's body is a (gated) agent turn, but its `until_bash` probe is un-gated
      // shell the host runs verbatim each iteration — keep any such loop author-only.
      if (typeof node.loop.until_bash === "string") {
        return {
          ok: false,
          reason: `node "${node.id}" loop runs an until_bash shell probe (ungoverned) — author-only`,
        };
      }
      continue;
    }
    // bash / script / command / approval / an unknown node type: un-gated execution or
    // a gate that can't resolve autonomously. Fail closed.
    return {
      ok: false,
      reason: `node "${node.id}" is not auto-run-safe — only agent prompt/loop steps run autonomously; author-only`,
    };
  }
  return { ok: true };
}

// Run one authoring turn (the member's identity as system, the task framing in the
// prompt), validate the result, and persist it. Never throws; every failure maps to an
// { ok:false, error } the caller folds into the ledger.
export async function authorWorkflow(opts: AuthorWorkflowOptions): Promise<AuthorWorkflowResult> {
  const system = await composeMemberSystemPrompt(opts.membersRoot, opts.member);
  const outcome = await runConfinedTurn(
    opts.runAgentTurn,
    { system, prompt: authorPrompt(opts.task) },
    opts.timeoutMs ?? DEFAULT_AUTHOR_TIMEOUT_MS,
    opts.abortSignal,
  );
  if (outcome.status !== "ok") {
    return {
      ok: false,
      error: `authoring turn ${outcome.status}${outcome.error ? `: ${outcome.error}` : ""}`,
    };
  }

  const json = extractTrailingJsonObject(outcome.text);
  if (!json) return { ok: false, error: "no workflow JSON in the authoring reply" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, error: "the authored workflow JSON did not parse" };
  }
  const validated = validateWorkflowDef(parsed);
  if (!validated.ok) return { ok: false, error: `invalid workflow: ${validated.error}` };

  const slug = slugifyName(validated.def.name);
  if (!slug) return { ok: false, error: "the workflow name has no usable slug" };
  const dir = join(opts.dataHome, "authored-workflows");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${slug}.json`);
  await writeFile(path, `${JSON.stringify(validated.def, null, 2)}\n`);
  return {
    ok: true,
    name: validated.def.name,
    path,
    nodeCount: validated.def.nodes.length,
    description: validated.def.description,
    def: validated.def,
  };
}
