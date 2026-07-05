import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryTools, RibContext, RibExec, TokenUsage } from "@keelson/shared";
import {
  type ChangeQualityDiffNumstat,
  type DiffNameStatusEntry,
  type DiffNumstatEntry,
  type DiffTokenNetCounts,
  detectChangeQualityViolations,
} from "./change-quality.ts";
import { runCodeTurn } from "./code.ts";
import { parseTrailingDirective } from "./control-json.ts";
import {
  type DispatchOutcome,
  type DispatchResult,
  dispatchFanout,
  type MemberContribution,
  reflectMembersAtClose,
} from "./dispatch.ts";
import {
  type DistillResult,
  distillOutcome,
  recallGrounding,
  reflectDistilled,
  reflectOutcome,
} from "./memory.ts";
import {
  type CodeStepOutcome,
  decideOrchestratorStep,
  executeStep,
  type OrchestratorLimits,
  type OrchestratorStep,
  overlayLimits,
  type ProgressLedger,
  type WorkflowStepOutcome,
} from "./orchestrator.ts";
import { hasBlockVerdict } from "./policies.ts";
import { archiveRun } from "./runs-store.ts";
import { runConfinedTurn, type ToolTrace } from "./turn-runner.ts";
import type { Member } from "./types.ts";
import { authorWorkflow, screenWorkflowForRun } from "./workflow-authoring.ts";

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
  scopeId?: string;
  projectId?: string;
  // Durable run-delta baseline tree for change-quality checks. Captured once per active
  // ledger and reused across resumed invocations so prior-pass edits cannot evade the gate.
  baselineTree?: string;
  // The commit HEAD pointed at when the run started, captured atomically with baselineTree so the
  // incomplete-commit gate can tell whether the run created a commit. Absent for ledgers started
  // before this field existed (the gate then degrades to its prior working-tree-only behavior).
  baselineHeadSha?: string;
  // Accumulated findings (folded from each dispatch synthesis + the coordinator).
  facts: string[];
  // The coordinator's current plan as prose steps.
  plan: string[];
  round: number;
  roundBudget?: number;
  stallCount: number;
  resetCount: number;
  // Deterministic repeated-outcome tracker: the fingerprint of the last execute outcome
  // (speaker + normalized text) and how many consecutive rounds produced it. Feeds the
  // orchestrator's stall backstop so a doomed step repeated under a "progress" claim is caught.
  outcomeRepeat?: { fingerprint: string; count: number };
  // "active" resumes on a same-task re-run; the terminal states (done / gave-up /
  // max-rounds) do not, so a finished task starts fresh rather than re-tripping its
  // own ceiling and returning a stale summary having run zero turns.
  status: CoordinatorLedgerStatus;
  transcript: CoordinatorEntry[];
  // Steps attempted on a now-abandoned plan, swept on a re-plan so the rebuild is told not
  // to resume them; cleared once a non-stalled round shows the new plan is working again.
  failedSteps?: string[];
  // Specialists the squad judged its roster lacks for this goal — a "cast this" recommendation
  // surfaced to the operator, NOT acted on autonomously (roster mutation stays operator-gated).
  teamGaps?: string[];
  // The latest deterministic verification result — operator-configured checks run against the
  // project at the done-gate. A red result vetoes `done`, so squad's "done" is machine-proven,
  // not self-asserted. Absent when no verify commands are configured or no code was edited.
  verification?: VerificationRecord;
  // Consecutive done-gate verify failures; bounds the fix-and-recheck loop so a run that can't
  // go green terminates `verification-failed` rather than burning the whole round budget.
  verifyFailures?: number;
  // Consecutive done-gate change-quality failures; bounds quality refinement the same way
  // verification failures are bounded.
  changeQualityFailures?: number;
  // Consecutive done-gate incomplete-commit failures; bounded like the counters above so a run
  // that keeps leaving edits uncommitted terminates rather than burning the whole round budget.
  incompleteCommitFailures?: number;
  // The latest round that executed a code step (our concrete "code changed/ran" marker).
  lastCodeRound?: number;
  // The latest round where the project-bound adversarial review was clean (no BLOCK verdict).
  lastCleanReviewRound?: number;
  summary?: string;
  // The turn currently executing — set just before the execute arm runs and cleared the moment
  // it returns, so a streamed Run-loop board can show "work being assigned" in real time. A
  // terminal/replanning run carries none. Optional so old ledgers and existing callers are intact.
  inFlight?: InFlightTurn;
  // Dispositions the manager attached to the run-terminating done directive; persisted only on
  // a genuine done so consumers (squad_resolve_review) read structured rows, not capped prose.
  dispositions?: DoneDisposition[];
  createdAt: string;
  updatedAt: string;
}

export interface InFlightTurn {
  round: number;
  speaker?: string;
  action: string;
  instruction?: string;
  startedAt?: string;
  // The live tool trace the executing turn has produced so far (#113) — updated on a
  // throttle while the turn runs, so a watching board streams the work as it happens.
  tools?: ToolTrace[];
}

// Per-item disposition rows a task may require the manager to attach to its done
// directive (e.g. squad_resolve_review's per-thread fixed/declined verdicts). Carried
// as directive JSON — never prose — so ENTRY_CAP truncation can't destroy them.
export interface DoneDisposition {
  threadRef: string;
  disposition: "fixed" | "declined";
  note: string;
}

export interface CoordinatorEntry {
  round: number;
  kind: "coordinator" | "dispatch" | "code" | "workflow" | "replan" | "failed" | "verify";
  speaker?: string;
  instruction?: string;
  text: string;
  // The provider id that produced this step's work (code / dispatch arms) — the served-provider
  // provenance the standup and Run-loop board surface for a mixed-provider team.
  provider?: string;
  verdict?: "pass" | "block";
  // Per-code-step repo footprint (including untracked files) surfaced for manager visibility.
  touched?: { files: number; insertions: number; deletions: number };
  // Observability captured from the step's turn(s) (#113); all optional so ledgers
  // written before these fields existed keep loading and rendering.
  at?: string;
  durationMs?: number;
  usage?: TokenUsage;
  tools?: ToolTrace[];
}

// A deterministic verification result: the operator-configured check that gates `done`.
// `command` is the failing command (or a count summary on pass); `summary` is a capped tail of
// its output so a failure's actual reason reaches the manager and the board.
export interface VerificationRecord {
  command: string;
  exitCode: number;
  passed: boolean;
  summary: string;
  atRound: number;
  checks?: readonly VerificationCheck[];
}

export interface VerificationCheck {
  command: string;
  passed: boolean;
  exitCode: number;
  summary: string;
}

export const LEDGER_STATUS_ACTIVE = "active" as const;
export const RUN_STATUS_DONE = "done" as const;
export const RUN_STATUS_GAVE_UP = "gave-up" as const;
export const RUN_STATUS_MAX_ROUNDS = "max-rounds" as const;
export const RUN_STATUS_VERIFICATION_FAILED = "verification-failed" as const;
export const RUN_STATUS_CHANGE_QUALITY_FAILED = "change-quality-failed" as const;
export const RUN_STATUS_ABORTED = "aborted" as const;

export type CoordinatorTerminalStatus =
  | typeof RUN_STATUS_DONE
  | typeof RUN_STATUS_GAVE_UP
  | typeof RUN_STATUS_MAX_ROUNDS
  | typeof RUN_STATUS_VERIFICATION_FAILED
  | typeof RUN_STATUS_CHANGE_QUALITY_FAILED
  | typeof RUN_STATUS_ABORTED;
export type CoordinatorLedgerStatus = typeof LEDGER_STATUS_ACTIVE | CoordinatorTerminalStatus;
export type RunCoordinatorStatus = CoordinatorTerminalStatus | "error";

function isTerminalStatus(status: RunCoordinatorStatus): status is CoordinatorTerminalStatus {
  return (
    status === RUN_STATUS_DONE ||
    status === RUN_STATUS_GAVE_UP ||
    status === RUN_STATUS_MAX_ROUNDS ||
    status === RUN_STATUS_VERIFICATION_FAILED ||
    status === RUN_STATUS_CHANGE_QUALITY_FAILED ||
    status === RUN_STATUS_ABORTED
  );
}

// The directive a coordinator turn must end with: `progress` carries the five Progress
// Ledger answers + the next step, `done` carries the final summary.
const COORDINATOR_ACTIONS: ReadonlySet<string> = new Set(["progress", "done"]);

const FACT_CAP = 600; // per-fact char cap so one long synthesis can't bloat the ledger
// Floor between live in-flight trace persists, so a tool-heavy turn (dozens of calls
// in seconds) can't turn the ledger file + board refresh into a write storm.
const LIVE_TRACE_THROTTLE_MS = 2000;
const MAX_FACTS = 60; // ledger keeps the most recent facts
const MAX_TRANSCRIPT = 40; // bounded so the prompt + file stay sane
const ENTRY_CAP = 1500; // per-transcript-entry char cap
const MAX_FAILED = 20; // bounded list of recently-abandoned steps surfaced on a re-plan
const STEP_DESC_CAP = 200; // per-swept-step char cap so the re-plan prompt stays compact
const MAX_GAPS = 6; // bounded list of "the roster lacks X" recommendations
const GAP_CAP = 160; // per-gap char cap so a recommendation stays a short headline
export const MAX_VERIFY_FAILURES = 3; // consecutive done-gate failures before terminating
// The same execute outcome (member + normalized text) this many rounds running is treated as a
// deterministic stall, independent of the manager's self-reported progress (issue #57).
export const REPEAT_STALL_AT = 2;

// Stable fingerprint of an execute outcome for repeat detection: speaker + a normalized,
// length-capped signature of the outcome text. Only execute outcomes (dispatch/code/workflow)
// count — coordinator/replan/failed/verify entries aren't repeatable work. Returns undefined for
// a non-outcome entry so the driver leaves the repeat counter untouched.
function outcomeFingerprint(entry: CoordinatorEntry | undefined): string | undefined {
  if (!entry) return undefined;
  if (entry.kind !== "dispatch" && entry.kind !== "code" && entry.kind !== "workflow") {
    return undefined;
  }
  const speaker = entry.speaker ?? "team";
  const signature = (entry.text ?? "").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 240);
  return `${speaker}:${signature}`;
}
export const MAX_CHANGE_QUALITY_FAILURES = 3; // consecutive done-gate quality failures before terminating
const VERIFY_TIMEOUT_MS = 300_000; // per verify command — test suites can be slow
const VERIFY_SUMMARY_CAP = 800; // capped tail of a failing command's output folded as a fact
const LEDGER_FILE = "coordinator-ledger.json";

interface ParsedDirective {
  progress: ProgressLedger;
  facts: string[];
  plan: string[];
  // Specialists the manager judges the CURRENT roster lacks for this goal — surfaced as a
  // "cast this" recommendation, not acted on autonomously (roster mutation stays operator-gated).
  needs: string[];
  summary?: string;
  dispositions?: DoneDisposition[];
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

const DISPOSITION_ROW_CAP = 200;
const DISPOSITION_NOTE_CAP = 500;
function asDispositionRows(v: unknown): DoneDisposition[] {
  if (!Array.isArray(v)) return [];
  const rows: DoneDisposition[] = [];
  for (const item of v.slice(0, DISPOSITION_ROW_CAP)) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const threadRef = typeof row.threadRef === "string" ? row.threadRef.trim() : "";
    const disposition = row.disposition;
    if (!threadRef || (disposition !== "fixed" && disposition !== "declined")) continue;
    const note = typeof row.note === "string" ? row.note.trim().slice(0, DISPOSITION_NOTE_CAP) : "";
    rows.push({ threadRef, disposition, note });
  }
  return rows;
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
  const needs = asStrArray(p.needs ?? p.missing).map((n) => n.slice(0, GAP_CAP));
  const summary = asStr(p.summary);

  if (p.action === "done") {
    const dispositions = asDispositionRows(p.dispositions);
    return {
      progress: { isRequestSatisfied: true, isInLoop: false, isProgressBeingMade: true },
      facts,
      plan,
      needs,
      ...(summary ? { summary } : {}),
      ...(dispositions.length > 0 ? { dispositions } : {}),
      head: match.head,
    };
  }
  const mode = asStr(p.mode);
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
    ...(mode === "code" || mode === "dispatch" || mode === "workflow" ? { mode } : {}),
  };
  return { progress, facts, plan, needs, ...(summary ? { summary } : {}), head: match.head };
}

// When a coordinator turn returns no parseable directive, keep the loop honest rather
// than crashing: treat it as a stalled round (so the stall counter advances toward a
// re-plan / give-up) and surface the raw prose. No next-speaker, so the decider holds.
function fallbackDirective(): ParsedDirective {
  return {
    progress: { isRequestSatisfied: false, isInLoop: true, isProgressBeingMade: false },
    facts: [],
    plan: [],
    needs: [],
    head: "",
  };
}

// --- ledger persistence (restart-durable) --------------------------------------

function ledgerPath(dataHome: string): string {
  return join(dataHome, LEDGER_FILE);
}

export async function saveLedger(dataHome: string, ledger: CoordinatorLedger): Promise<void> {
  await mkdir(dataHome, { recursive: true });
  // A pid-unique temp keeps two writers (e.g. overlapping coordinate calls) from
  // interleaving into one `.tmp` and renaming a torn file into place.
  const tmp = `${ledgerPath(dataHome)}.${process.pid}.tmp`;
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

function freshLedger(
  task: string,
  scopeId: string | undefined,
  projectId: string | undefined,
  at: string,
  roundBudget: number,
): CoordinatorLedger {
  return {
    task,
    ...(scopeId ? { scopeId } : {}),
    ...(projectId ? { projectId } : {}),
    facts: [],
    plan: [],
    round: 0,
    roundBudget,
    stallCount: 0,
    resetCount: 0,
    status: LEDGER_STATUS_ACTIVE,
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
  scopeId: string | undefined,
  projectId: string | undefined,
  at: string,
  roundBudget: number,
  forceFresh = false,
): Promise<CoordinatorLedger> {
  const existing = await loadLedger(dataHome);
  if (
    !forceFresh &&
    existing &&
    existing.task === task &&
    existing.status === LEDGER_STATUS_ACTIVE &&
    // Resume only within the SAME project — a generic task ("fix the failing tests")
    // run against repo A then repo B must not resume A's facts/plan while the code arm
    // confines edits to B.
    (existing.projectId ?? undefined) === (projectId ?? undefined)
  ) {
    return existing.scopeId || !scopeId ? existing : { ...existing, scopeId };
  }
  return freshLedger(task, scopeId, projectId, at, roundBudget);
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
  return recent.map((e) => `Round ${e.round} — ${renderTranscriptEntry(e)}`).join("\n");
}

function renderTranscriptEntry(e: CoordinatorEntry): string {
  if (e.kind === "dispatch") return `${e.speaker ?? "team"} did: ${e.text}`;
  if (e.kind === "code") {
    const touched = e.touched
      ? ` [touched ${e.touched.files} file${e.touched.files === 1 ? "" : "s"}, +${e.touched.insertions} -${e.touched.deletions}]`
      : "";
    return `${e.speaker ?? "member"} coded: ${e.text}${touched}`;
  }
  if (e.kind === "workflow") return `${e.speaker ?? "member"} workflow: ${e.text}`;
  if (e.kind === "verify") return `verify: ${e.text}`;
  if (e.kind === "replan") return `replan: ${e.text}`;
  if (e.kind === "failed") return `failed: ${e.text}`;
  return `coordinator: ${e.text}`;
}

function coordinatorPrompt(
  ledger: CoordinatorLedger,
  roster: readonly Member[],
  replan: boolean,
  canCode: boolean,
  recalled: readonly string[],
  project?: { name: string; rootPath: string },
): string {
  const planBlock = ledger.plan.length
    ? ledger.plan.map((s, i) => `${i + 1}. ${s}`).join("\n")
    : "(no plan yet)";
  // Prior governed decisions/lessons recalled for this task — shown so the manager
  // grounds the plan in what the team already learned. Omitted entirely when none.
  const recalledNote = recalled.length
    ? `\nPrior decisions & lessons (recalled from the team's memory — honor them):\n${recalled.map((r) => `- ${r}`).join("\n")}\n`
    : "";
  const factsBlock = ledger.facts.length
    ? ledger.facts.map((f) => `- ${f}`).join("\n")
    : "(none yet)";
  const failedBlock =
    replan && ledger.failedSteps?.length
      ? `\nAlready attempted and abandoned on the prior plan — do NOT resume these:\n${ledger.failedSteps
          .map((s) => `- ${s}`)
          .join("\n")}`
      : "";
  const replanNote = replan
    ? `\nPROGRESS HAS STALLED. Rebuild the plan from scratch — a different approach, or a different member. Do not repeat the step that stalled.${failedBlock}\n`
    : "";
  // Deterministic repeat warning (#57): the same step produced the same outcome N rounds running.
  // Re-dispatching it is futile — tell the manager to change approach before the stall cap forces it.
  const repeatNote =
    ledger.outcomeRepeat && ledger.outcomeRepeat.count >= REPEAT_STALL_AT
      ? `\n⚠ The last step produced an IDENTICAL outcome ${ledger.outcomeRepeat.count} rounds running. Re-dispatching it will not help — change approach: a different member, a different step, or investigate the blocker. Do NOT repeat the same instruction to the same member.\n`
      : "";
  const groundingBlock = project
    ? `\nGROUNDING:\nBound project: "${project.name}" — repository root: ${project.rootPath}. Every code step is CONFINED to this repository (the member is dropped into it). Refer to files by their path within this project; do NOT name, guess, or search the filesystem for any other repository or path.\n`
    : "";
  // The code arm is only offered when a project is bound (the turn is confined to it);
  // a code-tagged member then EDITS the repo instead of just reasoning.
  const codeNote = canCode
    ? '\n- to have a code-capable member EDIT the project repo for a step, add "mode":"code" (the next_speaker MUST have the "code" tool); omit it (or "mode":"dispatch") for a reasoning/analysis step.'
    : "";
  const workflowNote =
    '\n- to author a REUSABLE workflow (a DAG) for recurring/deterministic sub-work, add "mode":"workflow" with an instruction describing what it should do.';
  const needsNote =
    '\n- if the members above lack a capability this goal needs, add "needs":["<the missing specialist, e.g. a security reviewer>"] so the operator can cast them. This is a non-blocking recommendation — keep going with the best available member; do NOT wait.';
  return `Goal:\n${ledger.task}
${replanNote}${repeatNote}${groundingBlock}
Members you may assign (use the slug as next_speaker):
${renderRoster(roster)}

Current plan:
${planBlock}
${recalledNote}
Findings so far:
${factsBlock}

Recent progress:
${renderTranscript(ledger.transcript)}

Assess the state, then END your reply with EXACTLY ONE JSON object on its own line and nothing after it:
- to continue: {"action":"progress","satisfied":false,"in_loop":false,"progress":true,"next_speaker":"<member slug>","instruction":"<the single next instruction for that member>","plan":["step","step"],"facts":["any new finding"]}
- when the goal is fully met: {"action":"done","summary":"<the final answer / outcome>"}${codeNote}${workflowNote}${needsNote}
- if the task requires per-item dispositions, carry them ON the done directive itself — {"action":"done","summary":"...","dispositions":[{"threadRef":"...","disposition":"fixed|declined","note":"..."}]} — never in the prose.
Set "satisfied" true only when the goal is genuinely complete. Pick next_speaker from the members above. Keep the instruction to ONE concrete step.`;
}

// --- the loop ------------------------------------------------------------------

export interface RunCoordinatorOptions {
  runAgentTurn: NonNullable<RibContext["runAgentTurn"]>;
  membersRoot: string;
  dataHome: string;
  roster: Member[];
  task: string;
  scopeId?: string;
  // Optional manager pin for the coordinator/planner turn. Mirrors member pin semantics:
  // provider may stand alone; model is sent only when provider is also set.
  managerModel?: string;
  managerProvider?: string;
  // The project the run targets. Required for the code arm (it confines the coding
  // turn to project.rootPath); absent means dispatch-only.
  project?: { id: string; name: string; rootPath: string };
  limits?: Partial<OrchestratorLimits>;
  perTurnTimeoutMs?: number;
  abortSignal?: AbortSignal;
  // Injected for testability; default binds dispatchFanout to the live seams. The optional
  // third arg lets the deterministic review gate force diff capture (isReview) without the
  // ad-hoc dispatch path needing it — an injected 2-arg fake still satisfies this type.
  dispatch?: (
    members: Member[],
    instruction: string,
    opts?: { isReview?: boolean },
  ) => Promise<DispatchOutcome>;
  // Injected for testability; default binds runCodeTurn when a project is present.
  code?: (member: Member, instruction: string) => Promise<CodeStepOutcome>;
  // Injected for testability; default binds authorWorkflow (no project needed).
  workflow?: (member: Member, instruction: string) => Promise<WorkflowStepOutcome>;
  // The host seam that runs an authored workflow DAG. When present (and a project is
  // bound + the safety screen passes), the workflow arm author-AND-runs; absent leaves
  // it author-only. Optional so an older harness / a test rig degrades cleanly.
  runWorkflow?: RibContext["runWorkflow"];
  // The governed-memory seam (RibContext.getMemory). When present AND a project is bound,
  // the coordinator recalls prior decisions/lessons INTO the run's grounding and writes
  // the outcome BACK as a governed decision on completion (#15 capstone). Optional and
  // fail-soft — absent (or no project) degrades to no memory, the pre-capstone behavior.
  getMemory?: () => MemoryTools;
  // The process-exec seam (RibContext.getExec) + operator-configured verify commands. When both
  // are present AND a project is bound AND code was edited this run, the done-gate runs the
  // commands against project.rootPath and a red exit VETOES `done` — done becomes machine-proven,
  // not self-asserted. Empty/absent degrades to today's prose-trusting behavior (fail open).
  getExec?: RibExec;
  verify?: readonly string[];
  // Injected for testability; default binds distillOutcome to runAgentTurn (closing over the
  // run's task + recalled memory). One reflection turn at loop-close distills the run into a
  // durable governed decision, or abstains when nothing generalizable came of it.
  distill?: (input: { summary: string; facts: readonly string[] }) => Promise<DistillResult>;
  // Injected for testability; default binds reflectMembersAtClose to the live seams. Each
  // member that did substantive work in a completed run curates its own memory.md ONCE.
  reflectAtClose?: (contributions: readonly MemberContribution[]) => Promise<readonly string[]>;
  // Injected clock for deterministic tests; defaults to wall-clock.
  now?: () => string;
  // Best-effort progress publisher invoked after each ledger persist so the host can push a
  // fresh Run-loop board per round. Undefined leaves persistence byte-for-byte as today.
  publish?: () => void | Promise<void>;
  takeoverNote?: string;
}

export interface RunCoordinatorResult {
  ledger: CoordinatorLedger;
  rounds: number;
  status: RunCoordinatorStatus;
  summary: string;
  // Served-provider provenance compiled from the run's code/dispatch steps, e.g.
  // "atlas (claude) coded · vera (copilot) contributed". Absent when no step resolved a provider.
  provenance?: string;
}

const DEFAULT_COORDINATOR_TIMEOUT_MS = 180_000;

function cap(text: string, n: number): string {
  return text.length > n ? `${text.slice(0, n)}…` : text;
}

// The I'll/Here's/Let's contractions require an apostrophe (straight or smart)
// so the real words "ill"/"heres"/"lets" — e.g. "Ill-defined behavior …" — are
// never mistaken for narration.
const CODE_FINDING_NARRATION_RE =
  /^(?:on it|i['’]ll\b|i will\b|let me\b|sure\b|okay\b|ok\b|got it\b|first,?\b|now,?\b|next,?\b|alright\b|here['’]s the plan|let['’]s\b)/i;
const SHORT_ACKNOWLEDGMENT_RE =
  /^(?:on it|sure|okay|ok|got it|alright|will do|sounds good)[.!—-]*$/i;

function touchedFinding(touched?: {
  files: number;
  insertions: number;
  deletions: number;
}): string {
  if (!touched) return "(no reported outcome)";
  return `touched ${touched.files} file${touched.files === 1 ? "" : "s"} (+${touched.insertions} −${touched.deletions})`;
}

function isCodeNarration(paragraph: string): boolean {
  return CODE_FINDING_NARRATION_RE.test(paragraph) || SHORT_ACKNOWLEDGMENT_RE.test(paragraph);
}

export function deriveCodeFinding(
  text: string,
  touched?: { files: number; insertions: number; deletions: number },
): string {
  const trimmed = text.trim();
  if (!trimmed || trimmed === "(no output)") return touchedFinding(touched);

  const paragraphs = trimmed
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);

  let firstSubstantive = 0;
  while (
    firstSubstantive < paragraphs.length &&
    isCodeNarration(paragraphs[firstSubstantive] ?? "")
  ) {
    firstSubstantive += 1;
  }

  // Findings summarize the outcome, not the opening greeting.
  return paragraphs.slice(firstSubstantive).at(-1) ?? touchedFinding(touched);
}

// Tail of a command's output — failures surface at the end, so keep the last N chars.
function tailCap(text: string, n: number): string {
  const t = text.trimEnd();
  return t.length > n ? `…${t.slice(-n)}` : t;
}

function parseNum(value: string): number {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : 0;
}

function parseNumstat(text: string): DiffNumstatEntry[] {
  const files: DiffNumstatEntry[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const [addedRaw, removedRaw, ...pathParts] = line.split("\t");
    if (!addedRaw || !removedRaw || pathParts.length === 0) continue;
    files.push({
      path: pathParts.join("\t"),
      added: parseNum(addedRaw),
      removed: parseNum(removedRaw),
    });
  }
  return files;
}

function parseNameStatus(text: string): DiffNameStatusEntry[] {
  const files: DiffNameStatusEntry[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const [statusRaw, fromPath, toPath] = line.split("\t");
    const status = statusRaw?.[0];
    if (!status) continue;
    if (status === "R") {
      if (!fromPath || !toPath) continue;
      files.push({ status, previousPath: fromPath, path: toPath });
      continue;
    }
    if (!fromPath) continue;
    files.push({ status, path: fromPath });
  }
  return files;
}

function countOccurrences(line: string, token: "test" | "it" | "expect"): number {
  const re = new RegExp(`\\b${token}\\s*\\(`, "g");
  let total = 0;
  for (const _ of line.matchAll(re)) total += 1;
  return total;
}

function parsePatchSignals(text: string): { addedLines: string[]; tokenNet: DiffTokenNetCounts } {
  const addedLines: string[] = [];
  const tokenNet: DiffTokenNetCounts = { testCall: 0, itCall: 0, expectCall: 0 };
  for (const rawLine of text.split("\n")) {
    if (!rawLine) continue;
    if (rawLine.startsWith("+++ ") || rawLine.startsWith("--- ")) continue;
    if (rawLine.startsWith("+")) {
      const line = rawLine.slice(1);
      addedLines.push(line);
      tokenNet.testCall += countOccurrences(line, "test");
      tokenNet.itCall += countOccurrences(line, "it");
      tokenNet.expectCall += countOccurrences(line, "expect");
      continue;
    }
    if (rawLine.startsWith("-")) {
      const line = rawLine.slice(1);
      tokenNet.testCall -= countOccurrences(line, "test");
      tokenNet.itCall -= countOccurrences(line, "it");
      tokenNet.expectCall -= countOccurrences(line, "expect");
    }
  }
  return { addedLines, tokenNet };
}

function parseDiffStatTotals(text: string): { insertions: number; deletions: number } {
  const insertionMatch = /(\d+)\s+insertion(?:s)?\(\+\)/.exec(text);
  const deletionMatch = /(\d+)\s+deletion(?:s)?\(-\)/.exec(text);
  return {
    insertions: insertionMatch ? parseNum(insertionMatch[1] ?? "0") : 0,
    deletions: deletionMatch ? parseNum(deletionMatch[1] ?? "0") : 0,
  };
}

async function captureWorkingTreeTree(
  exec: RibExec,
  cwd: string,
): Promise<{ ok: true; tree: string } | { ok: false; error: string }> {
  const scratchDir = await mkdtemp(join(tmpdir(), "squad-run-delta-"));
  const indexPath = join(scratchDir, "index");
  const env = { GIT_INDEX_FILE: indexPath };
  try {
    const staged = await exec.runText("git", ["add", "-A", "--", "."], {
      cwd,
      timeoutMs: VERIFY_TIMEOUT_MS,
      env,
    });
    if (!staged.ok) return { ok: false, error: staged.error };
    const tree = await exec.runText("git", ["write-tree"], {
      cwd,
      timeoutMs: VERIFY_TIMEOUT_MS,
      env,
    });
    if (!tree.ok) return { ok: false, error: tree.error };
    const oid = tree.data.trim();
    if (!oid) return { ok: false, error: "git write-tree returned an empty tree id" };
    return { ok: true, tree: oid };
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}

async function collectTouchedBetween(
  exec: RibExec,
  cwd: string,
  treeBefore: string,
  treeAfter: string,
): Promise<{ files: number; insertions: number; deletions: number } | undefined> {
  const numstat = await exec.runText(
    "git",
    ["diff", "--numstat", "--find-renames", treeBefore, treeAfter],
    { cwd, timeoutMs: VERIFY_TIMEOUT_MS },
  );
  if (!numstat.ok) return undefined;
  const files = parseNumstat(numstat.data);
  return {
    files: files.length,
    insertions: files.reduce((sum, file) => sum + file.added, 0),
    deletions: files.reduce((sum, file) => sum + file.removed, 0),
  };
}

async function collectTouchedSummary(
  exec: RibExec,
  cwd: string,
): Promise<{ files: number; insertions: number; deletions: number } | undefined> {
  const status = await exec.runText("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd,
    timeoutMs: VERIFY_TIMEOUT_MS,
  });
  if (!status.ok) return undefined;
  const files = status.data
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0).length;
  const [unstaged, staged] = await Promise.all([
    exec.runText("git", ["diff", "--stat", "--", "."], { cwd, timeoutMs: VERIFY_TIMEOUT_MS }),
    exec.runText("git", ["diff", "--stat", "--cached", "--", "."], {
      cwd,
      timeoutMs: VERIFY_TIMEOUT_MS,
    }),
  ]);
  const un = unstaged.ok ? parseDiffStatTotals(unstaged.data) : { insertions: 0, deletions: 0 };
  const st = staged.ok ? parseDiffStatTotals(staged.data) : { insertions: 0, deletions: 0 };
  return {
    files,
    insertions: un.insertions + st.insertions,
    deletions: un.deletions + st.deletions,
  };
}

async function collectRunDiffSignals(
  exec: RibExec,
  cwd: string,
  baselineTree: string,
): Promise<
  | { ok: true; diffNumstat: ChangeQualityDiffNumstat; addedLines: string[] }
  | { ok: false; error: string }
> {
  const current = await captureWorkingTreeTree(exec, cwd);
  if (!current.ok) return current;
  const [numstat, patch, nameStatus] = await Promise.all([
    exec.runText("git", ["diff", "--numstat", "--find-renames", baselineTree, current.tree], {
      cwd,
      timeoutMs: VERIFY_TIMEOUT_MS,
    }),
    exec.runText(
      "git",
      ["diff", "--unified=0", "--no-color", "--find-renames", baselineTree, current.tree],
      {
        cwd,
        timeoutMs: VERIFY_TIMEOUT_MS,
      },
    ),
    exec.runText("git", ["diff", "--name-status", "--find-renames", baselineTree, current.tree], {
      cwd,
      timeoutMs: VERIFY_TIMEOUT_MS,
    }),
  ]);
  if (!numstat.ok) return { ok: false, error: numstat.error };
  if (!patch.ok) return { ok: false, error: patch.error };
  if (!nameStatus.ok) return { ok: false, error: nameStatus.error };
  const files = parseNumstat(numstat.data);
  const fileStatus = parseNameStatus(nameStatus.data);
  const { addedLines, tokenNet } = parsePatchSignals(patch.data);
  return { ok: true, diffNumstat: { files, tokenNet, nameStatus: fileStatus }, addedLines };
}

function splitNulPaths(out: string): string[] {
  return out.split("\0").filter((p) => p.length > 0);
}

// Incomplete-commit inspection (issue #97). Once a run has created a commit, the artifact that
// ships is that commit — not the working tree. A run edit left uncommitted (unstaged, staged but
// not committed, or an untracked new file) still passes the working-tree verify gate yet won't
// ship, so CI builds a different tree than the gate blessed: local green, CI red.
//
// The check is a single intersection over two full-tree diffs. Both the baseline and the current
// tree are `git add -A` scratch-index trees (see captureWorkingTreeTree), so staged, unstaged, and
// untracked content all compare uniformly through ONE mechanism — no per-git-state special-casing.
//   runDelta      = paths the run changed        (baselineTree .. current working tree)
//   uncommitted   = paths not in the commit yet  (HEAD .. current working tree)
//   incomplete    = runDelta ∩ uncommitted       (a run edit that will not ship)
// Scoping to runDelta means pre-existing dirt the run never touched is ignored (it is in neither
// set), so the gate does not punish an operator's inherited working-tree state. Read-only: the
// scratch index lives in a temp dir; the operator's working tree is never mutated.
export async function collectIncompleteCommitPaths(
  exec: RibExec,
  cwd: string,
  baselineTree: string,
  baselineHeadSha: string,
): Promise<{ ok: true; committed: boolean; paths: string[] } | { ok: false; error: string }> {
  const head = await exec.runText("git", ["rev-parse", "HEAD"], {
    cwd,
    timeoutMs: VERIFY_TIMEOUT_MS,
  });
  if (!head.ok) return { ok: false, error: head.error };
  // No commit this run: the working tree IS the deliverable, so commit-completeness does not apply
  // (the plain working-tree verify already covered it). Leave that path's behavior unchanged.
  if (head.data.trim() === baselineHeadSha) return { ok: true, committed: false, paths: [] };
  const current = await captureWorkingTreeTree(exec, cwd);
  if (!current.ok) return { ok: false, error: current.error };
  const [runDelta, uncommitted] = await Promise.all([
    exec.runText(
      "git",
      ["diff", "--name-only", "-z", "--find-renames", baselineTree, current.tree],
      {
        cwd,
        timeoutMs: VERIFY_TIMEOUT_MS,
      },
    ),
    exec.runText("git", ["diff", "--name-only", "-z", "--find-renames", "HEAD", current.tree], {
      cwd,
      timeoutMs: VERIFY_TIMEOUT_MS,
    }),
  ]);
  if (!runDelta.ok) return { ok: false, error: runDelta.error };
  if (!uncommitted.ok) return { ok: false, error: uncommitted.error };
  const runPaths = new Set(splitNulPaths(runDelta.data));
  const paths = [...new Set(splitNulPaths(uncommitted.data).filter((p) => runPaths.has(p)))].sort();
  return { ok: true, committed: true, paths };
}

// Run the operator-configured verify commands against the project root via the exec seam.
// Non-paid (processes, not LLM turns). Each command runs through `bash -c` so an operator string
// like "bun run check" or "bun --filter '*' test" works verbatim. acceptNonZeroExit makes a
// non-zero exit a returned result, not an error, so a failing suite is data, not a throw.
async function runVerification(
  exec: RibExec,
  commands: readonly string[],
  cwd: string,
  atRound: number,
): Promise<VerificationRecord> {
  const checks: VerificationCheck[] = [];
  for (const command of commands) {
    const res = await exec.runText("bash", ["-c", command], {
      cwd,
      acceptNonZeroExit: true,
      timeoutMs: VERIFY_TIMEOUT_MS,
    });
    const exitCode = res.ok ? (res.exitCode ?? 0) : (res.code ?? 1);
    const out = res.ok ? res.data : res.error;
    checks.push({
      command,
      passed: res.ok && exitCode === 0,
      exitCode,
      summary: tailCap(out, VERIFY_SUMMARY_CAP),
    });
  }
  const firstFailure = checks.find((check) => !check.passed);
  if (firstFailure) {
    return {
      command: firstFailure.command,
      exitCode: firstFailure.exitCode,
      passed: false,
      summary: firstFailure.summary,
      atRound,
      checks,
    };
  }
  const n = commands.length;
  const label = `${n} check${n === 1 ? "" : "s"}`;
  return {
    command: label,
    exitCode: 0,
    passed: true,
    summary: `${label} passed`,
    atRound,
    checks,
  };
}

function effectiveLastCodeRound(ledger: CoordinatorLedger): number | undefined {
  if (typeof ledger.lastCodeRound === "number") return ledger.lastCodeRound;
  const rounds = ledger.transcript.filter((e) => e.kind === "code").map((e) => e.round);
  return rounds.length > 0 ? Math.max(...rounds) : undefined;
}

function reviewMembers(roster: readonly Member[]): Member[] {
  const preferred = roster.filter((m) => (m.tools ?? []).includes("read"));
  return preferred.length > 0 ? preferred : [...roster];
}

function summarizeReview(outcome: DispatchOutcome): { summary: string; hadUsableOutput: boolean } {
  const synthesis = outcome.synthesis?.trim();
  if (synthesis) return { summary: synthesis, hadUsableOutput: true };
  const oks = outcome.perMember.filter((r) => r.status === "ok" && r.text.trim().length > 0);
  if (oks.length === 0) return { summary: "(no review output)", hadUsableOutput: false };
  const summary =
    oks.length === 1
      ? (oks[0]?.text.trim() ?? "(no review output)")
      : oks.map((r) => `[${r.name}] ${r.text.trim()}`).join("\n\n");
  return { summary, hadUsableOutput: true };
}

function reviewVerdictSpeaker(
  members: readonly Member[],
  results: readonly DispatchResult[],
  blocked: boolean,
): string | undefined {
  const bySlug = new Map(results.map((r) => [r.slug, r]));
  const matching = members
    .map((m) => bySlug.get(m.slug))
    .filter((r): r is DispatchResult => {
      if (!r || r.status !== "ok" || r.text.trim().length === 0) return false;
      return blocked ? hasBlockVerdict(r.text) : true;
    });
  return matching.length ? matching.map((r) => r.slug).join(", ") : undefined;
}

// The distinct provider ids among a wave's successful members, joined for one entry's
// provenance ("copilot" or "claude, copilot"); undefined when none resolved a provider.
function distinctProviders(oks: readonly DispatchResult[]): string | undefined {
  const ids = [...new Set(oks.map((r) => r.providerId).filter((p): p is string => Boolean(p)))];
  return ids.length ? ids.join(", ") : undefined;
}

// The executing arms that attribute a unit of work to a provider, and the verb the standup
// uses. Coordinator/replan/failed turns aren't work units, so they carry no provenance.
const PROVENANCE_VERB: Partial<Record<CoordinatorEntry["kind"], string>> = {
  code: "coded",
  dispatch: "contributed",
  verify: "reviewed",
};

export interface ProvenanceLine {
  who: string;
  provider: string;
  verb: string;
}

// Walk the transcript's execute entries into deduped (member, provider, verb) attributions —
// the served-provider provenance the standup and Run-loop board surface for a mixed team.
export function provenanceLines(transcript: readonly CoordinatorEntry[]): ProvenanceLine[] {
  const seen = new Set<string>();
  const out: ProvenanceLine[] = [];
  for (const e of transcript) {
    const verb = PROVENANCE_VERB[e.kind];
    if (!verb || !e.provider) continue;
    if (e.kind === "verify" && !e.verdict) continue;
    const who = e.speaker ?? "team";
    const key = `${who}|${e.provider}|${verb}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ who, provider: e.provider, verb });
  }
  return out;
}

function summarizeProvenance(transcript: readonly CoordinatorEntry[]): string | undefined {
  const lines = provenanceLines(transcript);
  return lines.length
    ? lines.map((l) => `${l.who} (${l.provider}) ${l.verb}`).join(" · ")
    : undefined;
}

// Prefix a dispatched member's instruction with the team's recalled memory so the agent
// executing the step shares the team's prior knowledge — the manager has it in context,
// but members can't see the manager's context, so it must ride the instruction.
function withTeamMemory(instruction: string, recalled: readonly string[]): string {
  if (recalled.length === 0) return instruction;
  return `Team memory — decisions and lessons the squad recorded on earlier passes for this project (honor and build on them; don't re-derive or contradict them):\n${recalled.map((r) => `- ${r}`).join("\n")}\n\nYour task:\n${instruction}`;
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

// The execute steps (dispatch/code/workflow) attempted since the last re-plan boundary —
// the in-flight work a rebuild is about to abandon. Pure, like decideOrchestratorStep, so
// the driver can sweep it into a durable "do not resume these" record before re-planning
// instead of trusting the manager to remember a prose hint. Newest-plan-first scan stops at
// the prior re-plan (those steps were already swept); returns "speaker: instruction"
// descriptors in chronological order.
export function failStuckTasks(transcript: readonly CoordinatorEntry[]): string[] {
  const swept: string[] = [];
  for (let i = transcript.length - 1; i >= 0; i--) {
    const e = transcript[i];
    if (!e) continue;
    if (e.kind === "replan") break;
    if (e.kind === "dispatch" || e.kind === "code" || e.kind === "workflow") {
      const desc = (e.instruction?.trim() || e.text.trim()).slice(0, STEP_DESC_CAP);
      swept.push(e.speaker ? `${e.speaker}: ${desc}` : desc);
    }
  }
  return swept.reverse();
}

// Accumulate new entries onto a prior record (deduped, capped, most-recent-kept) — the shape
// both the re-plan's swept steps and the run's team-gap recommendations want.
function dedupeCap(prev: readonly string[], added: readonly string[], max: number): string[] {
  const seen = new Set(prev);
  const merged = [...prev];
  for (const a of added) {
    if (!seen.has(a)) {
      seen.add(a);
      merged.push(a);
    }
  }
  return merged.slice(-max);
}

// Pair each member with everything it DID across the run (its dispatch/code outputs), so the
// loop-close reflection curates memory from real contribution. Workflow-authoring is excluded
// — minting a reusable DAG isn't the member learning a durable project fact about its own work.
function collectContributions(
  transcript: readonly CoordinatorEntry[],
  roster: readonly Member[],
): MemberContribution[] {
  const byMember = new Map<string, string[]>();
  for (const e of transcript) {
    if ((e.kind === "dispatch" || e.kind === "code") && e.speaker) {
      const prior = byMember.get(e.speaker) ?? [];
      prior.push(e.text);
      byMember.set(e.speaker, prior);
    }
  }
  return roster
    .filter((m) => byMember.has(m.slug))
    .map((m) => ({ member: m, contribution: (byMember.get(m.slug) ?? []).join("\n\n") }));
}

// The short verb the in-flight card shows for an execute step's mode; anything unrecognized
// reads as the neutral "working" rather than leaking a raw mode token.
export function actionLabel(step: OrchestratorStep): string {
  if (step.kind !== "execute") return "working";
  switch (step.mode) {
    case "code":
      return "coding";
    case "workflow":
      return "authoring a workflow";
    default:
      return "working";
  }
}

export async function runCoordinator(opts: RunCoordinatorOptions): Promise<RunCoordinatorResult> {
  const now = opts.now ?? (() => new Date().toISOString());
  const limits = overlayLimits(opts.limits);
  const timeoutMs = opts.perTurnTimeoutMs ?? DEFAULT_COORDINATOR_TIMEOUT_MS;
  const project = opts.project;
  const verify = opts.verify ?? [];
  const managerProvider = opts.managerProvider?.trim();
  const managerModel = opts.managerModel?.trim();
  const normalizedManagerProvider =
    managerProvider && managerProvider.length > 0 ? managerProvider : undefined;
  const normalizedManagerModel =
    normalizedManagerProvider && managerModel && managerModel.length > 0 ? managerModel : undefined;
  // Recall the team's prior governed decisions/lessons ONCE (project-scoped; [] without a
  // seam or project) so they ground BOTH the coordinator's planning AND each dispatched
  // member's turn. The recalled knowledge has to reach the agent doing the work, not just
  // the manager directing it — the manager delegates, and members can't see the manager's
  // context, so without this the recall never influences the actual output.
  const memory = opts.getMemory?.();
  const recalled = await recallGrounding(memory, project?.id, opts.task);

  // A single-member step needs no synthesis turn — fold that one reply directly (saves a
  // paid turn and the "only one response came back" narration). Each member turn is
  // prefixed with the team's recalled memory so execution benefits from it too.
  const dispatch =
    opts.dispatch ??
    ((members: Member[], instruction: string, dopts?: { isReview?: boolean }) =>
      dispatchFanout({
        runAgentTurn: opts.runAgentTurn,
        membersRoot: opts.membersRoot,
        members,
        task: withTeamMemory(instruction, recalled),
        synthesize: members.length > 1,
        // Pass the project so a dispatched member can READ the repo to ground its answer (a
        // reviewer that can't open the diff is the live gap this closes); absent → text-only.
        ...(project ? { project: { name: project.name, rootPath: project.rootPath } } : {}),
        ...(dopts?.isReview !== undefined ? { isReview: dopts.isReview } : {}),
        ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
      }));

  // The code arm: a confined coding turn for the speaker, bound only when a project is
  // present (it confines to project.rootPath). Absent → a code step falls to dispatch.
  const code =
    opts.code ??
    (project
      ? async (
          member: Member,
          instruction: string,
          onTool?: (tools: readonly ToolTrace[]) => void,
        ): Promise<CodeStepOutcome> => {
          const r = await runCodeTurn({
            runAgentTurn: opts.runAgentTurn,
            membersRoot: opts.membersRoot,
            member,
            project: { name: project.name, rootPath: project.rootPath },
            task: withTeamMemory(instruction, recalled),
            deferFullVerify: verify.length > 0,
            ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
            ...(onTool ? { onTool } : {}),
          });
          return r.ok
            ? {
                status: r.outcome.status,
                text: r.outcome.text,
                ...(r.outcome.error ? { error: r.outcome.error } : {}),
                ...(r.outcome.providerId ? { providerId: r.outcome.providerId } : {}),
                ...(r.outcome.tools ? { tools: r.outcome.tools } : {}),
                ...(r.outcome.usage ? { usage: r.outcome.usage } : {}),
                ...(r.outcome.durationMs !== undefined ? { durationMs: r.outcome.durationMs } : {}),
              }
            : { status: "error", text: "", error: r.error };
        }
      : undefined);

  // The workflow-authoring arm: always available (it needs no project — it writes an
  // artifact under the data home).
  const runWorkflowSeam = opts.runWorkflow;
  const workflow =
    opts.workflow ??
    (async (member: Member, instruction: string): Promise<WorkflowStepOutcome> => {
      const r = await authorWorkflow({
        runAgentTurn: opts.runAgentTurn,
        membersRoot: opts.membersRoot,
        dataHome: opts.dataHome,
        member,
        task: instruction,
        ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
      });
      if (!r.ok) return { status: "error", text: r.error };
      const base = { name: r.name, path: r.path, nodeCount: r.nodeCount };
      const authored = `authored workflow "${r.name}" (${r.nodeCount} node${r.nodeCount === 1 ? "" : "s"}) → ${r.path}`;
      // Run it ourselves only when confined to a project, the host seam is present, and
      // the safety screen passes; otherwise it stays a durable artifact for the operator.
      if (!project || !runWorkflowSeam) {
        const why = !project ? "no project bound" : "run seam unavailable";
        return { status: "ok", text: `${authored} (not run: ${why})`, ...base };
      }
      const screen = screenWorkflowForRun(r.def);
      if (!screen.ok) {
        return { status: "ok", text: `${authored} (not run: ${screen.reason})`, ...base };
      }
      const run = await runWorkflowSeam(r.def, {}, { cwd: project.rootPath });
      const failed = Object.entries(run.nodes)
        .filter(([, n]) => n.state === "failed")
        .map(([id]) => id);
      const detail = failed.length > 0 ? ` failed: ${failed.join(", ")}` : "";
      return {
        status: run.status === "succeeded" ? "ok" : "error",
        text: `${authored}; RAN → ${run.status}.${detail}${run.error ? ` ${run.error}` : ""}`,
        ...base,
      };
    });

  // Loop-close distillation: one reflection turn condenses the completed run into a durable
  // governed decision (or abstains). Default binds the live turn, closing over the run's task
  // and the memory recalled this pass so the distillation records a delta, not a restatement.
  const distill =
    opts.distill ??
    ((input: { summary: string; facts: readonly string[] }) =>
      distillOutcome(opts.runAgentTurn, {
        task: opts.task,
        summary: input.summary,
        facts: input.facts,
        recalled,
        ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
      }));

  // Loop-close per-member reflection: each participant curates its own memory once when the
  // run completes (issue #2's boundary cadence). Default binds the live seam; fail-soft.
  const reflectAtClose =
    opts.reflectAtClose ??
    ((contributions: readonly MemberContribution[]) =>
      reflectMembersAtClose({
        runAgentTurn: opts.runAgentTurn,
        membersRoot: opts.membersRoot,
        task: opts.task,
        contributions,
        ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
      }));

  const persist = async (next: CoordinatorLedger): Promise<void> => {
    await saveLedger(opts.dataHome, next);
    // Fire-and-forget: the live board refresh is best-effort and must never block or stall the
    // run loop (a try/catch can't rescue a hung refresh — only not awaiting it can).
    void (async () => {
      try {
        await opts.publish?.();
      } catch {
        // best-effort
      }
    })();
  };

  // Every transcript entry is stamped with the run's (injectable) clock at append.
  const append = (
    transcript: readonly CoordinatorEntry[],
    entry: CoordinatorEntry,
  ): CoordinatorEntry[] => appendEntry(transcript, entry.at ? entry : { ...entry, at: now() });

  let ledger = await loadOrInit(
    opts.dataHome,
    opts.task,
    opts.scopeId,
    project?.id,
    now(),
    limits.maxRounds,
    Boolean(opts.takeoverNote),
  );
  const exec = opts.getExec;
  if (opts.takeoverNote) {
    ledger = {
      ...ledger,
      transcript: append(ledger.transcript, {
        round: ledger.round,
        kind: "coordinator",
        text: opts.takeoverNote,
      }),
      updatedAt: now(),
    };
    await persist(ledger);
  }
  const runStartTree =
    project && exec
      ? await (async () => {
          if (ledger.baselineTree) return { ok: true as const, tree: ledger.baselineTree };
          const captured = await captureWorkingTreeTree(exec, project.rootPath);
          if (captured.ok) {
            // Co-capture HEAD at the SAME boundary as the baseline tree (one atomic ledger write),
            // so the incomplete-commit gate compares against the run's true start commit. A missing
            // HEAD (detached/empty repo) simply leaves baselineHeadSha unset — the gate skips.
            const head = await exec.runText("git", ["rev-parse", "HEAD"], {
              cwd: project.rootPath,
              timeoutMs: VERIFY_TIMEOUT_MS,
            });
            ledger = {
              ...ledger,
              baselineTree: captured.tree,
              ...(head.ok && head.data.trim() ? { baselineHeadSha: head.data.trim() } : {}),
              updatedAt: now(),
            };
            await persist(ledger);
          }
          return captured;
        })()
      : undefined;
  let replanRequested = false;
  let status: RunCoordinatorResult["status"] = RUN_STATUS_MAX_ROUNDS;

  while (true) {
    if (opts.abortSignal?.aborted) {
      status = RUN_STATUS_ABORTED;
      break;
    }
    if (ledger.round >= limits.maxRounds) {
      status = RUN_STATUS_MAX_ROUNDS;
      // A ceiling hit with code edited but never cleanly reviewed is the dangerous
      // false-negative: the loop may be hiding mergeable work behind an unsubstantiated
      // review BLOCK. Consult the deterministic floor once and name the state, so a
      // max-rounds terminal distinguishes "blocked by an unverified review" (green floor)
      // from "genuinely unfinished" (red floor) rather than failing silently.
      const ceilCodeRound = effectiveLastCodeRound(ledger);
      const unresolvedReview =
        ceilCodeRound !== undefined && ceilCodeRound > (ledger.lastCleanReviewRound ?? -1);
      let ceilingVerification: VerificationRecord | undefined;
      let ceilingSummary: string | undefined;
      if (
        unresolvedReview &&
        project &&
        opts.getExec &&
        verify.length > 0 &&
        !opts.abortSignal?.aborted
      ) {
        const v = await runVerification(opts.getExec, verify, project.rootPath, ledger.round);
        ceilingVerification = v;
        ceilingSummary = v.passed
          ? `Round ceiling reached with an unresolved review BLOCK, but the deterministic floor is GREEN (${v.command}) — the artifact passes on its own; the blocker is an unsubstantiated or unverified review, not a broken build. Human review recommended.`
          : `Round ceiling reached with an unresolved review BLOCK and a RED deterministic check (${v.command}, exit ${v.exitCode}) — the artifact does not pass on its own.`;
      }
      // Persist a TERMINAL status so a same-task re-run starts fresh instead of
      // resuming this ceiling-hit ledger and short-circuiting straight back here.
      ledger = {
        ...ledger,
        status: RUN_STATUS_MAX_ROUNDS,
        inFlight: undefined,
        ...(ceilingVerification ? { verification: ceilingVerification } : {}),
        ...(ceilingSummary ? { summary: ceilingSummary } : {}),
        updatedAt: now(),
      };
      await persist(ledger);
      break;
    }

    const turn = await runConfinedTurn(
      opts.runAgentTurn,
      {
        system: COORDINATOR_SYSTEM,
        prompt: coordinatorPrompt(
          ledger,
          opts.roster,
          replanRequested,
          Boolean(code),
          recalled,
          opts.project,
        ),
        ...(normalizedManagerProvider ? { provider: normalizedManagerProvider } : {}),
        ...(normalizedManagerModel ? { model: normalizedManagerModel } : {}),
      },
      timeoutMs,
      opts.abortSignal,
    );
    replanRequested = false;
    if (turn.status !== "ok") {
      status = turn.status === "aborted" ? RUN_STATUS_ABORTED : "error";
      ledger = { ...ledger, updatedAt: now() };
      break;
    }

    const directive = parseCoordinatorDirective(turn.text) ?? fallbackDirective();
    ledger = {
      ...ledger,
      facts: foldFacts(ledger.facts, directive.facts),
      ...(directive.plan.length ? { plan: directive.plan } : {}),
      // Accumulate the run's roster-gap recommendations (deduped, capped). The squad notices
      // when it lacks a specialist and surfaces it; casting stays the operator's call.
      ...(directive.needs.length
        ? { teamGaps: dedupeCap(ledger.teamGaps ?? [], directive.needs, MAX_GAPS) }
        : {}),
      ...(directive.summary ? { summary: directive.summary } : {}),
      transcript: append(ledger.transcript, {
        round: ledger.round,
        kind: "coordinator",
        text: directive.head || "(no reasoning)",
        ...(turn.usage ? { usage: turn.usage } : {}),
        ...(turn.durationMs !== undefined ? { durationMs: turn.durationMs } : {}),
      }),
      updatedAt: now(),
    };

    const decided = decideOrchestratorStep({
      progress: directive.progress,
      state: { round: ledger.round, stallCount: ledger.stallCount, resetCount: ledger.resetCount },
      roster: opts.roster,
      limits,
      repeatedOutcome: (ledger.outcomeRepeat?.count ?? 0) >= REPEAT_STALL_AT,
    });
    ledger = {
      ...ledger,
      stallCount: decided.state.stallCount,
      resetCount: decided.state.resetCount,
    };

    if (decided.step.kind === "end") {
      const givingUp = decided.step.reason.includes("gave up");
      // Verification gate: a senior never accepts "done" on a code change without a green check.
      // Fires only when the manager wants done (not give-up), the exec seam + verify commands are
      // present, a project is bound, AND code was actually edited this run. A red exit VETOES done
      // — the real failure is handed back to the manager (or, past the retry bound, terminates the
      // run verification-failed) so squad never narrates a broken build as finished.
      if (
        !givingUp &&
        project &&
        !opts.abortSignal?.aborted &&
        (() => {
          const codeRound = effectiveLastCodeRound(ledger);
          if (codeRound === undefined) return false;
          return codeRound > (ledger.lastCleanReviewRound ?? -1);
        })()
      ) {
        const reviewers = reviewMembers(opts.roster);
        if (reviewers.length === 0) {
          const text =
            "RAI VERDICT: BLOCK — no member is available to run a project-bound adversarial diff review";
          ledger = {
            ...ledger,
            facts: foldFacts(ledger.facts, [cap(text, FACT_CAP)]),
            transcript: append(ledger.transcript, {
              round: ledger.round,
              kind: "verify",
              text,
            }),
            round: ledger.round + 1,
            updatedAt: now(),
          };
          await persist(ledger);
          continue;
        }
        const review = await dispatch(
          reviewers,
          "Adversarial review the current project diff and try to refute it. Cite exact file:line evidence. Only emit the sentinel RAI VERDICT: BLOCK when you can name a SPECIFIC, reproducible defect — a concrete failing input or a wrong line and why it is wrong — not a hunch and not an inability to verify. Apply two lenses beyond correctness, each still requiring a concrete citation: (1) CONSISTENCY — for any value the diff introduces into a shared or persisted structure (a field on a shared object, a stored record, a returned or serialized result), locate the OTHER code that produces that same field or structure and confirm the new value matches the shape, type, and convention that code already uses (for example an identifier vs a display label, raising an error vs a silent fallback, required vs optional, matching units); a divergence from a convention the surrounding code already follows is a defect when you cite both the diverging line and the code it is inconsistent with. (2) TEST ADEQUACY — a test guarding new behavior that cannot actually discriminate that behavior (for example one whose setup makes two different outcomes look identical, so it would pass even if the code were wrong) is a defect; cite the test and the case it fails to distinguish. If your refutation attempts all pass and you cannot identify or substantiate a concrete blocking defect, emit RAI VERDICT: PASS and record any residual concerns as caveats rather than blocking. If no blocker remains, clearly say RAI VERDICT: PASS.",
          // The gate is a review by construction — capture the diff regardless of how this
          // instruction reads, instead of relying on the text containing a review keyword.
          { isReview: true },
        );
        const reviewProvider = distinctProviders(
          review.perMember.filter((r) => r.status === "ok" && r.text.trim().length > 0),
        );
        const { summary, hadUsableOutput } = summarizeReview(review);
        const blocked = hasBlockVerdict(summary);
        const reviewSpeaker = reviewVerdictSpeaker(reviewers, review.perMember, blocked);
        ledger = {
          ...ledger,
          transcript: append(ledger.transcript, {
            round: ledger.round,
            kind: "verify",
            text: blocked
              ? `RAI VERDICT: BLOCK\n${summary}`
              : `review passed (no BLOCK verdict)\n${summary}`,
            ...(reviewSpeaker ? { speaker: reviewSpeaker } : {}),
            ...(reviewProvider ? { provider: reviewProvider } : {}),
            verdict: blocked ? "block" : "pass",
            ...(review.usage ? { usage: review.usage } : {}),
          }),
          ...(blocked || !hadUsableOutput
            ? { facts: foldFacts(ledger.facts, [cap(`RAI VERDICT: BLOCK\n${summary}`, FACT_CAP)]) }
            : { lastCleanReviewRound: ledger.round }),
          updatedAt: now(),
        };
        if (blocked || !hadUsableOutput) {
          ledger = { ...ledger, round: ledger.round + 1, updatedAt: now() };
          await persist(ledger);
          continue;
        }
      }
      if (
        !givingUp &&
        opts.getExec &&
        verify.length > 0 &&
        project &&
        effectiveLastCodeRound(ledger) !== undefined &&
        !opts.abortSignal?.aborted
      ) {
        const v = await runVerification(opts.getExec, verify, project.rootPath, ledger.round);
        ledger = {
          ...ledger,
          verification: v,
          transcript: append(ledger.transcript, {
            round: ledger.round,
            kind: "verify",
            text: v.passed
              ? `verification passed: ${v.command}`
              : `verification FAILED: ${v.command} (exit ${v.exitCode})\n${v.summary}`,
          }),
          updatedAt: now(),
        };
        if (!v.passed) {
          const failures = (ledger.verifyFailures ?? 0) + 1;
          // Keep the failure's TAIL (where the actual error is) within FACT_CAP — `cap` would
          // truncate from the start and drop the most informative final lines.
          const failLabel = `[verification FAILED: ${v.command} exit ${v.exitCode}] `;
          ledger = {
            ...ledger,
            verifyFailures: failures,
            facts: foldFacts(ledger.facts, [
              failLabel + tailCap(v.summary, Math.max(0, FACT_CAP - failLabel.length)),
            ]),
            updatedAt: now(),
          };
          if (failures >= MAX_VERIFY_FAILURES) {
            status = RUN_STATUS_VERIFICATION_FAILED;
            ledger = {
              ...ledger,
              status: RUN_STATUS_VERIFICATION_FAILED,
              summary: `verification failed after ${failures} attempts: ${v.command} (exit ${v.exitCode})`,
              inFlight: undefined,
              updatedAt: now(),
            };
            await persist(ledger);
            break;
          }
          // Veto the manager's done: advance the round and hand the failure back so the next
          // manager turn must fix the red build rather than re-declare done on it.
          ledger = { ...ledger, round: ledger.round + 1, updatedAt: now() };
          await persist(ledger);
          continue;
        }
        // Green: clear the failure counter, then fall through to accept done.
        ledger = { ...ledger, verifyFailures: 0, updatedAt: now() };
      } else if (
        !givingUp &&
        verify.length > 0 &&
        !opts.getExec &&
        project &&
        ledger.transcript.some((e) => e.kind === "code")
      ) {
        // Verification was requested but the exec seam is unavailable (an older harness): surface
        // the ungated done rather than silently accepting it, so the operator isn't misled.
        ledger = {
          ...ledger,
          transcript: append(ledger.transcript, {
            round: ledger.round,
            kind: "verify",
            text: "verification skipped: exec seam unavailable on this harness (done not gated)",
          }),
          updatedAt: now(),
        };
      }
      // Incomplete-commit gate (issue #97): once the run has created a commit, refuse `done` if any
      // path the run touched is still uncommitted — it passed the working-tree verify above but will
      // not ship. Non-destructive (read-only git) and fail-closed: if the inspection cannot complete
      // on a run that advanced HEAD, veto rather than assume the commit is complete. Bounded by its
      // own counter so it cannot loop forever.
      if (
        !givingUp &&
        opts.getExec &&
        project &&
        ledger.baselineHeadSha &&
        runStartTree?.ok &&
        effectiveLastCodeRound(ledger) !== undefined &&
        !opts.abortSignal?.aborted
      ) {
        const incomplete = await collectIncompleteCommitPaths(
          opts.getExec,
          project.rootPath,
          runStartTree.tree,
          ledger.baselineHeadSha,
        );
        if (!incomplete.ok || (incomplete.committed && incomplete.paths.length > 0)) {
          const failures = (ledger.incompleteCommitFailures ?? 0) + 1;
          const text = incomplete.ok
            ? `incomplete commit: these run edits are uncommitted and will not ship — commit or discard them before done:\n${incomplete.paths.map((p) => `- ${p}`).join("\n")}`
            : `incomplete-commit check could not be completed — failing closed: ${incomplete.error}`;
          ledger = {
            ...ledger,
            incompleteCommitFailures: failures,
            facts: foldFacts(ledger.facts, [cap(text, FACT_CAP)]),
            transcript: append(ledger.transcript, {
              round: ledger.round,
              kind: "verify",
              text,
            }),
            updatedAt: now(),
          };
          if (failures >= MAX_VERIFY_FAILURES) {
            status = RUN_STATUS_VERIFICATION_FAILED;
            ledger = {
              ...ledger,
              status: RUN_STATUS_VERIFICATION_FAILED,
              summary: incomplete.ok
                ? `verification failed after ${failures} attempts: incomplete commit (${incomplete.paths.length} uncommitted run edit(s))`
                : `verification failed after ${failures} attempts: incomplete-commit check error (${incomplete.error})`,
              inFlight: undefined,
              updatedAt: now(),
            };
            await persist(ledger);
            break;
          }
          ledger = { ...ledger, round: ledger.round + 1, updatedAt: now() };
          await persist(ledger);
          continue;
        }
        ledger = { ...ledger, incompleteCommitFailures: 0, updatedAt: now() };
      }
      if (
        !givingUp &&
        opts.getExec &&
        project &&
        effectiveLastCodeRound(ledger) !== undefined &&
        !opts.abortSignal?.aborted
      ) {
        const quality = runStartTree?.ok
          ? await collectRunDiffSignals(opts.getExec, project.rootPath, runStartTree.tree)
          : {
              ok: false as const,
              error: runStartTree?.error ?? "run-start baseline tree unavailable",
            };
        const violations = quality.ok
          ? detectChangeQualityViolations(quality.diffNumstat, quality.addedLines)
          : [
              {
                code: "change-quality-check-error",
                message: `unable to inspect run diff: ${quality.error}`,
              },
            ];
        if (violations.length > 0) {
          const failures = (ledger.changeQualityFailures ?? 0) + 1;
          const summary = violations.map((v) => `[${v.code}] ${v.message}`).join("; ");
          const text = `change-quality FAILED: ${summary}`;
          ledger = {
            ...ledger,
            changeQualityFailures: failures,
            facts: foldFacts(ledger.facts, [cap(text, FACT_CAP)]),
            transcript: append(ledger.transcript, {
              round: ledger.round,
              kind: "verify",
              text,
            }),
            updatedAt: now(),
          };
          if (failures >= MAX_CHANGE_QUALITY_FAILURES) {
            status = RUN_STATUS_CHANGE_QUALITY_FAILED;
            ledger = {
              ...ledger,
              status: RUN_STATUS_CHANGE_QUALITY_FAILED,
              summary: `change-quality failed after ${failures} attempts: ${summary}`,
              inFlight: undefined,
              updatedAt: now(),
            };
            await persist(ledger);
            break;
          }
          ledger = { ...ledger, round: ledger.round + 1, updatedAt: now() };
          await persist(ledger);
          continue;
        }
        ledger = { ...ledger, changeQualityFailures: 0, updatedAt: now() };
      }
      status = givingUp ? RUN_STATUS_GAVE_UP : RUN_STATUS_DONE;
      ledger = {
        ...ledger,
        status: givingUp ? RUN_STATUS_GAVE_UP : RUN_STATUS_DONE,
        ...(ledger.summary ? {} : { summary: directive.summary ?? decided.step.reason }),
        ...(!givingUp && directive.dispositions ? { dispositions: directive.dispositions } : {}),
        inFlight: undefined,
        updatedAt: now(),
      };
      // Grow memory at loop close, on a genuine completion only (not give-up). The SHARED governed
      // decision is distilled and written first, THEN each participant's PRIVATE memory.md — kept
      // sequential so the member half's abort check (after the distill turn) still suppresses it
      // when an abort lands mid-distill. Both halves are fail-soft and skipped on abort.
      if (status === RUN_STATUS_DONE) {
        const summary = ledger.summary ?? "";
        let memoryNote: string | undefined;
        // Distill the run into ONE durable governed decision, or abstain (a confused run must not
        // pollute the ledger it grounds the next pass on). try/catch keeps a throwing injected
        // distill seam from crashing loop close and treats the throw like an `unavailable` verdict
        // — a raw fallback so a completed run still records something.
        if (memory && project?.id && !opts.abortSignal?.aborted) {
          try {
            const distilled = await distill({ summary, facts: ledger.facts });
            // Re-check abort after the paid turn — don't mutate memory during teardown.
            if (!opts.abortSignal?.aborted) {
              if (distilled.kind === "lesson") {
                memoryNote = (await reflectDistilled(memory, project.id, distilled))
                  ? "[memory] recorded a distilled decision"
                  : "[memory] distilled decision not recorded (deduped or blocked)";
              } else if (distilled.kind === "abstain") {
                memoryNote = "[memory] run yielded no durable decision (memory unchanged)";
              } else {
                memoryNote = (await reflectOutcome(
                  memory,
                  project.id,
                  opts.task,
                  summary,
                  ledger.facts,
                ))
                  ? "[memory] recorded the outcome as a governed decision"
                  : "[memory] outcome not recorded (deduped or blocked)";
              }
            }
          } catch {
            if (!opts.abortSignal?.aborted) {
              memoryNote = (await reflectOutcome(
                memory,
                project.id,
                opts.task,
                summary,
                ledger.facts,
              ))
                ? "[memory] recorded the outcome as a governed decision"
                : "[memory] outcome not recorded (deduped or blocked)";
            }
          }
        }
        if (memoryNote) {
          ledger = {
            ...ledger,
            transcript: append(ledger.transcript, {
              round: ledger.round,
              kind: "coordinator",
              text: memoryNote,
            }),
            updatedAt: now(),
          };
        }
        // Each member that did substantive work grows its OWN memory.md once over its whole
        // contribution — the per-agent half of the grow-memory arc; fail-soft, skipped on abort.
        const contributions = collectContributions(ledger.transcript, opts.roster);
        if (contributions.length > 0 && !opts.abortSignal?.aborted) {
          try {
            const reflected = await reflectAtClose(contributions);
            if (reflected.length > 0) {
              ledger = {
                ...ledger,
                transcript: append(ledger.transcript, {
                  round: ledger.round,
                  kind: "coordinator",
                  text: `[memory] ${reflected.length} member${reflected.length === 1 ? "" : "s"} reflected on the run`,
                }),
                updatedAt: now(),
              };
            }
          } catch {
            // fail-soft: a rejecting reflection seam must not crash a completed run
          }
        }
      }
      await persist(ledger);
      break;
    }

    if (decided.step.kind === "replan") {
      replanRequested = true;
      // On a re-plan, REBUILD the Task Ledger: sweep the abandoned plan's attempted steps
      // into a durable "do not resume" record (observable in the transcript, not just a prose
      // hint), then clear the stale plan below so the manager rebuilds from scratch instead of
      // re-anchoring on the plan it was told to abandon. Verified facts survive the rebuild —
      // only the plan is torn down (Magentic keeps confirmed findings across a re-plan).
      const swept = failStuckTasks(ledger.transcript);
      const failedSteps = swept.length
        ? dedupeCap(ledger.failedSteps ?? [], swept, MAX_FAILED)
        : ledger.failedSteps;
      let transcript = ledger.transcript;
      if (swept.length) {
        transcript = append(transcript, {
          round: ledger.round,
          kind: "failed",
          text: `swept ${swept.length} stalled step${swept.length === 1 ? "" : "s"} to failed before rebuild`,
        });
      }
      transcript = append(transcript, {
        round: ledger.round,
        kind: "replan",
        text: decided.step.reason,
      });
      ledger = {
        ...ledger,
        round: ledger.round + 1,
        plan: [],
        ...(failedSteps?.length ? { failedSteps } : {}),
        transcript,
        inFlight: undefined,
        updatedAt: now(),
      };
      await persist(ledger);
      continue;
    }

    // execute: the dispatch, code, or workflow-authoring arm. Mark the turn in flight and persist
    // BEFORE running it so a streamed board shows the work being assigned the instant it starts.
    ledger = {
      ...ledger,
      inFlight: {
        round: ledger.round,
        ...(decided.step.speaker ? { speaker: decided.step.speaker } : {}),
        action: actionLabel(decided.step),
        ...(decided.step.instruction ? { instruction: decided.step.instruction } : {}),
        startedAt: now(),
      },
      updatedAt: now(),
    };
    await persist(ledger);
    // Live tool-trace relay (#113): the code arm streams tool_use folds here; each
    // (throttled) update re-persists the ledger with the growing in-flight trace so
    // the bound board's refresh shows the work as it happens. Writes chain serially
    // and the chain is drained after executeStep, so a slow live write can never land
    // after the loop's own post-step persist and resurrect stale in-flight state.
    const inFlightBase = ledger;
    let lastTracePersist = 0;
    let livePersists: Promise<void> = Promise.resolve();
    const onTool = (tools: readonly ToolTrace[]): void => {
      const nowMs = Date.now();
      if (nowMs - lastTracePersist < LIVE_TRACE_THROTTLE_MS) return;
      lastTracePersist = nowMs;
      if (!inFlightBase.inFlight) return;
      const live: CoordinatorLedger = {
        ...inFlightBase,
        inFlight: { ...inFlightBase.inFlight, tools: [...tools] },
        updatedAt: now(),
      };
      livePersists = livePersists.then(() => persist(live)).catch(() => {});
    };
    const codeTreeBefore =
      opts.getExec &&
      project &&
      decided.step.kind === "execute" &&
      decided.step.mode === "code"
        ? await captureWorkingTreeTree(opts.getExec, project.rootPath).catch(() => undefined)
        : undefined;
    const codeBeforeTree = codeTreeBefore?.ok ? codeTreeBefore.tree : undefined;
    const result = await executeStep(decided.step, {
      dispatch,
      ...(code ? { code } : {}),
      workflow,
      roster: opts.roster,
      onTool,
    });
    await livePersists.catch(() => {});
    // An abort during the execute arm returns aborted member results that would otherwise
    // fold a junk "(no synthesis)" fact and advance the round. Break before that fold/advance
    // — clearing only the pre-execute in-flight marker (at the UNCHANGED round) so a connected
    // client stops seeing a "now executing" card for the cancelled turn, while no junk fact or
    // round increment lands, keeping the round budget intact across an abort+resume.
    if (opts.abortSignal?.aborted) {
      status = RUN_STATUS_ABORTED;
      ledger = { ...ledger, inFlight: undefined, updatedAt: now() };
      await persist(ledger);
      break;
    }
    if (result.dispatch) {
      const d = result.dispatch;
      const oks = d.perMember.filter((r) => r.status === "ok" && r.text.trim().length > 0);
      const failures = d.perMember
        .filter((r) => r.status !== "ok" || r.text.trim().length === 0)
        .map(
          (r) =>
            `[${r.name}] (turn failed: ${
              r.status === "ok" ? "empty response" : (r.error ?? r.status)
            })`,
        );
      // Prefer the synthesis; when it is absent/failed, attribute EVERY member's reply
      // rather than keeping only the first (a failed multi-member synthesis must not
      // silently discard members #2..N).
      const synth =
        d.synthesis?.trim() ||
        (oks.length > 1
          ? oks.map((r) => `[${r.name}] ${r.text.trim()}`).join("\n\n")
          : oks[0]?.text.trim()) ||
        (d.perMember.length > 0 && failures.length === d.perMember.length
          ? failures.join("\n\n")
          : undefined) ||
        "(no synthesis)";
      // Surface dispatch notes (cost-cap truncation, synthesis skip/failure) so they
      // reach the next round's prompt instead of being silently dropped.
      const noteSuffix = d.notes.length > 0 ? `\n(notes: ${d.notes.join("; ")})` : "";
      const provider = distinctProviders(oks);
      ledger = {
        ...ledger,
        facts: foldFacts(ledger.facts, [
          cap(`[${decided.step.speaker ?? "team"}] ${synth}`, FACT_CAP),
        ]),
        transcript: append(ledger.transcript, {
          round: ledger.round,
          kind: "dispatch",
          ...(decided.step.speaker ? { speaker: decided.step.speaker } : {}),
          instruction: decided.step.instruction,
          text: synth + noteSuffix,
          ...(provider ? { provider } : {}),
          ...(d.usage ? { usage: d.usage } : {}),
          ...(d.perMember.length === 1 && d.perMember[0]?.tools
            ? { tools: d.perMember[0].tools }
            : {}),
          ...(d.perMember.length === 1 && d.perMember[0]?.durationMs !== undefined
            ? { durationMs: d.perMember[0].durationMs }
            : {}),
        }),
        updatedAt: now(),
      };
    } else if (result.code) {
      const text =
        result.code.status === "ok"
          ? result.code.text.trim() || "(no output)"
          : (result.code.error ?? result.code.status);
      const touched =
        opts.getExec && project
          ? await collectTouchedSummary(opts.getExec, project.rootPath)
          : undefined;
      ledger = {
        ...ledger,
        facts: foldFacts(ledger.facts, [
          cap(
            `[${decided.step.speaker ?? "member"} edited code] ${deriveCodeFinding(text, touched)}`,
            FACT_CAP,
          ),
        ]),
        transcript: append(ledger.transcript, {
          round: ledger.round,
          kind: "code",
          ...(decided.step.speaker ? { speaker: decided.step.speaker } : {}),
          instruction: decided.step.instruction,
          text,
          ...(result.code.providerId ? { provider: result.code.providerId } : {}),
          ...(touched ? { touched } : {}),
          ...(result.code.tools ? { tools: result.code.tools } : {}),
          ...(result.code.usage ? { usage: result.code.usage } : {}),
          ...(result.code.durationMs !== undefined ? { durationMs: result.code.durationMs } : {}),
        }),
        lastCodeRound: ledger.round,
        updatedAt: now(),
      };
    } else if (result.workflow) {
      const text = result.workflow.text;
      ledger = {
        ...ledger,
        facts: foldFacts(ledger.facts, [
          cap(`[${decided.step.speaker ?? "member"} authored workflow] ${text}`, FACT_CAP),
        ]),
        transcript: append(ledger.transcript, {
          round: ledger.round,
          kind: "workflow",
          ...(decided.step.speaker ? { speaker: decided.step.speaker } : {}),
          instruction: decided.step.instruction,
          text,
        }),
        updatedAt: now(),
      };
    }
    // A non-stalled execute round means the (possibly rebuilt) plan is working again, so a
    // resolved episode's swept steps are no longer the thing to avoid — drop them before a
    // later, unrelated stall surfaces a stale "do not resume" list.
    if (decided.state.stallCount === 0 && ledger.failedSteps?.length) {
      ledger = { ...ledger, failedSteps: [] };
    }
    // #57: fingerprint this execute outcome so the next decide() reads a run of identical
    // outcomes as a deterministic stall even when the manager keeps self-reporting progress.
    // A different outcome resets the counter automatically (no explicit clear on replan).
    const fp = outcomeFingerprint(ledger.transcript[ledger.transcript.length - 1]);
    if (fp) {
      const count = fp === ledger.outcomeRepeat?.fingerprint ? ledger.outcomeRepeat.count + 1 : 1;
      ledger = { ...ledger, outcomeRepeat: { fingerprint: fp, count } };
    }
    ledger = { ...ledger, round: ledger.round + 1, inFlight: undefined, updatedAt: now() };
    await persist(ledger);
  }

  let finalLedger = ledger;
  if (status === RUN_STATUS_ABORTED && finalLedger.status !== RUN_STATUS_ABORTED) {
    finalLedger = {
      ...finalLedger,
      status: RUN_STATUS_ABORTED,
      inFlight: undefined,
      updatedAt: now(),
    };
    await persist(finalLedger);
  }
  if (isTerminalStatus(status)) {
    // Fail-soft archival: persistence of run history must never fail the live run result.
    try {
      await archiveRun(opts.dataHome, finalLedger);
    } catch {
      // best-effort
    }
  }

  const provenance = summarizeProvenance(finalLedger.transcript);
  return {
    ledger: finalLedger,
    rounds: finalLedger.round,
    status,
    summary: finalLedger.summary ?? `coordinator ended: ${status}`,
    ...(provenance ? { provenance } : {}),
  };
}
