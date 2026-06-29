import { describe, expect, test } from "bun:test";
import type { DispatchOutcome } from "../src/dispatch.ts";
import {
  DEFAULT_LIMITS,
  type DecideInput,
  decideOrchestratorStep,
  executeStep,
  type OrchestratorLimits,
  type OrchestratorState,
  overlayLimits,
  type ProgressLedger,
} from "../src/orchestrator.ts";
import type { Member } from "../src/types.ts";

// The decider is pure (same inputs -> same OrchestratorStep), so it tests with plain
// objects and no harness. executeStep tests with a fake dispatch fn.

const ROSTER: Pick<Member, "slug" | "tools">[] = [
  { slug: "atlas", tools: ["code", "read"] },
  { slug: "vera", tools: ["read"] },
];

function ledger(over: Partial<ProgressLedger> = {}): ProgressLedger {
  return {
    isRequestSatisfied: false,
    isInLoop: false,
    isProgressBeingMade: true,
    nextSpeaker: "atlas",
    instructionOrQuestion: "do the next step",
    ...over,
  };
}
function state(over: Partial<OrchestratorState> = {}): OrchestratorState {
  return { round: 0, stallCount: 0, resetCount: 0, ...over };
}
function decide(input: Partial<DecideInput> & { progress: ProgressLedger }) {
  return decideOrchestratorStep({ state: state(), roster: ROSTER, ...input });
}

describe("overlayLimits", () => {
  test("no argument returns a fresh copy of DEFAULT_LIMITS (not the shared reference)", () => {
    expect(overlayLimits()).toEqual(DEFAULT_LIMITS);
    expect(overlayLimits()).not.toBe(DEFAULT_LIMITS); // can't alias/mutate the module default
  });

  test("empty object returns DEFAULT_LIMITS exactly", () => {
    expect(overlayLimits({})).toEqual(DEFAULT_LIMITS);
  });

  test("only maxStall overridden keeps default maxRounds and maxResets", () => {
    const result = overlayLimits({ maxStall: 1 });
    expect(result).toEqual({
      maxRounds: DEFAULT_LIMITS.maxRounds,
      maxStall: 1,
      maxResets: DEFAULT_LIMITS.maxResets,
    } satisfies OrchestratorLimits);
  });

  test("only maxRounds overridden keeps default maxStall and maxResets", () => {
    const result = overlayLimits({ maxRounds: 5 });
    expect(result).toEqual({
      maxRounds: 5,
      maxStall: DEFAULT_LIMITS.maxStall,
      maxResets: DEFAULT_LIMITS.maxResets,
    } satisfies OrchestratorLimits);
  });

  test("all fields overridden replaces defaults entirely", () => {
    const over = { maxRounds: 10, maxStall: 2, maxResets: 1 };
    expect(overlayLimits(over)).toEqual(over satisfies OrchestratorLimits);
  });
});

describe("decideOrchestratorStep", () => {
  test("satisfied request ends the loop (over everything else)", () => {
    const out = decide({
      progress: ledger({ isRequestSatisfied: true, isInLoop: true, isProgressBeingMade: false }),
    });
    expect(out.step.kind).toBe("end");
    if (out.step.kind === "end") expect(out.step.reason).toContain("satisfied");
  });

  test("executes the next instruction for the named speaker when progressing", () => {
    const out = decide({
      progress: ledger({ nextSpeaker: "vera", instructionOrQuestion: "review it" }),
    });
    expect(out.step).toEqual({
      kind: "execute",
      mode: "dispatch",
      speaker: "vera",
      instruction: "review it",
    });
    expect(out.state.stallCount).toBe(0);
  });

  test("carries mode:code when the named speaker is code-capable", () => {
    const out = decide({ progress: ledger({ nextSpeaker: "atlas", mode: "code" }) });
    expect(out.step).toMatchObject({ kind: "execute", mode: "code", speaker: "atlas" });
  });

  test("downgrades mode:code to dispatch for a non-code speaker", () => {
    const out = decide({ progress: ledger({ nextSpeaker: "vera", mode: "code" }) });
    expect(out.step).toMatchObject({ kind: "execute", mode: "dispatch", speaker: "vera" });
  });

  test("defaults to dispatch when no mode is requested", () => {
    const out = decide({ progress: ledger({ nextSpeaker: "atlas" }) });
    if (out.step.kind === "execute") expect(out.step.mode).toBe("dispatch");
  });

  test("passes mode:workflow through for any member", () => {
    const out = decide({ progress: ledger({ nextSpeaker: "vera", mode: "workflow" }) });
    expect(out.step).toMatchObject({ kind: "execute", mode: "workflow", speaker: "vera" });
  });

  test("progress resets a primed stall counter", () => {
    const out = decide({
      progress: ledger({ isProgressBeingMade: true }),
      state: state({ stallCount: 2 }),
    });
    expect(out.step.kind).toBe("execute");
    expect(out.state.stallCount).toBe(0);
  });

  test("a stalled round increments the counter but still executes below threshold", () => {
    const out = decide({
      progress: ledger({ isProgressBeingMade: false }),
      state: state({ stallCount: 0 }),
      limits: { maxRounds: 24, maxStall: 3, maxResets: 2 },
    });
    expect(out.step.kind).toBe("execute");
    expect(out.state.stallCount).toBe(1);
  });

  test("isInLoop counts as a stall", () => {
    const out = decide({ progress: ledger({ isInLoop: true }), state: state({ stallCount: 0 }) });
    expect(out.state.stallCount).toBe(1);
  });

  test("crossing maxStall triggers a re-plan and spends a reset", () => {
    const out = decide({
      progress: ledger({ isProgressBeingMade: false }),
      state: state({ stallCount: 2, resetCount: 0 }),
      limits: { maxRounds: 24, maxStall: 3, maxResets: 2 },
    });
    expect(out.step.kind).toBe("replan");
    expect(out.state.stallCount).toBe(0);
    expect(out.state.resetCount).toBe(1);
  });

  test("gives up when re-plans are exhausted", () => {
    const out = decide({
      progress: ledger({ isProgressBeingMade: false }),
      state: state({ stallCount: 2, resetCount: 2 }),
      limits: { maxRounds: 24, maxStall: 3, maxResets: 2 },
    });
    expect(out.step.kind).toBe("end");
    if (out.step.kind === "end") expect(out.step.reason).toContain("gave up");
  });

  test("the hard round ceiling ends the loop", () => {
    const out = decide({ progress: ledger(), state: state({ round: 24 }) });
    expect(out.step.kind).toBe("end");
    if (out.step.kind === "end") expect(out.step.reason).toContain("max rounds");
  });

  test("partial limits overlay: only maxStall set still respects default maxRounds", () => {
    // maxRounds from DEFAULT_LIMITS (24) should guard — round 24 must end the loop.
    const out = decide({
      progress: ledger(),
      state: state({ round: DEFAULT_LIMITS.maxRounds }),
      limits: { maxStall: 1 }, // only override maxStall; maxRounds/maxResets from defaults
    });
    expect(out.step.kind).toBe("end");
    if (out.step.kind === "end") expect(out.step.reason).toContain("max rounds");
  });

  test("partial limits overlay: only maxStall set still respects default maxResets", () => {
    // With maxStall:1 and stallCount already at 0, one stalled round triggers a replan.
    // maxResets from DEFAULT_LIMITS (2) means resetCount:2 exhausts re-plans.
    const out = decide({
      progress: ledger({ isProgressBeingMade: false }),
      state: state({ stallCount: 0, resetCount: DEFAULT_LIMITS.maxResets }),
      limits: { maxStall: 1 }, // only override maxStall
    });
    expect(out.step.kind).toBe("end");
    if (out.step.kind === "end") expect(out.step.reason).toContain("gave up");
  });

  test("an unknown next-speaker falls back to the first roster member", () => {
    const out = decide({ progress: ledger({ nextSpeaker: "ghost" }) });
    expect(out.step.kind).toBe("execute");
    if (out.step.kind === "execute") expect(out.step.speaker).toBe("atlas");
  });

  test("an empty roster ends the loop (no one to act)", () => {
    const out = decideOrchestratorStep({ progress: ledger(), state: state(), roster: [] });
    expect(out.step.kind).toBe("end");
    if (out.step.kind === "end") expect(out.step.reason).toContain("no member");
  });

  test("a blank instruction falls back to a default", () => {
    const out = decide({ progress: ledger({ instructionOrQuestion: "  " }) });
    if (out.step.kind === "execute") expect(out.step.instruction).toMatch(/next step/i);
  });

  test("DEFAULT_LIMITS are the documented bounds", () => {
    expect(DEFAULT_LIMITS).toEqual({
      maxRounds: 24,
      maxStall: 3,
      maxResets: 2,
    } satisfies OrchestratorLimits);
  });
});

describe("executeStep (P0 dispatch arm)", () => {
  const fullRoster: Member[] = [
    {
      slug: "atlas",
      name: "Atlas",
      role: "Engineer",
      charter: "x",
      status: "active",
      tools: ["code"],
    },
    {
      slug: "vera",
      name: "Vera",
      role: "Reviewer",
      charter: "x",
      status: "active",
      tools: ["read"],
    },
  ];
  function fakeOutcome(task: string): DispatchOutcome {
    return { task, perMember: [], synthesis: "ok", notes: [] };
  }

  test("routes an execute/dispatch step to the named speaker only", async () => {
    let dispatched: { members: Member[]; instruction: string } | undefined;
    const res = await executeStep(
      { kind: "execute", mode: "dispatch", speaker: "vera", instruction: "review it" },
      {
        roster: fullRoster,
        dispatch: async (members, instruction) => {
          dispatched = { members, instruction };
          return fakeOutcome(instruction);
        },
      },
    );
    expect(dispatched?.members.map((m) => m.slug)).toEqual(["vera"]);
    expect(dispatched?.instruction).toBe("review it");
    expect(res.dispatch?.synthesis).toBe("ok");
  });

  test("with no speaker, fans out to the whole roster", async () => {
    let count = 0;
    await executeStep(
      { kind: "execute", mode: "dispatch", instruction: "all hands" },
      {
        roster: fullRoster,
        dispatch: async (members) => {
          count = members.length;
          return fakeOutcome("all hands");
        },
      },
    );
    expect(count).toBe(2);
  });

  test("does not dispatch for replan/end", async () => {
    let called = false;
    const deps = {
      roster: fullRoster,
      dispatch: async () => {
        called = true;
        return fakeOutcome("x");
      },
    };
    await executeStep({ kind: "replan", reason: "x" }, deps);
    await executeStep({ kind: "end", reason: "x" }, deps);
    expect(called).toBe(false);
  });

  test("routes a code step to the code arm for the named member", async () => {
    let coded: { slug: string; instruction: string } | undefined;
    const res = await executeStep(
      { kind: "execute", mode: "code", speaker: "atlas", instruction: "edit foo" },
      {
        roster: fullRoster,
        dispatch: async () => fakeOutcome("x"),
        code: async (member, instruction) => {
          coded = { slug: member.slug, instruction };
          return { status: "ok", text: "edited" };
        },
      },
    );
    expect(coded).toEqual({ slug: "atlas", instruction: "edit foo" });
    expect(res.code?.status).toBe("ok");
    expect(res.dispatch).toBeUndefined();
  });

  test("a code step falls back to dispatch when no code arm is bound", async () => {
    let dispatched = false;
    const res = await executeStep(
      { kind: "execute", mode: "code", speaker: "atlas", instruction: "edit foo" },
      {
        roster: fullRoster,
        dispatch: async () => {
          dispatched = true;
          return fakeOutcome("x");
        },
      },
    );
    expect(dispatched).toBe(true);
    expect(res.dispatch).toBeDefined();
    expect(res.code).toBeUndefined();
  });

  test("routes a workflow step to the workflow arm", async () => {
    let authored: { slug: string; instruction: string } | undefined;
    const res = await executeStep(
      { kind: "execute", mode: "workflow", speaker: "atlas", instruction: "author a lint flow" },
      {
        roster: fullRoster,
        dispatch: async () => fakeOutcome("x"),
        workflow: async (member, instruction) => {
          authored = { slug: member.slug, instruction };
          return { status: "ok", text: "authored", name: "lint", nodeCount: 2 };
        },
      },
    );
    expect(authored).toEqual({ slug: "atlas", instruction: "author a lint flow" });
    expect(res.workflow?.status).toBe("ok");
    expect(res.dispatch).toBeUndefined();
  });

  test("a workflow step falls back to dispatch when no workflow arm is bound", async () => {
    let dispatched = false;
    const res = await executeStep(
      { kind: "execute", mode: "workflow", speaker: "atlas", instruction: "author" },
      {
        roster: fullRoster,
        dispatch: async () => {
          dispatched = true;
          return fakeOutcome("x");
        },
      },
    );
    expect(dispatched).toBe(true);
    expect(res.workflow).toBeUndefined();
  });
});
