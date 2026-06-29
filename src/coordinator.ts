import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryTools, RibContext, RibExec } from "@keelson/shared";
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
  overlayLimits,
  type ProgressLedger,
  type WorkflowStepOutcome,
} from "./orchestrator.ts";
import { hasBlockVerdict } from "./policies.ts";
import { runConfinedTurn } from "./turn-runner.ts";
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
  projectId?: string;
  // Durable run-delta baseline tree for change-quality checks. Captured once per active
  // ledger and reused across resumed invocations so prior-pass edits cannot evade the gate.
  baselineTree?: string;
  // Accumulated findings (folded from each dispatch synthesis + the coordinator).
  facts: string[];
  // The coordinator's current plan as prose steps.
  plan: string[];
  round: number;
  stallCount: number;
  resetCount: number;
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
  // The latest round that executed a code step (our concrete "code changed/ran" marker).
  lastCodeRound?: number;
  // The latest round where the project-bound adversarial review was clean (no BLOCK verdict).
  lastCleanReviewRound?: number;
  summary?: string;
  createdAt: string;
  updatedAt: string;
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
  // Per-code-step repo footprint (including untracked files) surfaced for manager visibility.
  touched?: { files: number; insertions: number; deletions: number };
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
}

export const LEDGER_STATUS_ACTIVE = "active" as const;
export const RUN_STATUS_DONE = "done" as const;
export const RUN_STATUS_GAVE_UP = "gave-up" as const;
export const RUN_STATUS_MAX_ROUNDS = "max-rounds" as const;
export const RUN_STATUS_VERIFICATION_FAILED = "verification-failed" as const;
export const RUN_STATUS_CHANGE_QUALITY_FAILED = "change-quality-failed" as const;

export type CoordinatorTerminalStatus =
  | typeof RUN_STATUS_DONE
  | typeof RUN_STATUS_GAVE_UP
  | typeof RUN_STATUS_MAX_ROUNDS
  | typeof RUN_STATUS_VERIFICATION_FAILED
  | typeof RUN_STATUS_CHANGE_QUALITY_FAILED;
export type CoordinatorLedgerStatus = typeof LEDGER_STATUS_ACTIVE | CoordinatorTerminalStatus;
export type RunCoordinatorStatus = CoordinatorTerminalStatus | "error" | "aborted";

// The directive a coordinator turn must end with: `progress` carries the five Progress
// Ledger answers + the next step, `done` carries the final summary.
const COORDINATOR_ACTIONS: ReadonlySet<string> = new Set(["progress", "done"]);

const FACT_CAP = 600; // per-fact char cap so one long synthesis can't bloat the ledger
const MAX_FACTS = 60; // ledger keeps the most recent facts
const MAX_TRANSCRIPT = 40; // bounded so the prompt + file stay sane
const ENTRY_CAP = 1500; // per-transcript-entry char cap
const MAX_FAILED = 20; // bounded list of recently-abandoned steps surfaced on a re-plan
const STEP_DESC_CAP = 200; // per-swept-step char cap so the re-plan prompt stays compact
const MAX_GAPS = 6; // bounded list of "the roster lacks X" recommendations
const GAP_CAP = 160; // per-gap char cap so a recommendation stays a short headline
export const MAX_VERIFY_FAILURES = 3; // consecutive done-gate failures before terminating
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
  const needs = asStrArray(p.needs ?? p.missing).map((n) => n.slice(0, GAP_CAP));
  const summary = asStr(p.summary);

  if (p.action === "done") {
    return {
      progress: { isRequestSatisfied: true, isInLoop: false, isProgressBeingMade: true },
      facts,
      plan,
      needs,
      ...(summary ? { summary } : {}),
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

function freshLedger(task: string, projectId: string | undefined, at: string): CoordinatorLedger {
  return {
    task,
    ...(projectId ? { projectId } : {}),
    facts: [],
    plan: [],
    round: 0,
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
  projectId: string | undefined,
  at: string,
): Promise<CoordinatorLedger> {
  const existing = await loadLedger(dataHome);
  if (
    existing &&
    existing.task === task &&
    existing.status === LEDGER_STATUS_ACTIVE &&
    // Resume only within the SAME project — a generic task ("fix the failing tests")
    // run against repo A then repo B must not resume A's facts/plan while the code arm
    // confines edits to B.
    (existing.projectId ?? undefined) === (projectId ?? undefined)
  ) {
    return existing;
  }
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
${replanNote}
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
Set "satisfied" true only when the goal is genuinely complete. Pick next_speaker from the members above. Keep the instruction to ONE concrete step.`;
}

// --- the loop ------------------------------------------------------------------

export interface RunCoordinatorOptions {
  runAgentTurn: NonNullable<RibContext["runAgentTurn"]>;
  membersRoot: string;
  dataHome: string;
  roster: Member[];
  task: string;
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
  // Injected for testability; default binds dispatchFanout to the live seams.
  dispatch?: (members: Member[], instruction: string) => Promise<DispatchOutcome>;
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

// Run the operator-configured verify commands against the project root via the exec seam.
// Non-paid (processes, not LLM turns). Fail-fast: stop at the first non-zero exit and return it;
// an all-green pass returns a count summary. Each command runs through `bash -c` so an operator
// string like "bun run check" or "bun --filter '*' test" works verbatim. acceptNonZeroExit makes
// a non-zero exit a returned result, not an error, so a failing suite is data, not a throw.
async function runVerification(
  exec: RibExec,
  commands: readonly string[],
  cwd: string,
  atRound: number,
): Promise<VerificationRecord> {
  for (const command of commands) {
    const res = await exec.runText("bash", ["-c", command], {
      cwd,
      acceptNonZeroExit: true,
      timeoutMs: VERIFY_TIMEOUT_MS,
    });
    const exitCode = res.ok ? (res.exitCode ?? 0) : (res.code ?? 1);
    if (!res.ok || exitCode !== 0) {
      const out = res.ok ? res.data : res.error;
      return {
        command,
        exitCode,
        passed: false,
        summary: tailCap(out, VERIFY_SUMMARY_CAP),
        atRound,
      };
    }
  }
  const n = commands.length;
  const label = `${n} check${n === 1 ? "" : "s"}`;
  return { command: label, exitCode: 0, passed: true, summary: `${label} passed`, atRound };
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
    ((members: Member[], instruction: string) =>
      dispatchFanout({
        runAgentTurn: opts.runAgentTurn,
        membersRoot: opts.membersRoot,
        members,
        task: withTeamMemory(instruction, recalled),
        synthesize: members.length > 1,
        // Pass the project so a dispatched member can READ the repo to ground its answer (a
        // reviewer that can't open the diff is the live gap this closes); absent → text-only.
        ...(project ? { project: { name: project.name, rootPath: project.rootPath } } : {}),
        ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
      }));

  // The code arm: a confined coding turn for the speaker, bound only when a project is
  // present (it confines to project.rootPath). Absent → a code step falls to dispatch.
  const code =
    opts.code ??
    (project
      ? async (member: Member, instruction: string): Promise<CodeStepOutcome> => {
          const r = await runCodeTurn({
            runAgentTurn: opts.runAgentTurn,
            membersRoot: opts.membersRoot,
            member,
            project: { name: project.name, rootPath: project.rootPath },
            task: withTeamMemory(instruction, recalled),
            ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
          });
          return r.ok
            ? {
                status: r.outcome.status,
                text: r.outcome.text,
                ...(r.outcome.error ? { error: r.outcome.error } : {}),
                ...(r.outcome.providerId ? { providerId: r.outcome.providerId } : {}),
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

  let ledger = await loadOrInit(opts.dataHome, opts.task, project?.id, now());
  const exec = opts.getExec;
  const runStartTree =
    project && exec
      ? await (async () => {
          if (ledger.baselineTree) return { ok: true as const, tree: ledger.baselineTree };
          const captured = await captureWorkingTreeTree(exec, project.rootPath);
          if (captured.ok) {
            ledger = { ...ledger, baselineTree: captured.tree, updatedAt: now() };
            await saveLedger(opts.dataHome, ledger);
          }
          return captured;
        })()
      : undefined;
  let replanRequested = false;
  let status: RunCoordinatorResult["status"] = RUN_STATUS_MAX_ROUNDS;

  while (true) {
    if (opts.abortSignal?.aborted) {
      status = "aborted";
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
      let ceilingSummary: string | undefined;
      if (
        unresolvedReview &&
        project &&
        opts.getExec &&
        verify.length > 0 &&
        !opts.abortSignal?.aborted
      ) {
        const v = await runVerification(opts.getExec, verify, project.rootPath, ledger.round);
        ceilingSummary = v.passed
          ? `Round ceiling reached with an unresolved review BLOCK, but the deterministic floor is GREEN (${v.command}) — the artifact passes on its own; the blocker is an unsubstantiated or unverified review, not a broken build. Human review recommended.`
          : `Round ceiling reached with an unresolved review BLOCK and a RED deterministic check (${v.command}, exit ${v.exitCode}) — the artifact does not pass on its own.`;
      }
      // Persist a TERMINAL status so a same-task re-run starts fresh instead of
      // resuming this ceiling-hit ledger and short-circuiting straight back here.
      ledger = {
        ...ledger,
        status: RUN_STATUS_MAX_ROUNDS,
        ...(ceilingSummary ? { summary: ceilingSummary } : {}),
        updatedAt: now(),
      };
      await saveLedger(opts.dataHome, ledger);
      break;
    }

    const turn = await runConfinedTurn(
      opts.runAgentTurn,
      {
        system: COORDINATOR_SYSTEM,
        prompt: coordinatorPrompt(ledger, opts.roster, replanRequested, Boolean(code), recalled),
        ...(normalizedManagerProvider ? { provider: normalizedManagerProvider } : {}),
        ...(normalizedManagerModel ? { model: normalizedManagerModel } : {}),
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
      // Accumulate the run's roster-gap recommendations (deduped, capped). The squad notices
      // when it lacks a specialist and surfaces it; casting stays the operator's call.
      ...(directive.needs.length
        ? { teamGaps: dedupeCap(ledger.teamGaps ?? [], directive.needs, MAX_GAPS) }
        : {}),
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
            transcript: appendEntry(ledger.transcript, {
              round: ledger.round,
              kind: "verify",
              text,
            }),
            round: ledger.round + 1,
            updatedAt: now(),
          };
          await saveLedger(opts.dataHome, ledger);
          continue;
        }
        const review = await dispatch(
          reviewers,
          "Adversarial review the current project diff and try to refute it. Cite exact file:line evidence. Only emit the sentinel RAI VERDICT: BLOCK when you can name a SPECIFIC, reproducible defect — a concrete failing input or a wrong line and why it is wrong — not a hunch and not an inability to verify. If your refutation attempts all pass and you cannot identify or substantiate a concrete blocking defect, emit RAI VERDICT: PASS and record any residual concerns as caveats rather than blocking. If no blocker remains, clearly say RAI VERDICT: PASS.",
        );
        const reviewProvider = distinctProviders(
          review.perMember.filter((r) => r.status === "ok" && r.text.trim().length > 0),
        );
        const { summary, hadUsableOutput } = summarizeReview(review);
        const blocked = hasBlockVerdict(summary);
        ledger = {
          ...ledger,
          transcript: appendEntry(ledger.transcript, {
            round: ledger.round,
            kind: "verify",
            text: blocked
              ? `RAI VERDICT: BLOCK\n${summary}`
              : `review passed (no BLOCK verdict)\n${summary}`,
            ...(reviewProvider ? { provider: reviewProvider } : {}),
          }),
          ...(blocked || !hadUsableOutput
            ? { facts: foldFacts(ledger.facts, [cap(`RAI VERDICT: BLOCK\n${summary}`, FACT_CAP)]) }
            : { lastCleanReviewRound: ledger.round }),
          updatedAt: now(),
        };
        if (blocked || !hadUsableOutput) {
          ledger = { ...ledger, round: ledger.round + 1, updatedAt: now() };
          await saveLedger(opts.dataHome, ledger);
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
          transcript: appendEntry(ledger.transcript, {
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
              updatedAt: now(),
            };
            await saveLedger(opts.dataHome, ledger);
            break;
          }
          // Veto the manager's done: advance the round and hand the failure back so the next
          // manager turn must fix the red build rather than re-declare done on it.
          ledger = { ...ledger, round: ledger.round + 1, updatedAt: now() };
          await saveLedger(opts.dataHome, ledger);
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
          transcript: appendEntry(ledger.transcript, {
            round: ledger.round,
            kind: "verify",
            text: "verification skipped: exec seam unavailable on this harness (done not gated)",
          }),
          updatedAt: now(),
        };
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
            transcript: appendEntry(ledger.transcript, {
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
              updatedAt: now(),
            };
            await saveLedger(opts.dataHome, ledger);
            break;
          }
          ledger = { ...ledger, round: ledger.round + 1, updatedAt: now() };
          await saveLedger(opts.dataHome, ledger);
          continue;
        }
        ledger = { ...ledger, changeQualityFailures: 0, updatedAt: now() };
      }
      status = givingUp ? RUN_STATUS_GAVE_UP : RUN_STATUS_DONE;
      ledger = {
        ...ledger,
        status: givingUp ? RUN_STATUS_GAVE_UP : RUN_STATUS_DONE,
        ...(ledger.summary ? {} : { summary: directive.summary ?? decided.step.reason }),
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
            transcript: appendEntry(ledger.transcript, {
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
                transcript: appendEntry(ledger.transcript, {
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
      await saveLedger(opts.dataHome, ledger);
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
        transcript = appendEntry(transcript, {
          round: ledger.round,
          kind: "failed",
          text: `swept ${swept.length} stalled step${swept.length === 1 ? "" : "s"} to failed before rebuild`,
        });
      }
      transcript = appendEntry(transcript, {
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
        updatedAt: now(),
      };
      await saveLedger(opts.dataHome, ledger);
      continue;
    }

    // execute: the dispatch, code, or workflow-authoring arm
    const result = await executeStep(decided.step, {
      dispatch,
      ...(code ? { code } : {}),
      workflow,
      roster: opts.roster,
    });
    // An abort during the execute arm returns aborted member results that would otherwise
    // fold a junk "(no synthesis)" fact and advance the round. Break before that fold/advance
    // and without persisting — like the manager-turn abort above, which likewise only bumps
    // updatedAt in memory (no saveLedger) — so abort+resume can't erode the round budget.
    if (opts.abortSignal?.aborted) {
      status = "aborted";
      ledger = { ...ledger, updatedAt: now() };
      break;
    }
    if (result.dispatch) {
      const d = result.dispatch;
      const oks = d.perMember.filter((r) => r.status === "ok" && r.text.trim().length > 0);
      // Prefer the synthesis; when it is absent/failed, attribute EVERY member's reply
      // rather than keeping only the first (a failed multi-member synthesis must not
      // silently discard members #2..N).
      const synth =
        d.synthesis?.trim() ||
        (oks.length > 1
          ? oks.map((r) => `[${r.name}] ${r.text.trim()}`).join("\n\n")
          : oks[0]?.text.trim()) ||
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
        transcript: appendEntry(ledger.transcript, {
          round: ledger.round,
          kind: "dispatch",
          ...(decided.step.speaker ? { speaker: decided.step.speaker } : {}),
          instruction: decided.step.instruction,
          text: synth + noteSuffix,
          ...(provider ? { provider } : {}),
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
          cap(`[${decided.step.speaker ?? "member"} edited code] ${text}`, FACT_CAP),
        ]),
        transcript: appendEntry(ledger.transcript, {
          round: ledger.round,
          kind: "code",
          ...(decided.step.speaker ? { speaker: decided.step.speaker } : {}),
          instruction: decided.step.instruction,
          text,
          ...(result.code.providerId ? { provider: result.code.providerId } : {}),
          ...(touched ? { touched } : {}),
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
        transcript: appendEntry(ledger.transcript, {
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
    ledger = { ...ledger, round: ledger.round + 1, updatedAt: now() };
    await saveLedger(opts.dataHome, ledger);
  }

  const provenance = summarizeProvenance(ledger.transcript);
  return {
    ledger,
    rounds: ledger.round,
    status,
    summary: ledger.summary ?? `coordinator ended: ${status}`,
    ...(provenance ? { provenance } : {}),
  };
}
