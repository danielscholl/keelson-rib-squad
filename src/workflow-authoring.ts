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
// durable, inspectable artifact under the data home. Registering + RUNNING it from a
// turn needs a runtime workflow-authoring host seam keelson does not expose yet
// (tracked on #9 / #20 §4) — until then, installing/running the authored workflow is an
// explicit operator step. This is the keelson-unique capability the original squad
// (a Copilot prompt, no DAG substrate) structurally cannot have.

// The node-type keys; a node must carry EXACTLY one of these.
const NODE_TYPES = ["prompt", "bash", "command", "loop", "script", "approval", "cancel"] as const;

const DEFAULT_AUTHOR_TIMEOUT_MS = 180_000;

export interface AuthoredWorkflowNode {
  id: string;
  needs?: string[];
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
// node with a unique id and exactly one node-type key, and any `needs` referencing a
// real node. Lenient like keelson's loader (unknown fields pass), strict on the shape
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
    const needs = Array.isArray(n.needs) ? n.needs : [];
    for (const dep of needs) {
      if (typeof dep !== "string" || !ids.has(dep)) {
        return { ok: false, error: `node "${n.id}" needs unknown node "${String(dep)}"` };
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
A node MAY also carry "needs": ["<earlier node id>", ...] to order it after others, and "when": "<expression>" to branch. Put an "approval" node before any consequential or irreversible step.

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
  | { ok: true; name: string; path: string; nodeCount: number; description: string }
  | { ok: false; error: string };

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
  };
}
