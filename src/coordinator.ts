import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MemoryTools, RibContext } from "@keelson/shared";
import { runCodeTurn } from "./code.ts";
import { parseTrailingDirective } from "./control-json.ts";
import {
  type DispatchOutcome,
  dispatchFanout,
  type MemberContribution,
  reflectMembersAtClose,
} from "./dispatch.ts";
import { recallGrounding, reflectOutcome } from "./memory.ts";
import {
  type CodeStepOutcome,
  DEFAULT_LIMITS,
  decideOrchestratorStep,
  executeStep,
  type OrchestratorLimits,
  type ProgressLedger,
  type WorkflowStepOutcome,
} from "./orchestrator.ts";
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
  status: "active" | "done" | "gave-up" | "max-rounds";
  transcript: CoordinatorEntry[];
  // Steps attempted on a now-abandoned plan, swept on a re-plan so the rebuild is told not
  // to resume them; cleared once a non-stalled round shows the new plan is working again.
  failedSteps?: string[];
  summary?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CoordinatorEntry {
  round: number;
  kind: "coordinator" | "dispatch" | "code" | "workflow" | "replan" | "failed";
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
const MAX_FAILED = 20; // bounded list of recently-abandoned steps surfaced on a re-plan
const STEP_DESC_CAP = 200; // per-swept-step char cap so the re-plan prompt stays compact
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
  if (
    existing &&
    existing.task === task &&
    existing.status === "active" &&
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
- when the goal is fully met: {"action":"done","summary":"<the final answer / outcome>"}${codeNote}${workflowNote}
Set "satisfied" true only when the goal is genuinely complete. Pick next_speaker from the members above. Keep the instruction to ONE concrete step.`;
}

// --- the loop ------------------------------------------------------------------

export interface RunCoordinatorOptions {
  runAgentTurn: NonNullable<RibContext["runAgentTurn"]>;
  membersRoot: string;
  dataHome: string;
  roster: Member[];
  task: string;
  // The project the run targets. Required for the code arm (it confines the coding
  // turn to project.rootPath); absent means dispatch-only.
  project?: { id: string; name: string; rootPath: string };
  limits?: OrchestratorLimits;
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
  // Injected for testability; default binds reflectMembersAtClose to the live seams. Each
  // member that did substantive work in a completed run curates its own memory.md ONCE.
  reflectAtClose?: (contributions: readonly MemberContribution[]) => Promise<readonly string[]>;
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

// Accumulate swept steps onto the prior record (deduped, capped) so a multi-re-plan stall
// episode surfaces every abandoned step, not just the latest window's.
function mergeFailed(prev: readonly string[], added: readonly string[]): string[] {
  const seen = new Set(prev);
  const merged = [...prev];
  for (const a of added) {
    if (!seen.has(a)) {
      seen.add(a);
      merged.push(a);
    }
  }
  return merged.slice(-MAX_FAILED);
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
  const limits = opts.limits ?? DEFAULT_LIMITS;
  const timeoutMs = opts.perTurnTimeoutMs ?? DEFAULT_COORDINATOR_TIMEOUT_MS;
  const project = opts.project;
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
  let replanRequested = false;
  let status: RunCoordinatorResult["status"] = "max-rounds";

  while (true) {
    if (opts.abortSignal?.aborted) {
      status = "aborted";
      break;
    }
    if (ledger.round >= limits.maxRounds) {
      status = "max-rounds";
      // Persist a TERMINAL status so a same-task re-run starts fresh instead of
      // resuming this ceiling-hit ledger and short-circuiting straight back here.
      ledger = { ...ledger, status: "max-rounds", updatedAt: now() };
      await saveLedger(opts.dataHome, ledger);
      break;
    }

    const turn = await runConfinedTurn(
      opts.runAgentTurn,
      {
        system: COORDINATOR_SYSTEM,
        prompt: coordinatorPrompt(ledger, opts.roster, replanRequested, Boolean(code), recalled),
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
      // Reflect a COMPLETED run's outcome into the governed ledger so the next pass on
      // this project recalls it (the "grow memory" capstone arc). Only on a genuine
      // completion, not give-up; fail-soft (a write failure leaves the run succeeded).
      if (status === "done") {
        const wrote = await reflectOutcome(
          memory,
          project?.id,
          opts.task,
          ledger.summary ?? "",
          ledger.facts,
        );
        if (wrote) {
          ledger = {
            ...ledger,
            transcript: appendEntry(ledger.transcript, {
              round: ledger.round,
              kind: "coordinator",
              text: "[memory] recorded the outcome as a governed decision",
            }),
            updatedAt: now(),
          };
        }
        // Per-member reflection at the loop-close boundary: each member that did substantive
        // work grows its OWN memory.md once over its whole contribution — the per-agent half of
        // the capstone's "grow memory" arc (the shared half is reflectOutcome above). Bounded to
        // one paid turn per participant per run; skipped on abort; fail-soft.
        const contributions = collectContributions(ledger.transcript, opts.roster);
        if (contributions.length > 0 && !opts.abortSignal?.aborted) {
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
        ? mergeFailed(ledger.failedSteps ?? [], swept)
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
        }),
        updatedAt: now(),
      };
    } else if (result.code) {
      const text =
        result.code.status === "ok"
          ? result.code.text.trim() || "(no output)"
          : (result.code.error ?? result.code.status);
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
        }),
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

  return {
    ledger,
    rounds: ledger.round,
    status,
    summary: ledger.summary ?? `coordinator ended: ${status}`,
  };
}
