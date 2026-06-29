import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RibAgentTurn, RibAgentTurnResult, RibContext } from "@keelson/shared";
import { errText, z } from "@keelson/shared";

// Auto-cast: inspect a project and propose the team best suited to it. This is the
// defining capability — chamber hand-authors each Mind; squad reads the repo and
// composes the roster. Built on an INJECTED runAgentTurn (the host seam), like
// dispatch.ts, so the scan is unit-testable against a fake. The scan turn is
// READ-ONLY and CONFINED to the project root (cwd + allowedDirectories + a
// read-only tool rail); scaffolding the approved members is the only write, and it
// happens later, on approve.

// The read-only rail the scan turn runs under. allowedTools present means "these
// and no others" at the host (see apps/server rib-agent-turn.ts), so Bash/Edit/
// Write are excluded — the scan can read the repo but never modify it.
export const SCAN_TOOLS = ["Read", "Glob", "Grep"] as const;

// Cap the proposed team so a runaway scan can't author dozens of members. The
// truncation is surfaced as a note, never silent.
export const MAX_CAST_MEMBERS = 6;

const DEFAULT_SCAN_TIMEOUT_MS = 300_000;

// The structured roster the scan turn must return. Lenient on the optionals
// (model/provider/tools) and strict on the identity core (name/role/charter), so a
// partial-but-usable proposal still parses. Capability `tools` are free-form here
// (deduped/trimmed later), matching Phase 0's squad_emit_member — the prompt steers
// the model toward the code/read vocabulary the coordinator will route on.
const castMemberSchema = z.object({
  name: z.string().min(1),
  role: z.string().min(1),
  charter: z.string().min(1),
  tools: z.array(z.string()).optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
});
export const castProposalSchema = z.object({
  members: z.array(castMemberSchema).min(1),
  summary: z.string().optional(),
});

// One proposed member, normalized (tools deduped/trimmed). The persisted/board shape.
export interface CastProposalMember {
  name: string;
  role: string;
  charter: string;
  tools?: string[];
  model?: string;
  provider?: string;
}

// The pending proposal persisted to cast-proposal.json and rendered by the
// squad-cast collector. Carries the project it was cast for so the board can label
// it and approve can run without re-resolving; `notes` surfaces a member-cap
// truncation; `summary` is the scan's optional one-line description of the team.
export interface CastProposalRecord {
  projectId: string;
  projectName: string;
  rootPath: string;
  mission?: string;
  members: CastProposalMember[];
  summary?: string;
  notes: string[];
  createdAt: string;
}

export type ProposeCastResult =
  | { ok: true; proposal: CastProposalRecord }
  | { ok: false; error: string };

export interface ProposeCastOptions {
  runAgentTurn: NonNullable<RibContext["runAgentTurn"]>;
  project: { id: string; name: string; rootPath: string };
  mission?: string;
  maxMembers?: number;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}

const SCAN_SYSTEM =
  "You are a staffing architect for a Keelson Squad — a small team of persistent AI agents an operator talks to directly. You inspect a real software project and propose the team best suited to the work in it. You read the repository to staff it well; you never modify it.";

function scanPrompt(projectName: string, mission: string | undefined, maxMembers: number): string {
  const missionBlock = mission
    ? `\nThe operator's mission for this squad:\n---\n${mission}\n---\n`
    : "";
  return `Inspect the project at the current working directory ("${projectName}"). Use the read-only tools (Read, Glob, Grep) to learn what it actually is: its languages and frameworks, how the code is laid out, its docs, tests, and CI. Read enough to staff it well — do not modify anything.
${missionBlock}
Propose the SMALL team (typically 3-5 members, never more than ${maxMembers}) best suited to THIS project and mission. For each member decide:
- name: a short proper handle (a person-like name, NOT a job title)
- role: a 1-4 word role title (e.g. "Backend Engineer", "Reviewer", "Tech Lead")
- charter: a Markdown identity doc with these sections in order — "# <name>", "## Role", "## Mission", "## Voice" — grounded in what you actually found in the repo (name the real frameworks/dirs you saw). Be honest: do not invent tools, credentials, or capabilities the member will not have.
- tools: capability tags that decide how this member can later be routed. Use ONLY these tags: "code" (may modify the repo) and "read" (may read the repo). An implementer/engineer gets ["code","read"]; a reviewer, lead, planner, or PM gets ["read"] or [] (text-only). Reserve "code" for true implementers — most members are text-only or read-only.

Return EXACTLY ONE JSON object as your entire reply — no prose, no code fence:
{"members":[{"name":"...","role":"...","charter":"...","tools":["read"]}],"summary":"one line describing the team"}`;
}

// Run ONE confined repo-scan turn and return a validated, capped proposal. The turn
// is read-only (SCAN_TOOLS) and bounded to the project root (cwd +
// allowedDirectories) — granting reads and confining them are one decision. Never
// throws: every failure mode (absent root, turn error, unparseable output) maps to
// an { ok:false, error } the caller surfaces.
export async function proposeCast(opts: ProposeCastOptions): Promise<ProposeCastResult> {
  const root = opts.project.rootPath.trim();
  // An empty root would confine to nothing — fail closed rather than scan unbounded.
  if (!root) {
    return { ok: false, error: `project "${opts.project.name}" has no root path to scan` };
  }
  const maxMembers = Math.max(1, opts.maxMembers ?? MAX_CAST_MEMBERS);
  const mission = opts.mission?.trim() || undefined;

  const outcome = await runScanTurn(
    opts.runAgentTurn,
    {
      system: SCAN_SYSTEM,
      prompt: scanPrompt(opts.project.name, mission, maxMembers),
      cwd: root,
      allowedDirectories: [root],
      allowedTools: [...SCAN_TOOLS],
    },
    opts.timeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS,
    opts.abortSignal,
  );
  if (outcome.status !== "ok") {
    return {
      ok: false,
      error: `repo-scan turn ${outcome.status}${outcome.error ? `: ${outcome.error}` : ""}`,
    };
  }

  const extracted = extractJson(outcome.text);
  const parsed = castProposalSchema.safeParse(extracted);
  if (!parsed.success) {
    return { ok: false, error: "repo-scan did not return a valid roster proposal" };
  }

  const notes: string[] = [];
  let members = parsed.data.members.map(normalizeMember);
  if (members.length > maxMembers) {
    notes.push(`proposed ${members.length} members — capped to ${maxMembers}`);
    members = members.slice(0, maxMembers);
  }

  return {
    ok: true,
    proposal: {
      projectId: opts.project.id,
      projectName: opts.project.name,
      rootPath: root,
      ...(mission ? { mission } : {}),
      members,
      ...(parsed.data.summary?.trim() ? { summary: parsed.data.summary.trim() } : {}),
      notes,
      createdAt: new Date().toISOString(),
    },
  };
}

function normalizeMember(m: z.infer<typeof castMemberSchema>): CastProposalMember {
  const tools = m.tools
    ? [...new Set(m.tools.map((t) => t.trim()).filter((t) => t.length > 0))]
    : [];
  const model = m.model?.trim();
  const provider = m.provider?.trim();
  return {
    name: m.name.trim(),
    role: m.role.trim(),
    charter: m.charter,
    ...(tools.length > 0 ? { tools } : {}),
    // A provider may stand alone (pin the vendor, default model); a model needs its
    // provider — the same coherence rule the store keeps. Lenient: an incoherent
    // model-without-provider proposal drops the model rather than rejecting.
    ...(provider ? { provider } : {}),
    ...(provider && model ? { model } : {}),
  };
}

interface TurnOutcome {
  status: "ok" | "error" | "timeout" | "aborted";
  text: string;
  error?: string;
}

// Run the scan turn to its settled result, mirroring dispatch.ts's executeTurn:
// own a per-turn AbortController linked to the parent signal, drain the stream (the
// result is the source of truth), and race the result against the timeout — aborting
// the turn on timeout so a hung provider can't wedge the board action. Never throws.
async function runScanTurn(
  run: NonNullable<RibContext["runAgentTurn"]>,
  req: Omit<Parameters<NonNullable<RibContext["runAgentTurn"]>>[0], "abortSignal" | "timeoutMs">,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<TurnOutcome> {
  if (parentSignal?.aborted) return { status: "aborted", text: "" };

  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  parentSignal?.addEventListener("abort", onParentAbort, { once: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const turn: RibAgentTurn = run({ ...req, abortSignal: controller.signal, timeoutMs });
    // Wrap so neither branch rejects: a timed-out turn's still-pending drain must
    // not surface as an unhandled rejection once the race has settled.
    const settled = drainResult(turn).then(
      (result) => ({ kind: "result" as const, result }),
      (err) => ({ kind: "error" as const, err }),
    );
    const timed = new Promise<{ kind: "timeout" }>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ kind: "timeout" });
      }, timeoutMs);
    });

    const outcome = await Promise.race([settled, timed]);
    if (outcome.kind === "timeout") {
      return { status: "timeout", text: "", error: `repo-scan exceeded ${timeoutMs}ms` };
    }
    if (outcome.kind === "error") {
      return { status: "error", text: "", error: errText(outcome.err) };
    }
    const result = outcome.result;
    if (controller.signal.aborted || result.status === "aborted") {
      return { status: "aborted", text: result.text ?? "" };
    }
    if (result.status === "ok") return { status: "ok", text: result.text };
    return {
      status: result.status,
      text: "",
      error: result.error ?? result.text ?? `turn ${result.status}`,
    };
  } catch (e) {
    return { status: "error", text: "", error: errText(e) };
  } finally {
    if (timer) clearTimeout(timer);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}

// Drain the live stream to completion, then take the settled result (the source of
// truth). A stream error is swallowed — it resurfaces via result.status.
async function drainResult(turn: RibAgentTurn): Promise<RibAgentTurnResult> {
  try {
    for await (const _chunk of turn.stream) {
      // result is the source of truth; the stream is drained, not consumed
    }
  } catch {
    // a stream error surfaces via result.status below
  }
  return await turn.result;
}

// Pull the JSON object out of a model reply that may wrap it in a code fence or a
// sentence: prefer a fenced block, else the first `{` to the last `}`. Returns
// undefined when nothing parses, so the caller fails closed on malformed output.
function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const body = (fenced ?? text).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return undefined;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

// --- proposal persistence -------------------------------------------------------
// The proposal lives as one file under the Squad data home so the (out-of-process)
// squad-cast collector and the (in-process) approve/discard handlers share one
// source of truth, the same split the roster collector and genesis use.

const CAST_PROPOSAL_FILE = "cast-proposal.json";

export async function writeProposal(dataHome: string, proposal: CastProposalRecord): Promise<void> {
  await mkdir(dataHome, { recursive: true });
  await writeFile(join(dataHome, CAST_PROPOSAL_FILE), `${JSON.stringify(proposal, null, 2)}\n`);
}

// Read the pending proposal back, or undefined when there is none / it is
// unreadable / it fails validation — so a corrupt file reads as "no proposal"
// rather than crashing the collector or the approve path.
export async function readProposal(dataHome: string): Promise<CastProposalRecord | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(dataHome, CAST_PROPOSAL_FILE), "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<CastProposalRecord>;
    if (typeof parsed !== "object" || parsed === null) return undefined;
    if (typeof parsed.projectName !== "string" || !Array.isArray(parsed.members)) return undefined;
    const members = parsed.members
      .filter(
        (m): m is CastProposalMember =>
          typeof m === "object" &&
          m !== null &&
          typeof (m as CastProposalMember).name === "string" &&
          typeof (m as CastProposalMember).charter === "string",
      )
      .map(normalizeStoredMember);
    if (members.length === 0) return undefined;
    return {
      projectId: typeof parsed.projectId === "string" ? parsed.projectId : "",
      projectName: parsed.projectName,
      rootPath: typeof parsed.rootPath === "string" ? parsed.rootPath : "",
      ...(typeof parsed.mission === "string" && parsed.mission ? { mission: parsed.mission } : {}),
      members,
      ...(typeof parsed.summary === "string" && parsed.summary ? { summary: parsed.summary } : {}),
      notes: Array.isArray(parsed.notes)
        ? parsed.notes.filter((n): n is string => typeof n === "string")
        : [],
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
    };
  } catch {
    return undefined;
  }
}

function normalizeStoredMember(m: CastProposalMember): CastProposalMember {
  return {
    name: m.name,
    role: typeof m.role === "string" && m.role ? m.role : "",
    charter: m.charter,
    ...(Array.isArray(m.tools) && m.tools.length > 0
      ? { tools: m.tools.filter((t): t is string => typeof t === "string") }
      : {}),
    ...(typeof m.provider === "string" && m.provider ? { provider: m.provider } : {}),
    ...(typeof m.provider === "string" && m.provider && typeof m.model === "string" && m.model
      ? { model: m.model }
      : {}),
  };
}

export async function clearProposal(dataHome: string): Promise<void> {
  await rm(join(dataHome, CAST_PROPOSAL_FILE), { force: true });
}
