import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RibContext } from "@keelson/shared";
import { parseTrailingDirective } from "./control-json.ts";
import { type DispatchOutcome, dispatchFanout } from "./dispatch.ts";
import {
  DEFAULT_LIMITS,
  decideOrchestratorStep,
  executeStep,
  type OrchestratorLimits,
  type ProgressLedger,
} from "./orchestrator.ts";
import { runConfinedTurn } from "./turn-runner.ts";
import type { Member } from "./types.ts";

// The standing Magentic coordinator (#20 P1). Each round runs ONE coordinator
// runAgentTurn — the manager reasons over the Task Ledger + roster and ENDS with a
// trailing directive (the Progress Ledger answers + the next step). That directive
// drives the pure decider (orchestrator.ts) which routes to the dispatch arm (P1) and,
// later, code/workflow arms. The Task Ledger persists to a single file under the data
// home, so a restart resumes the same task rather than starting over. The manager turn
// is the one cheap-to-get-wrong piece; the control logic it feeds is already pinned by
// P0's tests, so here we lock down parsing, persistence, and the loop's wiring.

// The coordinator's durable working state — the Magentic Task Ledger plus the loop
// counters and a bounded transcript. In-run state (not the governed memory ledger):
// #2 recall/writeback integration is a follow-on (no in-process memory seam today).
export interface CoordinatorLedger {
  task: string;
  projectId?: string;
  // Accumulated findings (folded from each dispatch synthesis + the coordinator).
  facts: string[];
  // The coordinator's current plan as prose steps.
  plan: string[];
  round: number;
  stallCount: number;
  resetCount: number;
  status: "active" | "done" | "gave-up";
  transcript: CoordinatorEntry[];
  summary?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CoordinatorEntry {
  round: number;
  kind: "coordinator" | "dispatch" | "replan";
  speaker?: string;
  instruction?: string;
  text: string;
}

// The directive a coordinator turn must end with: `progress` carries the five Progress
// Ledger answers + the next step, `done` carries the final summary.
const COORDINATOR_ACTIONS: ReadonlySet<string> = new Set(["progress", "done"]);

const FACT_CAP = 600; // per-fact char cap so one long synthesis can't bloat the ledger
const MAX_FACTS = 60; // ledger keeps the most recent facts
const MAX_TRANSCRIPT = 40; // bounded so the prompt + file stay sane
const ENTRY_CAP = 1500; // per-transcript-entry char cap
const LEDGER_FILE = "coordinator-ledger.json";

interface ParsedDirective {
  progress: ProgressLedger;
  facts: string[];
  plan: string[];
  summary?: string;
  head: string;
}

function asBool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}
function asStr(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
function asStrArray(v: unknown): string[] {
  return Array.isArray(v)
    ? v
        .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
        .map((x) => x.trim())
    : [];
}

// Parse a coordinator turn's reply into a directive. Returns null when there is no
// valid trailing directive (the caller falls back). Tolerant on field synonyms, so a
// slightly-off model reply still routes.
export function parseCoordinatorDirective(text: string): ParsedDirective | null {
  const match = parseTrailingDirective(text, COORDINATOR_ACTIONS);
  if (!match) return null;
  const p = match.parsed;
  const facts = asStrArray(p.facts).map((f) => f.slice(0, FACT_CAP));
  const plan = asStrArray(p.plan);
  const summary = asStr(p.summary);

  if (p.action === "done") {
    return {
      progress: { isRequestSatisfied: true, isInLoop: false, isProgressBeingMade: true },
      facts,
      plan,
      ...(summary ? { summary } : {}),
      head: match.head,
    };
  }
  const progress: ProgressLedger = {
    isRequestSatisfied: asBool(p.satisfied) ?? false,
    isInLoop: asBool(p.in_loop ?? p.inLoop) ?? false,
    isProgressBeingMade: asBool(p.progress ?? p.progressing) ?? true,
    ...(asStr(p.next_speaker ?? p.nextSpeaker ?? p.assignee)
      ? { nextSpeaker: asStr(p.next_speaker ?? p.nextSpeaker ?? p.assignee) }
      : {}),
    ...(asStr(p.instruction ?? p.instructionOrQuestion ?? p.question)
      ? { instructionOrQuestion: asStr(p.instruction ?? p.instructionOrQuestion ?? p.question) }
      : {}),
  };
  return { progress, facts, plan, ...(summary ? { summary } : {}), head: match.head };
}

// When a coordinator turn returns no parseable directive, keep the loop honest rather
// than crashing: treat it as a stalled round (so the stall counter advances toward a
// re-plan / give-up) and surface the raw prose. No next-speaker, so the decider holds.
function fallbackDirective(): ParsedDirective {
  return {
    progress: { isRequestSatisfied: false, isInLoop: true, isProgressBeingMade: false },
    facts: [],
    plan: [],
    head: "",
  };
}

// --- ledger persistence (restart-durable) --------------------------------------

function ledgerPath(dataHome: string): string {
  return join(dataHome, LEDGER_FILE);
}

export async function saveLedger(dataHome: string, ledger: CoordinatorLedger): Promise<void> {
  await mkdir(dataHome, { recursive: true });
  const tmp = `${ledgerPath(dataHome)}.tmp`;
  await writeFile(tmp, `${JSON.stringify(ledger, null, 2)}\n`);
  await rename(tmp, ledgerPath(dataHome));
}

// Load the persisted ledger, or undefined when there is none / it is corrupt. A real
// I/O error (EACCES/EIO) rethrows — the ledger has no append-only backstop, so masking
// a read failure as "no ledger" would silently overwrite valid work (chamber's rule).
export async function loadLedger(dataHome: string): Promise<CoordinatorLedger | undefined> {
  let raw: string;
  try {
    raw = await readFile(ledgerPath(dataHome), "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw e;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<CoordinatorLedger>;
    if (!parsed || typeof parsed.task !== "string") return undefined;
    return parsed as CoordinatorLedger;
  } catch (e) {
    if (e instanceof SyntaxError) return undefined; // torn/corrupt file — start fresh
    throw e;
  }
}

function freshLedger(task: string, projectId: string | undefined, at: string): CoordinatorLedger {
  return {
    task,
    ...(projectId ? { projectId } : {}),
    facts: [],
    plan: [],
    round: 0,
    stallCount: 0,
    resetCount: 0,
    status: "active",
    transcript: [],
    createdAt: at,
    updatedAt: at,
  };
}

// Resume the persisted ledger only when it is the SAME task and still active; otherwise
// start fresh (a new task supersedes a stale one).
async function loadOrInit(
  dataHome: string,
  task: string,
  projectId: string | undefined,
  at: string,
): Promise<CoordinatorLedger> {
  const existing = await loadLedger(dataHome);
  if (existing && existing.task === task && existing.status === "active") return existing;
  return freshLedger(task, projectId, at);
}

// --- the coordinator turn ------------------------------------------------------

const COORDINATOR_SYSTEM =
  "You are the coordinator of a Keelson Squad — a small team of persistent AI agents. You own the plan: you decide the next single step, delegate it to the best-suited member, track progress across rounds, and stop when the goal is met. You DIRECT; you do not do the work yourself. Be decisive and concise.";

function renderRoster(roster: readonly Member[]): string {
  if (roster.length === 0) return "(no members)";
  return roster
    .map(
      (m) =>
        `- ${m.slug} (${m.name}, ${m.role || "member"}) — tools: ${m.tools?.length ? m.tools.join(", ") : "text-only"}`,
    )
    .join("\n");
}

function renderTranscript(transcript: readonly CoordinatorEntry[]): string {
  const recent = transcript.slice(-8);
  if (recent.length === 0) return "(nothing yet)";
  return recent
    .map((e) =>
      e.kind === "dispatch"
        ? `Round ${e.round} — ${e.speaker ?? "team"} did: ${e.text}`
        : `Round ${e.round} — coordinator: ${e.text}`,
    )
    .join("\n");
}

function coordinatorPrompt(
  ledger: CoordinatorLedger,
  roster: readonly Member[],
  replan: boolean,
): string {
  const planBlock = ledger.plan.length
    ? ledger.plan.map((s, i) => `${i + 1}. ${s}`).join("\n")
    : "(no plan yet)";
  const factsBlock = ledger.facts.length
    ? ledger.facts.map((f) => `- ${f}`).join("\n")
    : "(none yet)";
  const replanNote = replan
    ? "\nPROGRESS HAS STALLED. Rebuild the plan from scratch — a different approach, or a different member. Do not repeat the step that stalled.\n"
    : "";
  return `Goal:\n${ledger.task}
${replanNote}
Members you may assign (use the slug as next_speaker):
${renderRoster(roster)}

Current plan:
${planBlock}

Findings so far:
${factsBlock}

Recent progress:
${renderTranscript(ledger.transcript)}

Assess the state, then END your reply with EXACTLY ONE JSON object on its own line and nothing after it:
- to continue: {"action":"progress","satisfied":false,"in_loop":false,"progress":true,"next_speaker":"<member slug>","instruction":"<the single next instruction for that member>","plan":["step","step"],"facts":["any new finding"]}
- when the goal is fully met: {"action":"done","summary":"<the final answer / outcome>"}
Set "satisfied" true only when the goal is genuinely complete. Pick next_speaker from the members above. Keep the instruction to ONE concrete step.`;
}

// --- the loop ------------------------------------------------------------------

export interface RunCoordinatorOptions {
  runAgentTurn: NonNullable<RibContext["runAgentTurn"]>;
  membersRoot: string;
  dataHome: string;
  roster: Member[];
  task: string;
  projectId?: string;
  limits?: OrchestratorLimits;
  perTurnTimeoutMs?: number;
  abortSignal?: AbortSignal;
  // Injected for testability; defaults to dispatchFanout bound to the live seams.
  dispatch?: (members: Member[], instruction: string) => Promise<DispatchOutcome>;
  // Injected clock for deterministic tests; defaults to wall-clock.
  now?: () => string;
}

export interface RunCoordinatorResult {
  ledger: CoordinatorLedger;
  rounds: number;
  status: "done" | "gave-up" | "max-rounds" | "error" | "aborted";
  summary: string;
}

const DEFAULT_COORDINATOR_TIMEOUT_MS = 180_000;

function cap(text: string, n: number): string {
  return text.length > n ? `${text.slice(0, n)}…` : text;
}

function foldFacts(existing: readonly string[], added: readonly string[]): string[] {
  if (added.length === 0) return [...existing];
  return [...existing, ...added].slice(-MAX_FACTS);
}
function appendEntry(
  transcript: readonly CoordinatorEntry[],
  entry: CoordinatorEntry,
): CoordinatorEntry[] {
  return [...transcript, { ...entry, text: cap(entry.text, ENTRY_CAP) }].slice(-MAX_TRANSCRIPT);
}

export async function runCoordinator(opts: RunCoordinatorOptions): Promise<RunCoordinatorResult> {
  const now = opts.now ?? (() => new Date().toISOString());
  const limits = opts.limits ?? DEFAULT_LIMITS;
  const timeoutMs = opts.perTurnTimeoutMs ?? DEFAULT_COORDINATOR_TIMEOUT_MS;
  const dispatch =
    opts.dispatch ??
    ((members: Member[], instruction: string) =>
      dispatchFanout({
        runAgentTurn: opts.runAgentTurn,
        membersRoot: opts.membersRoot,
        members,
        task: instruction,
        ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
      }));

  let ledger = await loadOrInit(opts.dataHome, opts.task, opts.projectId, now());
  let replanRequested = false;
  let status: RunCoordinatorResult["status"] = "max-rounds";

  while (true) {
    if (opts.abortSignal?.aborted) {
      status = "aborted";
      break;
    }
    if (ledger.round >= limits.maxRounds) {
      status = "max-rounds";
      break;
    }

    const turn = await runConfinedTurn(
      opts.runAgentTurn,
      {
        system: COORDINATOR_SYSTEM,
        prompt: coordinatorPrompt(ledger, opts.roster, replanRequested),
      },
      timeoutMs,
      opts.abortSignal,
    );
    replanRequested = false;
    if (turn.status !== "ok") {
      status = turn.status === "aborted" ? "aborted" : "error";
      ledger = { ...ledger, updatedAt: now() };
      break;
    }

    const directive = parseCoordinatorDirective(turn.text) ?? fallbackDirective();
    ledger = {
      ...ledger,
      facts: foldFacts(ledger.facts, directive.facts),
      ...(directive.plan.length ? { plan: directive.plan } : {}),
      ...(directive.summary ? { summary: directive.summary } : {}),
      transcript: appendEntry(ledger.transcript, {
        round: ledger.round,
        kind: "coordinator",
        text: directive.head || "(no reasoning)",
      }),
      updatedAt: now(),
    };

    const decided = decideOrchestratorStep({
      progress: directive.progress,
      state: { round: ledger.round, stallCount: ledger.stallCount, resetCount: ledger.resetCount },
      roster: opts.roster,
      limits,
    });
    ledger = {
      ...ledger,
      stallCount: decided.state.stallCount,
      resetCount: decided.state.resetCount,
    };

    if (decided.step.kind === "end") {
      status = decided.step.reason.includes("gave up") ? "gave-up" : "done";
      ledger = {
        ...ledger,
        status: status === "gave-up" ? "gave-up" : "done",
        ...(ledger.summary ? {} : { summary: directive.summary ?? decided.step.reason }),
        updatedAt: now(),
      };
      await saveLedger(opts.dataHome, ledger);
      break;
    }

    if (decided.step.kind === "replan") {
      replanRequested = true;
      ledger = {
        ...ledger,
        round: ledger.round + 1,
        transcript: appendEntry(ledger.transcript, {
          round: ledger.round,
          kind: "replan",
          text: decided.step.reason,
        }),
        updatedAt: now(),
      };
      await saveLedger(opts.dataHome, ledger);
      continue;
    }

    // execute: the dispatch arm (P1)
    const result = await executeStep(decided.step, { dispatch, roster: opts.roster });
    if (result.dispatch) {
      const synth = result.dispatch.synthesis?.trim() || "(no synthesis)";
      ledger = {
        ...ledger,
        facts: foldFacts(ledger.facts, [
          cap(`[${decided.step.speaker ?? "team"}] ${synth}`, FACT_CAP),
        ]),
        transcript: appendEntry(ledger.transcript, {
          round: ledger.round,
          kind: "dispatch",
          ...(decided.step.speaker ? { speaker: decided.step.speaker } : {}),
          instruction: decided.step.instruction,
          text: synth,
        }),
        updatedAt: now(),
      };
    }
    ledger = { ...ledger, round: ledger.round + 1, updatedAt: now() };
    await saveLedger(opts.dataHome, ledger);
  }

  return {
    ledger,
    rounds: ledger.round,
    status,
    summary: ledger.summary ?? `coordinator ended: ${status}`,
  };
}
