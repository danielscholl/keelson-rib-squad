import { memberCanCode } from "./code.ts";
import type { DispatchOutcome } from "./dispatch.ts";
import type { Member } from "./types.ts";

// The Magentic coordinator's control core (#20). Two layers, mirroring chamber's
// room.ts split: a PURE decider here — same inputs, same OrchestratorStep, no I/O, no
// provider — and an effectful driver (P1) that runs the manager turn, parses its
// directive into a ProgressLedger, persists, and routes the step. P0 ships the pure
// decider (the control logic the whole loop hinges on) + a thin dispatch-only driver
// stub, so the satisfied/stall/replan/give-up/terminate behaviour is locked down and
// tested before a live coordinator turn is wired on top.

// The five Magentic progress questions — the orchestrator's per-round self-reflection,
// produced by the manager turn (P1) and consumed here. Lives in in-run state, not the
// governed ledger: it is reflection about the run, not durable team knowledge.
export interface ProgressLedger {
  isRequestSatisfied: boolean;
  isInLoop: boolean;
  isProgressBeingMade: boolean;
  // The member who should act next (a roster slug); absent when satisfied/stalled.
  nextSpeaker?: string;
  // The single instruction/question for that member.
  instructionOrQuestion?: string;
  // The execution mode the manager wants for the next step: "code" (a confined coding
  // turn) or "dispatch" (text fan-out, the default). Honored only when the next speaker
  // is code-capable; anything else is downgraded to dispatch by the decider.
  mode?: OrchestratorMode;
}

// The execution arms the orchestrator routes to (the #14 action space). P0 wires only
// "dispatch"; "code" (#3, the runCodeTurn primitive already shipped) and "workflow"
// arms land in P2/P3.
export type OrchestratorMode = "dispatch" | "code" | "workflow";

// One structural decision per round. Kind-tagged like chamber's StrategyStep; the
// driver dispatches on `kind`. `execute` carries the routing mode + the resolved
// speaker + the instruction; `replan` rebuilds the Task Ledger; `end` terminates.
export type OrchestratorStep =
  | { kind: "execute"; mode: OrchestratorMode; speaker?: string; instruction: string }
  | { kind: "replan"; reason: string }
  | { kind: "end"; reason: string };

// The loop counters the driver threads round to round. Pure: the decider reads them
// and returns the next values, never mutating in place.
export interface OrchestratorState {
  round: number;
  stallCount: number;
  resetCount: number;
}

// Termination bounds — the guardrails that make the loop provably finite (the piece
// chamber's room lacks; it backstops only on a flat turnBudget).
export interface OrchestratorLimits {
  // Hard ceiling on rounds — the absolute backstop.
  maxRounds: number;
  // Consecutive stalled rounds before a re-plan.
  maxStall: number;
  // Re-plans before the loop gives up.
  maxResets: number;
}

export const DEFAULT_LIMITS: OrchestratorLimits = { maxRounds: 24, maxStall: 3, maxResets: 2 };

// Merge a partial limits override with DEFAULT_LIMITS so callers may specify only the
// fields they care about (e.g. tightening maxStall for a test) without having to
// repeat the others. Always returns a FRESH object (never the shared DEFAULT_LIMITS by
// reference) so a caller can't mutate the module-level default.
export function overlayLimits(over?: Partial<OrchestratorLimits>): OrchestratorLimits {
  return { ...DEFAULT_LIMITS, ...over };
}

export interface DecideInput {
  progress: ProgressLedger;
  state: OrchestratorState;
  roster: readonly Pick<Member, "slug" | "tools">[];
  // Accepts a full override or a partial overlay (unspecified fields fall back to DEFAULT_LIMITS).
  limits?: Partial<OrchestratorLimits>;
}

export interface DecideOutput {
  step: OrchestratorStep;
  // The loop state AFTER this decision — the driver persists it for the next round.
  state: OrchestratorState;
}

// Resolve the next speaker against the live roster: honor the manager's pick when it
// names a real member, else fall back to the first roster member. Undefined only when
// the roster is empty — the driver then ends the run.
function resolveSpeaker(
  pick: string | undefined,
  roster: readonly Pick<Member, "slug">[],
): string | undefined {
  if (pick && roster.some((m) => m.slug === pick)) return pick;
  return roster[0]?.slug;
}

// The pure control step. Order matters: satisfaction wins over everything, then the
// hard round ceiling, then stall accounting (which may re-plan or give up), then the
// ordinary "execute the next instruction" path. Progress resets the stall counter.
export function decideOrchestratorStep(input: DecideInput): DecideOutput {
  const limits = overlayLimits(input.limits);
  const { progress, roster } = input;
  const { round } = input.state;
  let { stallCount, resetCount } = input.state;

  if (progress.isRequestSatisfied) {
    return {
      step: { kind: "end", reason: "request satisfied" },
      state: { round, stallCount, resetCount },
    };
  }

  if (round >= limits.maxRounds) {
    return {
      step: { kind: "end", reason: `max rounds (${limits.maxRounds}) reached` },
      state: { round, stallCount, resetCount },
    };
  }

  const stalled = progress.isInLoop || !progress.isProgressBeingMade;
  if (stalled) {
    stallCount += 1;
    if (stallCount >= limits.maxStall) {
      if (resetCount >= limits.maxResets) {
        return {
          step: { kind: "end", reason: `gave up after ${resetCount} re-plans` },
          state: { round, stallCount, resetCount },
        };
      }
      // Re-plan: clear the stall counter and spend a reset.
      return {
        step: { kind: "replan", reason: "stalled — rebuilding the plan" },
        state: { round, stallCount: 0, resetCount: resetCount + 1 },
      };
    }
  } else {
    stallCount = 0;
  }

  const speaker = resolveSpeaker(progress.nextSpeaker, roster);
  if (!speaker) {
    return {
      step: { kind: "end", reason: "no member available to act" },
      state: { round, stallCount, resetCount },
    };
  }
  const instruction =
    progress.instructionOrQuestion?.trim() || "Continue with the next step of the plan.";
  // The manager may ask for a code turn (only a code-capable speaker gets one) or a
  // workflow-authoring turn (any member); anything else runs as a dispatch. The arm may
  // still be unbound at execute time, in which case executeStep falls back to dispatch.
  const speakerMember = roster.find((m) => m.slug === speaker);
  let mode: OrchestratorMode = "dispatch";
  if (progress.mode === "code" && memberCanCode(speakerMember ?? { tools: [] })) mode = "code";
  else if (progress.mode === "workflow") mode = "workflow";
  return {
    step: { kind: "execute", mode, speaker, instruction },
    state: { round, stallCount, resetCount },
  };
}

// --- driver (dispatch + code arms) ---------------------------------------------
// The effectful side routes an `execute` step to an injected arm: `code` runs a single
// confined coding turn for the speaker (#3 runCodeTurn, bound to live seams in the
// coordinator); `dispatch` fans the step out (dispatchFanout). The code arm is optional
// — absent when no project is bound — so a code step then falls back to dispatch rather
// than failing. The workflow arm (P3) is not built; such a step also falls to dispatch.

// The normalized outcome of a code arm (a thin projection of runCodeTurn's result, so
// orchestrator stays decoupled from code.ts internals).
export interface CodeStepOutcome {
  status: "ok" | "error" | "timeout" | "aborted";
  text: string;
  error?: string;
  // The provider id the host resolved the coding turn to — for "coded by X" provenance.
  providerId?: string;
}

// The normalized outcome of a workflow-authoring arm (#20 P3): a workflow DAG authored,
// validated, and persisted as an artifact (running it stays an operator step).
export interface WorkflowStepOutcome {
  status: "ok" | "error";
  text: string;
  name?: string;
  path?: string;
  nodeCount?: number;
}

export interface ExecuteStepDeps {
  dispatch: (members: Member[], instruction: string) => Promise<DispatchOutcome>;
  code?: (member: Member, instruction: string) => Promise<CodeStepOutcome>;
  workflow?: (member: Member, instruction: string) => Promise<WorkflowStepOutcome>;
  roster: Member[];
}

export interface OrchestratorStepResult {
  step: OrchestratorStep;
  // Present only for the arm that actually ran.
  dispatch?: DispatchOutcome;
  code?: CodeStepOutcome;
  workflow?: WorkflowStepOutcome;
}

export async function executeStep(
  step: OrchestratorStep,
  deps: ExecuteStepDeps,
): Promise<OrchestratorStepResult> {
  if (step.kind !== "execute") return { step };

  if (step.mode === "code" && deps.code && step.speaker) {
    const member = deps.roster.find((m) => m.slug === step.speaker);
    if (member) {
      const code = await deps.code(member, step.instruction);
      return { step, code };
    }
  }

  if (step.mode === "workflow" && deps.workflow && step.speaker) {
    const member = deps.roster.find((m) => m.slug === step.speaker);
    if (member) {
      const workflow = await deps.workflow(member, step.instruction);
      return { step, workflow };
    }
  }

  // dispatch arm — also the fallback for a code/workflow step with no bound arm.
  const selected = step.speaker ? deps.roster.filter((m) => m.slug === step.speaker) : deps.roster;
  const members = selected.length > 0 ? selected : deps.roster;
  if (members.length === 0) return { step };
  const dispatch = await deps.dispatch(members, step.instruction);
  return { step, dispatch };
}
