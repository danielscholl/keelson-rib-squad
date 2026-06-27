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

export interface DecideInput {
  progress: ProgressLedger;
  state: OrchestratorState;
  roster: readonly Pick<Member, "slug" | "tools">[];
  limits?: OrchestratorLimits;
}

export interface DecideOutput {
  step: OrchestratorStep;
  // The loop state AFTER this decision — the driver persists it for the next round.
  state: OrchestratorState;
}

// Resolve the next speaker against the live roster: honor the manager's pick when it
// names a real member, else fall back to the first roster member (least-spoken
// selection needs the transcript and lands with the live loop in P1). Undefined only
// when the roster is empty — the driver then ends the run.
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
  const limits = input.limits ?? DEFAULT_LIMITS;
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
  return {
    step: { kind: "execute", mode: "dispatch", speaker, instruction },
    state: { round, stallCount, resetCount },
  };
}

// --- driver stub (P0: dispatch arm only) ---------------------------------------
// The effectful side is deliberately thin in P0: it routes an `execute`/`dispatch`
// step to an injected dispatch function (dispatchFanout bound to live seams in P1) and
// returns the wave outcome. code/workflow arms and the standing manager turn are P2/
// P3/P1 — this proves the routing seam against a fake without a provider.

export interface ExecuteStepDeps {
  dispatch: (members: Member[], instruction: string) => Promise<DispatchOutcome>;
  roster: Member[];
}

export interface OrchestratorStepResult {
  step: OrchestratorStep;
  // Present only when a dispatch wave actually ran.
  dispatch?: DispatchOutcome;
}

export async function executeStep(
  step: OrchestratorStep,
  deps: ExecuteStepDeps,
): Promise<OrchestratorStepResult> {
  if (step.kind !== "execute" || step.mode !== "dispatch") return { step };
  const selected = step.speaker ? deps.roster.filter((m) => m.slug === step.speaker) : deps.roster;
  const members = selected.length > 0 ? selected : deps.roster;
  if (members.length === 0) return { step };
  const dispatch = await deps.dispatch(members, step.instruction);
  return { step, dispatch };
}
