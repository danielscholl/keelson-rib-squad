import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  MemoryTools,
  MessageChunk,
  RecallResponse,
  RibContext,
  RibExec,
  ToolDefinition,
  WritebackRequest,
  WritebackResponse,
} from "@keelson/shared";
import { RECALL_RESPONSE_SCHEMA_VERSION, WRITEBACK_RESPONSE_SCHEMA_VERSION } from "@keelson/shared";
import {
  actionLabel,
  type CoordinatorEntry,
  type CoordinatorLedger,
  clearLedger,
  collectIncompleteCommitPaths,
  deriveCodeFinding,
  failStuckTasks,
  loadLedger,
  MAX_CHANGE_QUALITY_FAILURES,
  MAX_VERIFY_FAILURES,
  parseCoordinatorDirective,
  provenanceLines,
  runCoordinator,
  saveLedger,
  withPlanContext,
} from "../src/coordinator.ts";
import type { DispatchOutcome } from "../src/dispatch.ts";
import rib from "../src/index.ts";
import { scaffoldMember } from "../src/member-store.ts";
import {
  DEFAULT_SCOPE_ID,
  scopeDataHome,
  scopeMembersDir,
  setSquadDataHome,
} from "../src/paths.ts";
import type { Member } from "../src/types.ts";

const NOW = "2026-06-27T00:00:00.000Z";

async function* oneShot(): AsyncGenerator<MessageChunk> {
  yield { type: "done" };
}
// A fake coordinator turn seam that returns canned replies in order (repeating the
// last). The dispatch arm is injected separately, so this drives ONLY coordinator
// turns — no provider, no real fan-out.
function queuedRun(replies: string[]): NonNullable<RibContext["runAgentTurn"]> {
  let i = 0;
  return () => {
    const text = replies[Math.min(i, replies.length - 1)] ?? "";
    i += 1;
    return { stream: oneShot(), result: Promise.resolve({ status: "ok" as const, text }) };
  };
}
function capturingQueuedRun(
  replies: string[],
  seen: Parameters<NonNullable<RibContext["runAgentTurn"]>>[0][],
): NonNullable<RibContext["runAgentTurn"]> {
  let i = 0;
  return (req) => {
    seen.push(req);
    const text = replies[Math.min(i, replies.length - 1)] ?? "";
    i += 1;
    return { stream: oneShot(), result: Promise.resolve({ status: "ok" as const, text }) };
  };
}
function roster(...slugs: string[]): Member[] {
  return slugs.map((slug) => ({
    slug,
    name: slug,
    role: "Engineer",
    charter: "x",
    status: "active" as const,
    tools: ["read"],
  }));
}
function fakeDispatch(synthesis = "did the work") {
  const calls: { members: string[]; instruction: string }[] = [];
  const fn = async (members: Member[], instruction: string): Promise<DispatchOutcome> => {
    calls.push({ members: members.map((m) => m.slug), instruction });
    return { task: instruction, perMember: [], synthesis, notes: [] };
  };
  return { fn, calls };
}

function project(id: string, name: string, rootPath: string) {
  return { id, name, rootPath, createdAt: NOW };
}

function registeredTool(tools: readonly ToolDefinition[], name: string): ToolDefinition {
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`${name} not registered`);
  return found;
}

function captureTool(): { ctx: unknown; out: () => { content: string; isError: boolean } } {
  let content = "";
  let isError = false;
  return {
    ctx: {
      emit: (e: { content?: string; isError?: boolean }) => {
        content = e.content ?? "";
        isError = Boolean(e.isError);
      },
    },
    out: () => ({ content, isError }),
  };
}

// A memory seam that captures every writeback (so a test can assert what the loop recorded)
// and returns the given recall items (none by default). `written: false` models a store that
// accepted the request but persisted no row (deduped/blocked).
function capturingMemory(
  writebacks: WritebackRequest[],
  items: RecallResponse["items"] = [],
  written = true,
): MemoryTools {
  return {
    recall: async (): Promise<RecallResponse> => ({
      schemaVersion: RECALL_RESPONSE_SCHEMA_VERSION,
      requestId: "r",
      items,
      trace: { traceId: "t", returned: items.length },
    }),
    writeback: async (req): Promise<WritebackResponse> => {
      writebacks.push(req);
      return {
        schemaVersion: WRITEBACK_RESPONSE_SCHEMA_VERSION,
        written: written ? [{ memoryId: "w1", idempotencyKey: req.idempotencyKey }] : [],
        blocked: [],
        deduped: [],
      };
    },
  };
}

describe("parseCoordinatorDirective", () => {
  test("parses a progress directive with the five questions + facts + plan", () => {
    const d = parseCoordinatorDirective(
      'reasoning\n{"action":"progress","satisfied":false,"in_loop":true,"progress":false,"next_speaker":"atlas","instruction":"do X","facts":["f1"],"plan":["s1","s2"]}',
    );
    expect(d?.progress).toEqual({
      isRequestSatisfied: false,
      isInLoop: true,
      isProgressBeingMade: false,
      nextSpeaker: "atlas",
      instructionOrQuestion: "do X",
    });
    expect(d?.facts).toEqual(["f1"]);
    expect(d?.plan).toEqual(["s1", "s2"]);
    expect(d?.head).toBe("reasoning");
  });

  test("parses a done directive", () => {
    const d = parseCoordinatorDirective('all set\n{"action":"done","summary":"shipped"}');
    expect(d?.progress.isRequestSatisfied).toBe(true);
    expect(d?.summary).toBe("shipped");
  });

  test("tolerates field synonyms (assignee / inLoop)", () => {
    const d = parseCoordinatorDirective('{"action":"progress","assignee":"vera","inLoop":true}');
    expect(d?.progress.nextSpeaker).toBe("vera");
    expect(d?.progress.isInLoop).toBe(true);
    expect(d?.progress.isProgressBeingMade).toBe(true); // defaults true
  });

  test("parses the execution mode (code/dispatch/workflow only)", () => {
    expect(
      parseCoordinatorDirective('{"action":"progress","next_speaker":"atlas","mode":"code"}')
        ?.progress.mode,
    ).toBe("code");
    expect(
      parseCoordinatorDirective('{"action":"progress","next_speaker":"atlas","mode":"workflow"}')
        ?.progress.mode,
    ).toBe("workflow");
    expect(
      parseCoordinatorDirective('{"action":"progress","next_speaker":"atlas","mode":"bogus"}')
        ?.progress.mode,
    ).toBeUndefined();
  });

  test("parses a team-gap recommendation (needs), defaulting to [] when absent", () => {
    const d = parseCoordinatorDirective(
      '{"action":"progress","next_speaker":"atlas","instruction":"x","needs":["a security reviewer","a frontend specialist"]}',
    );
    expect(d?.needs).toEqual(["a security reviewer", "a frontend specialist"]);
    expect(parseCoordinatorDirective('{"action":"done","summary":"ok"}')?.needs).toEqual([]);
  });

  test("returns null without a valid trailing directive", () => {
    expect(parseCoordinatorDirective("just prose, no json")).toBeNull();
    expect(parseCoordinatorDirective('{"action":"progress"} then more text')).toBeNull();
    expect(parseCoordinatorDirective('{"action":"bogus"}')).toBeNull();
  });
});

describe("actionLabel", () => {
  test("maps each execute mode to its short verb, falling back to 'working'", () => {
    expect(actionLabel({ kind: "execute", mode: "code", instruction: "x" })).toBe("coding");
    expect(actionLabel({ kind: "execute", mode: "workflow", instruction: "x" })).toBe(
      "authoring a workflow",
    );
    expect(actionLabel({ kind: "execute", mode: "dispatch", instruction: "x" })).toBe("working");
    expect(actionLabel({ kind: "end", reason: "done" })).toBe("working");
    expect(actionLabel({ kind: "replan", reason: "stalled" })).toBe("working");
  });
});

describe("withPlanContext", () => {
  test("adds the current manager plan and assigned step", () => {
    const prompt = withPlanContext("patch the dispatcher", [
      "Confirm the failing dispatch prompt",
      "Project plan rows into member turns",
    ]);

    expect(prompt).toContain("The manager's current plan");
    expect(prompt).toContain("lives with the coordinator");
    expect(prompt).toContain("1. Confirm the failing dispatch prompt");
    expect(prompt).toContain("2. Project plan rows into member turns");
    expect(prompt).toContain("Your assigned step in this plan:\npatch the dispatcher");
  });

  test("returns the original instruction when no plan exists", () => {
    expect(withPlanContext("patch the dispatcher", [])).toBe("patch the dispatcher");
  });
});

describe("deriveCodeFinding", () => {
  test("returns the outcome paragraph after opening narration", () => {
    const finding = deriveCodeFinding(
      "On it — I'll find the helper and patch it.\n\nUpdated the coordinator to mint findings from the code turn outcome.",
    );

    expect(finding).toBe("Updated the coordinator to mint findings from the code turn outcome.");
  });

  test("returns a single outcome-only paragraph verbatim", () => {
    expect(deriveCodeFinding("Updated the parser and added coverage.")).toBe(
      "Updated the parser and added coverage.",
    );
  });

  test("strips smart-apostrophe narration openers", () => {
    const finding = deriveCodeFinding(
      "I’ll ground this in the helper first.\n\nMinted findings now carry the outcome line.",
    );

    expect(finding).toBe("Minted findings now carry the outcome line.");
  });

  test("does not treat the word Ill- as an I'll contraction", () => {
    expect(deriveCodeFinding("Ill-defined behavior removed from the fold path.")).toBe(
      "Ill-defined behavior removed from the fold path.",
    );
  });

  test("falls back to touched summary when all text is narration", () => {
    expect(
      deriveCodeFinding("On it — I'll make the change.", {
        files: 2,
        insertions: 7,
        deletions: 2,
      }),
    ).toBe("touched 2 files (+7 −2)");
  });

  test("falls back to no reported outcome without touched summary", () => {
    expect(deriveCodeFinding("On it — I'll make the change.")).toBe("(no reported outcome)");
  });

  test("falls back to touched summary for empty and no-output text", () => {
    const touched = { files: 2, insertions: 7, deletions: 2 };

    expect(deriveCodeFinding("", touched)).toBe("touched 2 files (+7 −2)");
    expect(deriveCodeFinding("(no output)", touched)).toBe("touched 2 files (+7 −2)");
  });

  test("uses singular file count in touched summary", () => {
    expect(deriveCodeFinding("Okay.", { files: 1, insertions: 1, deletions: 0 })).toBe(
      "touched 1 file (+1 −0)",
    );
  });
});

describe("failStuckTasks", () => {
  test("collects execute steps since the last re-plan boundary, in order", () => {
    const transcript: CoordinatorEntry[] = [
      { round: 0, kind: "dispatch", speaker: "atlas", instruction: "old step", text: "before" },
      { round: 1, kind: "replan", text: "stalled — rebuilding the plan" },
      { round: 2, kind: "coordinator", text: "rethinking" },
      { round: 2, kind: "code", speaker: "vera", instruction: "edit foo.ts", text: "edited" },
      { round: 3, kind: "dispatch", speaker: "atlas", instruction: "probe bar", text: "probed" },
    ];
    // The pre-boundary "old step" is excluded; the two post-boundary execute steps return
    // chronologically as "speaker: instruction".
    expect(failStuckTasks(transcript)).toEqual(["vera: edit foo.ts", "atlas: probe bar"]);
  });

  test("returns [] when the window holds no execute steps", () => {
    expect(failStuckTasks([{ round: 0, kind: "coordinator", text: "thinking" }])).toEqual([]);
    expect(failStuckTasks([])).toEqual([]);
  });
});

describe("ledger persistence", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "squad-coord-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  test("save then load round-trips", async () => {
    const ledger: CoordinatorLedger = {
      task: "ship it",
      facts: ["a"],
      plan: ["step"],
      round: 3,
      stallCount: 1,
      resetCount: 0,
      status: "active",
      transcript: [{ round: 0, kind: "coordinator", text: "hi" }],
      createdAt: NOW,
      updatedAt: NOW,
    };
    await saveLedger(home, ledger);
    expect(await loadLedger(home)).toEqual(ledger);
  });

  test("missing file loads as undefined", async () => {
    expect(await loadLedger(home)).toBeUndefined();
  });

  test("corrupt file loads as undefined (start fresh, no throw)", async () => {
    await writeFile(join(home, "coordinator-ledger.json"), "{ torn json");
    expect(await loadLedger(home)).toBeUndefined();
  });

  test("clearLedger removes the ledger so it reads back idle, idempotently", async () => {
    const ledger: CoordinatorLedger = {
      task: "ship it",
      facts: [],
      plan: [],
      round: 4,
      stallCount: 0,
      resetCount: 0,
      status: "done",
      transcript: [],
      createdAt: NOW,
      updatedAt: NOW,
    };
    await saveLedger(home, ledger);
    expect(await loadLedger(home)).toEqual(ledger);
    await clearLedger(home);
    expect(await loadLedger(home)).toBeUndefined();
    // Idempotent: clearing an absent ledger is a no-op, not a throw.
    await clearLedger(home);
    expect(await loadLedger(home)).toBeUndefined();
  });

  test("the default scope's data home is the legacy ledger path (no-op)", async () => {
    expect(scopeDataHome(home, DEFAULT_SCOPE_ID)).toBe(home);
    const ledger: CoordinatorLedger = {
      task: "ship it",
      facts: [],
      plan: [],
      round: 0,
      stallCount: 0,
      resetCount: 0,
      status: "active",
      transcript: [],
      createdAt: NOW,
      updatedAt: NOW,
    };
    // Saving under the default-scoped home is byte-for-byte the legacy bare-home path.
    await saveLedger(scopeDataHome(home, DEFAULT_SCOPE_ID), ledger);
    expect(await loadLedger(home)).toEqual(ledger);
  });
});

describe("squad_coordinate tool diagnostics", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "squad-coord-tool-"));
    setSquadDataHome(home);
  });
  afterEach(async () => {
    rib.dispose?.();
    setSquadDataHome(undefined);
    await rm(home, { recursive: true, force: true });
  });

  test("no-members error names the resolved scope and populated scopes", async () => {
    await scaffoldMember(scopeMembersDir(home, DEFAULT_SCOPE_ID), {
      slug: "atlas",
      name: "Atlas",
      role: "Engineer",
      charter: "# Atlas",
      status: "active",
      createdAt: NOW,
    });
    await scaffoldMember(scopeMembersDir(home, "beta"), {
      slug: "vera",
      name: "Vera",
      role: "Reviewer",
      charter: "# Vera",
      status: "active",
      createdAt: NOW,
    });
    const ctx = {
      getDataDir: () => home,
      getProjects: () => [project("alpha", "alpha", "/repo/alpha")],
      runAgentTurn: queuedRun(['ok\n{"action":"done","summary":"finished it"}']),
    } as unknown as RibContext;
    const tools = rib.registerTools?.(ctx) ?? [];
    const capture = captureTool();

    await registeredTool(tools, "squad_coordinate").execute(
      { task: "ship it", project: "alpha" },
      capture.ctx as never,
    );

    expect(capture.out().isError).toBe(true);
    expect(capture.out().content).toContain('scope "alpha"');
    expect(capture.out().content).toContain("default (1)");
    expect(capture.out().content).toContain("beta (1)");
  });
});

describe("runCoordinator loop", () => {
  let home: string;
  const base = () => ({
    membersRoot: home,
    dataHome: home,
    roster: roster("atlas", "vera"),
    task: "ship the feature",
    now: () => NOW,
  });
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "squad-coord-loop-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  test("ends immediately on a done directive (no dispatch)", async () => {
    const d = fakeDispatch();
    const res = await runCoordinator({
      ...base(),
      runAgentTurn: queuedRun(['ok\n{"action":"done","summary":"finished it"}']),
      dispatch: d.fn,
    });
    expect(res.status).toBe("done");
    expect(res.summary).toBe("finished it");
    expect(d.calls).toHaveLength(0);
    expect(res.ledger.transcript.filter((e) => e.kind === "dispatch")).toHaveLength(0);
  });

  test("projects the current plan into dispatched member instructions", async () => {
    const d = fakeDispatch();
    const res = await runCoordinator({
      ...base(),
      runAgentTurn: queuedRun([
        'go\n{"action":"progress","satisfied":false,"progress":true,"next_speaker":"atlas","instruction":"patch the dispatcher","plan":["Confirm the failing dispatch prompt","Project plan rows into member turns"]}',
        'ok\n{"action":"done","summary":"finished it"}',
      ]),
      dispatch: d.fn,
    });

    expect(res.status).toBe("done");
    expect(d.calls).toHaveLength(1);
    expect(d.calls[0]?.instruction).toContain("The manager's current plan");
    expect(d.calls[0]?.instruction).toContain("1. Confirm the failing dispatch prompt");
    expect(d.calls[0]?.instruction).toContain("patch the dispatcher");
    expect(res.ledger.transcript.find((e) => e.kind === "dispatch")?.instruction).toBe(
      "patch the dispatcher",
    );
  });

  test("leaves dispatched member instructions unchanged without a plan", async () => {
    const d = fakeDispatch();
    const res = await runCoordinator({
      ...base(),
      runAgentTurn: queuedRun([
        'go\n{"action":"progress","satisfied":false,"progress":true,"next_speaker":"atlas","instruction":"patch the dispatcher"}',
        'ok\n{"action":"done","summary":"finished it"}',
      ]),
      dispatch: d.fn,
    });

    expect(res.status).toBe("done");
    expect(d.calls).toHaveLength(1);
    expect(d.calls[0]?.instruction).toBe("patch the dispatcher");
    expect(d.calls[0]?.instruction).not.toContain("manager's current plan");
  });

  test("a fresh run persists the configured maxRounds as its round budget", async () => {
    const res = await runCoordinator({
      ...base(),
      runAgentTurn: queuedRun(['ok\n{"action":"done","summary":"finished it"}']),
      dispatch: fakeDispatch().fn,
      limits: { maxRounds: 7 },
    });
    expect(res.ledger.roundBudget).toBe(7);
    expect((await loadLedger(home))?.roundBudget).toBe(7);
  });

  test("preserves a resumed ledger's existing round budget", async () => {
    await saveLedger(home, {
      task: "ship the feature",
      facts: ["already known"],
      plan: [],
      round: 1,
      roundBudget: 4,
      stallCount: 0,
      resetCount: 0,
      status: "active",
      transcript: [],
      createdAt: NOW,
      updatedAt: NOW,
    });

    const res = await runCoordinator({
      ...base(),
      runAgentTurn: queuedRun(['ok\n{"action":"done","summary":"finished it"}']),
      dispatch: fakeDispatch().fn,
      limits: { maxRounds: 9 },
    });
    expect(res.ledger.roundBudget).toBe(4);
  });

  test("pins manager provider/model on the coordinator turn when both are set", async () => {
    const seen: Parameters<NonNullable<RibContext["runAgentTurn"]>>[0][] = [];
    const res = await runCoordinator({
      ...base(),
      runAgentTurn: capturingQueuedRun(['ok\n{"action":"done","summary":"finished it"}'], seen),
      dispatch: fakeDispatch().fn,
      managerProvider: "copilot",
      managerModel: "gpt-5.5",
    });
    expect(res.status).toBe("done");
    expect(seen[0]?.provider).toBe("copilot");
    expect(seen[0]?.model).toBe("gpt-5.5");
  });

  test("treats whitespace-only manager provider as unset (no manager pin)", async () => {
    const seen: Parameters<NonNullable<RibContext["runAgentTurn"]>>[0][] = [];
    const res = await runCoordinator({
      ...base(),
      runAgentTurn: capturingQueuedRun(['ok\n{"action":"done","summary":"finished it"}'], seen),
      dispatch: fakeDispatch().fn,
      managerProvider: "   ",
      managerModel: "gpt-5.5",
    });
    expect(res.status).toBe("done");
    expect(seen[0]?.provider).toBeUndefined();
    expect(seen[0]?.model).toBeUndefined();
  });

  test("does not pin a manager model without a manager provider", async () => {
    const seen: Parameters<NonNullable<RibContext["runAgentTurn"]>>[0][] = [];
    const res = await runCoordinator({
      ...base(),
      runAgentTurn: capturingQueuedRun(['ok\n{"action":"done","summary":"finished it"}'], seen),
      dispatch: fakeDispatch().fn,
      managerModel: "gpt-5.5",
    });
    expect(res.status).toBe("done");
    expect(seen[0]?.provider).toBeUndefined();
    expect(seen[0]?.model).toBeUndefined();
  });

  test("leaves manager turn on harness defaults when manager pin is unset", async () => {
    const seen: Parameters<NonNullable<RibContext["runAgentTurn"]>>[0][] = [];
    const res = await runCoordinator({
      ...base(),
      runAgentTurn: capturingQueuedRun(['ok\n{"action":"done","summary":"finished it"}'], seen),
      dispatch: fakeDispatch().fn,
    });
    expect(res.status).toBe("done");
    expect(seen[0]?.provider).toBeUndefined();
    expect(seen[0]?.model).toBeUndefined();
  });

  test("grounds the coordinator prompt when a project is bound", async () => {
    const seen: Parameters<NonNullable<RibContext["runAgentTurn"]>>[0][] = [];
    const res = await runCoordinator({
      ...base(),
      project: { id: "p1", name: "repo-one", rootPath: "/workspace/repo-one" },
      runAgentTurn: capturingQueuedRun(['ok\n{"action":"done","summary":"finished it"}'], seen),
      dispatch: fakeDispatch().fn,
    });
    expect(res.status).toBe("done");
    expect(seen[0]?.prompt).toContain('Bound project: "repo-one"');
    expect(seen[0]?.prompt).toContain("repository root: /workspace/repo-one");
    expect(seen[0]?.prompt).toMatch(/do NOT .*search .*for any other repository/i);
  });

  test("omits the project grounding block when no project is bound", async () => {
    const seen: Parameters<NonNullable<RibContext["runAgentTurn"]>>[0][] = [];
    const res = await runCoordinator({
      ...base(),
      runAgentTurn: capturingQueuedRun(['ok\n{"action":"done","summary":"finished it"}'], seen),
      dispatch: fakeDispatch().fn,
    });
    expect(res.status).toBe("done");
    expect(seen[0]?.prompt).not.toContain("GROUNDING:");
    expect(seen[0]?.prompt).not.toContain("Bound project:");
    expect(seen[0]?.prompt).not.toMatch(/do NOT .*search .*for any other repository/i);
  });

  test("dispatches the next step then ends, folding the synthesis into facts", async () => {
    const d = fakeDispatch("built it");
    const res = await runCoordinator({
      ...base(),
      runAgentTurn: queuedRun([
        'go\n{"action":"progress","satisfied":false,"progress":true,"next_speaker":"atlas","instruction":"build X","facts":["uses bun"]}',
        'done\n{"action":"done","summary":"shipped"}',
      ]),
      dispatch: d.fn,
    });
    expect(res.status).toBe("done");
    expect(d.calls).toEqual([{ members: ["atlas"], instruction: "build X" }]);
    expect(res.ledger.facts).toContain("uses bun");
    expect(res.ledger.facts.some((f) => f.includes("built it"))).toBe(true);
  });

  test("folds member turn failures when every dispatch reply is unusable", async () => {
    const dispatch = async (_members: Member[], instruction: string): Promise<DispatchOutcome> => ({
      task: instruction,
      perMember: [
        {
          slug: "atlas",
          name: "atlas",
          status: "error",
          text: "",
          error: "provider exploded",
        },
      ],
      notes: [],
    });

    const res = await runCoordinator({
      ...base(),
      runAgentTurn: queuedRun([
        'go\n{"action":"progress","satisfied":false,"progress":true,"next_speaker":"atlas","instruction":"build X"}',
        'done\n{"action":"done","summary":"shipped"}',
      ]),
      dispatch,
    });
    const entry = res.ledger.transcript.find((e) => e.kind === "dispatch");
    expect(entry?.text).toContain("turn failed");
    expect(entry?.text).toContain("provider exploded");
  });

  test("marks the turn in flight before the execute arm and clears it on the final ledger", async () => {
    // The marker is persisted just BEFORE the execute arm runs, so the injected dispatch seam
    // (awaited by the loop) can read the saved ledger and observe the in-flight state.
    const seen: CoordinatorLedger["inFlight"][] = [];
    const capturingDispatch = async (
      _members: Member[],
      instruction: string,
    ): Promise<DispatchOutcome> => {
      seen.push((await loadLedger(home))?.inFlight);
      return { task: instruction, perMember: [], synthesis: "did it", notes: [] };
    };
    const res = await runCoordinator({
      ...base(),
      runAgentTurn: queuedRun([
        'go\n{"action":"progress","satisfied":false,"progress":true,"next_speaker":"atlas","instruction":"build X"}',
        'done\n{"action":"done","summary":"shipped"}',
      ]),
      dispatch: capturingDispatch,
    });
    expect(res.status).toBe("done");
    // At least one persisted state during the run carried the in-flight marker.
    const marked = seen.find((f) => f !== undefined);
    expect(marked).toBeDefined();
    expect(marked?.speaker).toBe("atlas");
    expect(marked?.round).toBe(0);
    expect(marked?.action).toBe("working");
    // The completed run has nothing in flight — in memory and on disk.
    expect(res.ledger.inFlight).toBeUndefined();
    expect((await loadLedger(home))?.inFlight).toBeUndefined();
  });

  test("invokes the publish seam after each ledger persist (per-round liveness)", async () => {
    let publishCount = 0;
    const res = await runCoordinator({
      ...base(),
      runAgentTurn: queuedRun([
        'go\n{"action":"progress","satisfied":false,"progress":true,"next_speaker":"atlas","instruction":"build X","facts":["uses bun"]}',
        'done\n{"action":"done","summary":"shipped"}',
      ]),
      dispatch: fakeDispatch("built it").fn,
      publish: () => {
        publishCount += 1;
      },
    });
    expect(res.status).toBe("done");
    // One persist closes the dispatch round; one persists the terminal done state.
    expect(publishCount).toBeGreaterThanOrEqual(2);
    expect(publishCount).toBeGreaterThanOrEqual(res.rounds);
  });

  test("a rejecting publish seam never breaks the run (best-effort)", async () => {
    const res = await runCoordinator({
      ...base(),
      runAgentTurn: queuedRun([
        'go\n{"action":"progress","satisfied":false,"progress":true,"next_speaker":"atlas","instruction":"build X"}',
        'done\n{"action":"done","summary":"shipped"}',
      ]),
      dispatch: fakeDispatch("built it").fn,
      publish: async () => {
        throw new Error("publish boom");
      },
    });
    expect(res.status).toBe("done");
    expect(res.summary).toBe("shipped");
  });

  test("publishes on a non-done terminal persist (max-rounds ceiling)", async () => {
    let publishCount = 0;
    const res = await runCoordinator({
      ...base(),
      // Never satisfied but always names a step, so the loop dispatches each round until the
      // ceiling persists the max-rounds terminal — a persist path distinct from done.
      runAgentTurn: queuedRun([
        'go\n{"action":"progress","satisfied":false,"progress":true,"next_speaker":"atlas","instruction":"keep going"}',
      ]),
      dispatch: fakeDispatch().fn,
      limits: { maxRounds: 2, maxStall: 99, maxResets: 99 },
      publish: () => {
        publishCount += 1;
      },
    });
    expect(res.status).toBe("max-rounds");
    // Two dispatch-round persists + the terminal max-rounds persist.
    expect(publishCount).toBeGreaterThanOrEqual(3);
  });

  test("a re-plan is recorded, then exhausted resets give up", async () => {
    const d = fakeDispatch();
    const res = await runCoordinator({
      ...base(),
      runAgentTurn: queuedRun([
        'stuck\n{"action":"progress","satisfied":false,"in_loop":true,"progress":false}',
      ]),
      dispatch: d.fn,
      limits: { maxRounds: 10, maxStall: 1, maxResets: 1 },
    });
    expect(res.status).toBe("gave-up");
    expect(res.ledger.status).toBe("gave-up");
    expect(res.ledger.transcript.some((e) => e.kind === "replan")).toBe(true);
  });

  test("sweeps the abandoned plan's steps to failed before a re-plan", async () => {
    const d = fakeDispatch();
    const res = await runCoordinator({
      ...base(),
      // Every round stalls but still names a step to run, so round 0 executes a dispatch
      // and round 1 crosses maxStall and re-plans — leaving an attempted step to sweep.
      runAgentTurn: queuedRun([
        'stuck\n{"action":"progress","satisfied":false,"in_loop":true,"progress":false,"next_speaker":"atlas","instruction":"do X"}',
      ]),
      dispatch: d.fn,
      limits: { maxRounds: 10, maxStall: 2, maxResets: 1 },
    });
    expect(res.status).toBe("gave-up");
    // The round-0 dispatch was recorded as a failed-and-abandoned step, attributed to its member.
    expect(res.ledger.failedSteps).toContain("atlas: do X");
    // The sweep is observable in the transcript, and it precedes the re-plan it guards.
    const failedIdx = res.ledger.transcript.findIndex((e) => e.kind === "failed");
    const replanIdx = res.ledger.transcript.findIndex((e) => e.kind === "replan");
    expect(failedIdx).toBeGreaterThanOrEqual(0);
    expect(replanIdx).toBeGreaterThanOrEqual(0);
    expect(failedIdx).toBeLessThan(replanIdx);
  });

  test("a re-plan rebuilds the Task Ledger: clears the abandoned plan, keeps verified facts", async () => {
    const d = fakeDispatch("a finding");
    const res = await runCoordinator({
      ...base(),
      // Round 0 sets a plan and executes; later rounds stall without restating it, so the
      // re-plan must be what tears the stale plan down (nothing else clears it afterward).
      runAgentTurn: queuedRun([
        'plan\n{"action":"progress","satisfied":false,"in_loop":true,"progress":false,"next_speaker":"atlas","instruction":"do X","plan":["old A","old B"]}',
        'stuck\n{"action":"progress","satisfied":false,"in_loop":true,"progress":false,"next_speaker":"atlas","instruction":"do X"}',
      ]),
      dispatch: d.fn,
      limits: { maxRounds: 10, maxStall: 2, maxResets: 1 },
    });
    expect(res.status).toBe("gave-up");
    // The abandoned plan was rebuilt from scratch — not left anchoring the manager's prompt.
    expect(res.ledger.plan).toEqual([]);
    // Verified findings survive the rebuild; only the plan is torn down.
    expect(res.ledger.facts.some((f) => f.includes("a finding"))).toBe(true);
    expect(res.ledger.failedSteps).toContain("atlas: do X");
  });

  test("the hard round ceiling stops a never-satisfied loop", async () => {
    const d = fakeDispatch();
    const res = await runCoordinator({
      ...base(),
      runAgentTurn: queuedRun([
        'go\n{"action":"progress","satisfied":false,"progress":true,"next_speaker":"atlas","instruction":"keep going"}',
      ]),
      dispatch: d.fn,
      limits: { maxRounds: 3, maxStall: 99, maxResets: 99 },
    });
    expect(res.status).toBe("max-rounds");
    expect(d.calls).toHaveLength(3);
  });

  test("max-rounds persists a TERMINAL ledger so a same-task re-run starts fresh", async () => {
    const progress =
      'go\n{"action":"progress","satisfied":false,"progress":true,"next_speaker":"atlas","instruction":"keep going"}';
    const limits = { maxRounds: 2, maxStall: 99, maxResets: 99 };
    const first = await runCoordinator({
      ...base(),
      runAgentTurn: queuedRun([progress]),
      dispatch: fakeDispatch().fn,
      limits,
    });
    expect(first.status).toBe("max-rounds");
    // The ledger is persisted terminal, not left "active" at the ceiling.
    expect((await loadLedger(home))?.status).toBe("max-rounds");
    // A same-task re-run does NOT resume the ceiling-hit ledger — it runs turns again
    // rather than instantly short-circuiting to a stale max-rounds with zero turns.
    const d2 = fakeDispatch();
    const second = await runCoordinator({
      ...base(),
      runAgentTurn: queuedRun([progress]),
      dispatch: d2.fn,
      limits,
    });
    expect(second.status).toBe("max-rounds");
    expect(d2.calls.length).toBeGreaterThan(0);
  });

  test("does not resume a same-named task bound to a different project", async () => {
    // An active ledger for this task under project A.
    await saveLedger(home, {
      task: "ship the feature",
      projectId: "proj-A",
      facts: ["stale fact from A"],
      plan: ["A plan"],
      round: 1,
      stallCount: 0,
      resetCount: 0,
      status: "active",
      transcript: [],
      createdAt: NOW,
      updatedAt: NOW,
    });
    // Re-running the same task bound to project B must start fresh, not inherit A's
    // facts/plan while the code arm would confine edits to B.
    const res = await runCoordinator({
      ...base(),
      project: { id: "proj-B", name: "repoB", rootPath: "/repoB" },
      runAgentTurn: queuedRun(['done\n{"action":"done","summary":"fresh"}']),
      dispatch: fakeDispatch().fn,
    });
    expect(res.ledger.facts).not.toContain("stale fact from A");
    expect(res.summary).toBe("fresh");
  });

  test("recalls prior decisions into the prompt and reflects the outcome on done", async () => {
    const prompts: string[] = [];
    const writebacks: WritebackRequest[] = [];
    const memory: MemoryTools = {
      recall: async (): Promise<RecallResponse> => ({
        schemaVersion: RECALL_RESPONSE_SCHEMA_VERSION,
        requestId: "r",
        items: [
          {
            memoryId: "m1",
            type: "decision",
            summary: "headline",
            content: "always run bun test before opening a PR",
            provenance: "generated",
            usePolicy: {
              canUseAsInstruction: false,
              canUseAsEvidence: true,
              requiresUserConfirmation: false,
              doNotInjectAutomatically: false,
            },
            scope: { visibility: "project", projectId: "p1" },
            sourceRefs: [],
            artifacts: [],
            createdAt: NOW,
            rankingScore: 0.9,
          },
        ],
        trace: { traceId: "t", returned: 1 },
      }),
      writeback: async (req): Promise<WritebackResponse> => {
        writebacks.push(req);
        return {
          schemaVersion: WRITEBACK_RESPONSE_SCHEMA_VERSION,
          written: [{ memoryId: "w1", idempotencyKey: req.idempotencyKey }],
          blocked: [],
          deduped: [],
        };
      },
    };
    const run: NonNullable<RibContext["runAgentTurn"]> = (req) => {
      prompts.push(req.prompt ?? "");
      return {
        stream: oneShot(),
        result: Promise.resolve({
          status: "ok" as const,
          text: 'done\n{"action":"done","summary":"shipped it"}',
        }),
      };
    };
    const res = await runCoordinator({
      ...base(),
      project: { id: "p1", name: "repo", rootPath: "/repo" },
      runAgentTurn: run,
      dispatch: fakeDispatch().fn,
      getMemory: () => memory,
    });
    expect(res.status).toBe("done");
    // Recall folded the prior decision's CONTENT (the substance, not the headline) into
    // the coordinator's grounding.
    expect(prompts[0]).toContain("[recalled decision] always run bun test before opening a PR");
    // The completed outcome was written back as one governed decision row.
    expect(writebacks).toHaveLength(1);
    expect(writebacks[0]?.memories[0]?.type).toBe("decision");
    expect(writebacks[0]?.scope?.projectId).toBe("p1");
    expect(res.ledger.transcript.some((e) => e.text.includes("[memory] recorded"))).toBe(true);
  });

  test("distills the completed run into the governed decision (lesson content, not the raw summary)", async () => {
    const writebacks: WritebackRequest[] = [];
    const res = await runCoordinator({
      ...base(),
      project: { id: "p1", name: "repo", rootPath: "/repo" },
      runAgentTurn: queuedRun(['done\n{"action":"done","summary":"shipped it"}']),
      dispatch: fakeDispatch().fn,
      getMemory: () => capturingMemory(writebacks),
      distill: async () => ({
        kind: "lesson",
        headline: "Bun is the runtime",
        content: "This repo builds with bun; run bun test before a PR.",
      }),
    });
    expect(res.status).toBe("done");
    expect(writebacks).toHaveLength(1);
    const draft = writebacks[0]?.memories[0];
    expect(draft?.summary).toBe("Bun is the runtime");
    expect(draft?.content).toBe("This repo builds with bun; run bun test before a PR.");
    expect(
      res.ledger.transcript.some((e) => e.text.includes("recorded a distilled decision")),
    ).toBe(true);
  });

  test("abstains on a run with no durable lesson — nothing is written (the pollution gate)", async () => {
    const writebacks: WritebackRequest[] = [];
    const res = await runCoordinator({
      ...base(),
      project: { id: "p1", name: "repo", rootPath: "/repo" },
      runAgentTurn: queuedRun(['done\n{"action":"done","summary":"meh"}']),
      dispatch: fakeDispatch().fn,
      getMemory: () => capturingMemory(writebacks),
      distill: async () => ({ kind: "abstain" }),
    });
    expect(res.status).toBe("done");
    expect(writebacks).toHaveLength(0); // a confused run does not pollute the ledger
    expect(res.ledger.transcript.some((e) => e.text.includes("no durable decision"))).toBe(true);
  });

  test("a distilled lesson the store rejects (deduped/blocked) is noted, not silently dropped", async () => {
    const writebacks: WritebackRequest[] = [];
    const res = await runCoordinator({
      ...base(),
      project: { id: "p1", name: "repo", rootPath: "/repo" },
      runAgentTurn: queuedRun(['done\n{"action":"done","summary":"shipped it"}']),
      dispatch: fakeDispatch().fn,
      getMemory: () => capturingMemory(writebacks, [], false), // writeback persists nothing
      distill: async () => ({ kind: "lesson", headline: "H", content: "L is durable" }),
    });
    expect(res.status).toBe("done");
    expect(writebacks).toHaveLength(1); // it attempted the write
    expect(
      res.ledger.transcript.some((e) => e.text.includes("not recorded (deduped or blocked)")),
    ).toBe(true);
  });

  test("an abort landing during the distill turn suppresses the writeback (no mutation after abort)", async () => {
    const writebacks: WritebackRequest[] = [];
    const ac = new AbortController();
    const res = await runCoordinator({
      ...base(),
      project: { id: "p1", name: "repo", rootPath: "/repo" },
      runAgentTurn: queuedRun(['done\n{"action":"done","summary":"shipped it"}']),
      dispatch: fakeDispatch().fn,
      abortSignal: ac.signal,
      getMemory: () => capturingMemory(writebacks),
      // Model the operator aborting mid-distill: the turn resolves unavailable, but the loop
      // must re-check abort before the raw fallback rather than write memory during teardown.
      distill: async () => {
        ac.abort();
        return { kind: "unavailable" };
      },
    });
    expect(res.status).toBe("done");
    expect(writebacks).toHaveLength(0);
  });

  test("a throwing distill seam falls back to the raw outcome (treated like unavailable)", async () => {
    const writebacks: WritebackRequest[] = [];
    const res = await runCoordinator({
      ...base(),
      project: { id: "p1", name: "repo", rootPath: "/repo" },
      runAgentTurn: queuedRun(['done\n{"action":"done","summary":"shipped it"}']),
      dispatch: fakeDispatch().fn,
      getMemory: () => capturingMemory(writebacks),
      distill: async () => {
        throw new Error("distill boom");
      },
    });
    expect(res.status).toBe("done"); // a throwing distill seam must not crash the completed run
    expect(writebacks).toHaveLength(1); // and still records the raw outcome
    expect(writebacks[0]?.memories[0]?.content).toContain("shipped it");
    expect(
      res.ledger.transcript.some((e) =>
        e.text.includes("recorded the outcome as a governed decision"),
      ),
    ).toBe(true);
  });

  test("falls back to the raw outcome when distillation is unavailable (no regression)", async () => {
    const writebacks: WritebackRequest[] = [];
    const res = await runCoordinator({
      ...base(),
      project: { id: "p1", name: "repo", rootPath: "/repo" },
      runAgentTurn: queuedRun(['done\n{"action":"done","summary":"shipped it"}']),
      dispatch: fakeDispatch().fn,
      getMemory: () => capturingMemory(writebacks),
      distill: async () => ({ kind: "unavailable" }),
    });
    expect(res.status).toBe("done");
    // The validated pre-distillation behavior still holds: a completed run records SOMETHING.
    expect(writebacks).toHaveLength(1);
    expect(writebacks[0]?.memories[0]?.content).toContain("shipped it");
    expect(
      res.ledger.transcript.some((e) =>
        e.text.includes("recorded the outcome as a governed decision"),
      ),
    ).toBe(true);
  });

  test("a raw-fallback outcome the store rejects is noted, not silently dropped", async () => {
    const writebacks: WritebackRequest[] = [];
    const res = await runCoordinator({
      ...base(),
      project: { id: "p1", name: "repo", rootPath: "/repo" },
      runAgentTurn: queuedRun(['done\n{"action":"done","summary":"shipped it"}']),
      dispatch: fakeDispatch().fn,
      getMemory: () => capturingMemory(writebacks, [], false), // store persists nothing
      distill: async () => ({ kind: "unavailable" }),
    });
    expect(res.status).toBe("done");
    expect(writebacks).toHaveLength(1); // the raw fallback attempted the write
    expect(
      res.ledger.transcript.some((e) => e.text.includes("not recorded (deduped or blocked)")),
    ).toBe(true);
  });

  test("an abort during the execute arm folds no junk fact and keeps the round budget intact", async () => {
    const ac = new AbortController();
    // The manager names a dispatch step; the abort lands while the execute arm runs, so the
    // arm returns empty. The loop must break before folding a "(no synthesis)" fact.
    const abortingDispatch = async (
      _members: Member[],
      instruction: string,
    ): Promise<DispatchOutcome> => {
      ac.abort();
      return { task: instruction, perMember: [], notes: [] };
    };
    const res = await runCoordinator({
      ...base(),
      abortSignal: ac.signal,
      runAgentTurn: queuedRun([
        'go\n{"action":"progress","satisfied":false,"progress":true,"next_speaker":"atlas","instruction":"build X"}',
      ]),
      dispatch: abortingDispatch,
    });
    expect(res.status).toBe("aborted");
    expect(res.ledger.round).toBe(0); // the aborted round did not advance
    expect(res.ledger.facts.some((f) => f.includes("(no synthesis)"))).toBe(false);
    expect(res.ledger.transcript.some((e) => e.kind === "dispatch")).toBe(false);
    expect(res.ledger.inFlight).toBeUndefined(); // the cancelled turn's card is cleared
    // The abort persists at round 0 with the in-flight marker cleared (a connected client stops
    // seeing a "now executing" card), no junk fact, and no dispatch entry — so a resume re-runs
    // round 0, budget intact.
    const persisted = await loadLedger(home);
    expect(persisted?.status).toBe("aborted");
    expect(persisted?.inFlight).toBeUndefined();
    expect(persisted?.round).toBe(0);
    expect(persisted?.facts.some((f) => f.includes("(no synthesis)"))).toBe(false);
    expect(persisted?.transcript.some((e) => e.kind === "dispatch")).toBe(false);
  });

  test("compiles served-provider provenance from the code and dispatch steps", async () => {
    const team: Member[] = [
      {
        slug: "atlas",
        name: "atlas",
        role: "Engineer",
        charter: "x",
        status: "active",
        tools: ["code", "read"],
      },
      {
        slug: "vera",
        name: "vera",
        role: "Reviewer",
        charter: "x",
        status: "active",
        tools: ["read"],
      },
    ];
    const res = await runCoordinator({
      ...base(),
      roster: team,
      project: { id: "p1", name: "repo", rootPath: "/repo" },
      runAgentTurn: queuedRun([
        'go\n{"action":"progress","satisfied":false,"progress":true,"next_speaker":"atlas","instruction":"build X","mode":"code"}',
        'go\n{"action":"progress","satisfied":false,"progress":true,"next_speaker":"vera","instruction":"review X"}',
        'done\n{"action":"done","summary":"shipped"}',
      ]),
      // Atlas codes on claude; Vera reviews on copilot — the mixed-provider story made visible.
      dispatch: async (members, instruction): Promise<DispatchOutcome> => ({
        task: instruction,
        perMember: members.map((m) => ({
          slug: m.slug,
          name: m.name,
          status: "ok" as const,
          text: "looks good",
          providerId: "copilot",
        })),
        synthesis: "reviewed",
        notes: [],
      }),
      code: async () => ({ status: "ok" as const, text: "edited files", providerId: "claude" }),
    });
    expect(res.status).toBe("done");
    expect(res.provenance).toContain("atlas (claude) coded");
    expect(res.provenance).toContain("vera (copilot) contributed");
    expect(res.ledger.transcript.find((e) => e.kind === "code")?.provider).toBe("claude");
    expect(res.ledger.transcript.find((e) => e.kind === "dispatch")?.provider).toBe("copilot");
  });

  test("captures tool traces, usage, timing, and at-stamps on ledger entries (#113)", async () => {
    const team: Member[] = [
      {
        slug: "atlas",
        name: "atlas",
        role: "Engineer",
        charter: "x",
        status: "active",
        tools: ["code", "read"],
      },
    ];
    let codeOnTool: unknown;
    const res = await runCoordinator({
      ...base(),
      roster: team,
      project: { id: "p1", name: "repo", rootPath: "/repo" },
      runAgentTurn: queuedRun([
        'go\n{"action":"progress","satisfied":false,"progress":true,"next_speaker":"atlas","instruction":"build X","mode":"code"}',
        'ask\n{"action":"progress","satisfied":false,"progress":true,"next_speaker":"atlas","instruction":"summarize"}',
        'done\n{"action":"done","summary":"shipped"}',
      ]),
      code: async (_member: Member, _instruction: string, onTool?: unknown) => {
        codeOnTool = onTool;
        return {
          status: "ok" as const,
          text: "edited files",
          providerId: "claude",
          tools: [{ name: "Edit", target: "src/a.ts", ok: true }],
          usage: { inputTokens: 900, outputTokens: 120 },
          durationMs: 4200,
        };
      },
      dispatch: async (members, instruction): Promise<DispatchOutcome> => ({
        task: instruction,
        perMember: members.map((m) => ({
          slug: m.slug,
          name: m.name,
          status: "ok" as const,
          text: "summary text",
          durationMs: 800,
          tools: [{ name: "Read", target: "README.md", ok: true }],
        })),
        notes: [],
        usage: { inputTokens: 300, outputTokens: 40 },
      }),
    });
    expect(res.status).toBe("done");
    expect(typeof codeOnTool).toBe("function");
    const codeEntry = res.ledger.transcript.find((e) => e.kind === "code");
    expect(codeEntry?.tools).toEqual([{ name: "Edit", target: "src/a.ts", ok: true }]);
    expect(codeEntry?.usage).toEqual({ inputTokens: 900, outputTokens: 120 });
    expect(codeEntry?.durationMs).toBe(4200);
    expect(codeEntry?.outcome).toBeUndefined();
    expect(codeEntry?.at).toBe(NOW);
    const dispatchEntry = res.ledger.transcript.find((e) => e.kind === "dispatch");
    expect(dispatchEntry?.usage).toEqual({ inputTokens: 300, outputTokens: 40 });
    expect(dispatchEntry?.tools).toEqual([{ name: "Read", target: "README.md", ok: true }]);
    expect(dispatchEntry?.durationMs).toBe(800);
    const coordEntry = res.ledger.transcript.find((e) => e.kind === "coordinator");
    expect(coordEntry?.at).toBe(NOW);
  });

  test("surfaces timed-out code turns in the ledger and standup prompt", async () => {
    const team: Member[] = [
      {
        slug: "atlas",
        name: "atlas",
        role: "Engineer",
        charter: "x",
        status: "active",
        tools: ["code", "read"],
      },
    ];
    const seen: Parameters<NonNullable<RibContext["runAgentTurn"]>>[0][] = [];
    const res = await runCoordinator({
      ...base(),
      roster: team,
      project: { id: "p1", name: "repo", rootPath: "/repo" },
      runAgentTurn: capturingQueuedRun(
        [
          'go\n{"action":"progress","satisfied":false,"progress":true,"next_speaker":"atlas","instruction":"build X","mode":"code"}',
          'done\n{"action":"done","summary":"shipped"}',
        ],
        seen,
      ),
      code: async () => ({
        status: "timeout" as const,
        text: "…Typec",
        error: "agent turn exceeded 240000ms",
        durationMs: 240000,
      }),
      dispatch: fakeDispatch("RAI VERDICT: PASS\nno blocking defect found").fn,
    });

    const codeEntry = res.ledger.transcript.find((e) => e.kind === "code");
    expect(res.status).toBe("done");
    expect(codeEntry?.outcome).toBe("timeout");
    expect(seen[1]?.prompt).toContain(
      "atlas coded: agent turn exceeded 240000ms [timed out after 240s — output truncated]",
    );
  });

  const coder = (): Member[] => [
    {
      slug: "atlas",
      name: "atlas",
      role: "Engineer",
      charter: "x",
      status: "active",
      tools: ["code", "read"],
    },
  ];
  const fakeExec = (exitCode: number, out = ""): RibExec => ({
    runJSON: async () => ({ ok: false as const, error: "unused", code: null }),
    runText: async (_cmd, args) => {
      if (args[0] === "write-tree") return { ok: true as const, data: "deadbeef", exitCode: 0 };
      return { ok: true as const, data: out, exitCode };
    },
  });
  const fakeExecByCommand = (
    results: Record<string, { exitCode: number; out: string }>,
  ): RibExec => ({
    runJSON: async () => ({ ok: false as const, error: "unused", code: null }),
    runText: async (cmd, args) => {
      if (args[0] === "write-tree") return { ok: true as const, data: "deadbeef", exitCode: 0 };
      if (cmd === "bash" && args[0] === "-c") {
        const result = results[String(args[1])];
        if (result) return { ok: true as const, data: result.out, exitCode: result.exitCode };
      }
      return { ok: true as const, data: "", exitCode: 0 };
    },
  });
  const fakeTouchedTreeExec = (opts: {
    codeNumstat?: string;
    runNumstat?: string;
    status?: string;
    unstagedStat?: string;
    stagedStat?: string;
    failWriteTreeCall?: number;
  }): RibExec => {
    const trees = ["baseline-tree", "before-tree", "after-tree", "current-tree"];
    let writeTreeCalls = 0;
    return {
      runJSON: async () => ({ ok: false as const, error: "unused", code: null }),
      runText: async (cmd, args) => {
        if (cmd !== "git") return { ok: true as const, data: "", exitCode: 0 };
        if (args[0] === "add") return { ok: true as const, data: "", exitCode: 0 };
        if (args[0] === "write-tree") {
          writeTreeCalls += 1;
          if (opts.failWriteTreeCall === writeTreeCalls) {
            return { ok: false as const, error: "write-tree failed", code: 128 };
          }
          return {
            ok: true as const,
            data: trees[Math.min(writeTreeCalls - 1, trees.length - 1)] ?? "current-tree",
            exitCode: 0,
          };
        }
        if (args[0] === "rev-parse") return { ok: true as const, data: "", exitCode: 0 };
        if (args[0] === "status") {
          return { ok: true as const, data: opts.status ?? "", exitCode: 0 };
        }
        if (args[0] === "diff" && args.includes("--numstat")) {
          const from = String(args.at(-2));
          const to = String(args.at(-1));
          const data =
            from === "before-tree" && to === "after-tree"
              ? (opts.codeNumstat ?? "")
              : (opts.runNumstat ?? "");
          return { ok: true as const, data, exitCode: 0 };
        }
        if (args[0] === "diff" && args.includes("--stat")) {
          const data = args.includes("--cached")
            ? (opts.stagedStat ?? "")
            : (opts.unstagedStat ?? "");
          return { ok: true as const, data, exitCode: 0 };
        }
        return { ok: true as const, data: "", exitCode: 0 };
      },
    };
  };
  const fakeConfinementExec = (opts: {
    baselinePaths: readonly string[];
    deletedTreePaths: readonly string[];
    restoredTreePaths?: readonly string[];
  }): { exec: RibExec; restoreCalls: string[][] } => {
    const trees = ["baseline-tree", "before-tree", "deleted-tree", "restored-tree", "current-tree"];
    let writeTreeCalls = 0;
    const restoreCalls: string[][] = [];
    const nul = (paths: readonly string[]) => (paths.length > 0 ? `${paths.join("\0")}\0` : "");
    return {
      restoreCalls,
      exec: {
        runJSON: async () => ({ ok: false as const, error: "unused", code: null }),
        runText: async (cmd, args) => {
          if (cmd !== "git") return { ok: true as const, data: "", exitCode: 0 };
          if (args[0] === "add") return { ok: true as const, data: "", exitCode: 0 };
          if (args[0] === "write-tree") {
            writeTreeCalls += 1;
            return {
              ok: true as const,
              data: trees[Math.min(writeTreeCalls - 1, trees.length - 1)] ?? "current-tree",
              exitCode: 0,
            };
          }
          if (args[0] === "rev-parse") return { ok: true as const, data: "", exitCode: 0 };
          if (args[0] === "ls-tree") {
            const tree = String(args.at(-1));
            const paths =
              tree === "baseline-tree"
                ? opts.baselinePaths
                : tree === "deleted-tree"
                  ? opts.deletedTreePaths
                  : (opts.restoredTreePaths ?? opts.deletedTreePaths);
            return { ok: true as const, data: nul(paths), exitCode: 0 };
          }
          if (args[0] === "restore") {
            restoreCalls.push(args.map(String));
            return { ok: true as const, data: "", exitCode: 0 };
          }
          if (args[0] === "status" || args[0] === "diff") {
            return { ok: true as const, data: "", exitCode: 0 };
          }
          return { ok: true as const, data: "", exitCode: 0 };
        },
      },
    };
  };
  const codeThenDone = () =>
    queuedRun([
      'go\n{"action":"progress","satisfied":false,"progress":true,"next_speaker":"atlas","instruction":"edit","mode":"code"}',
      'done\n{"action":"done","summary":"shipped"}',
    ]);

  test("code touched stats include committed end-of-turn changes", async () => {
    const res = await runCoordinator({
      ...base(),
      roster: coder(),
      project: { id: "p1", name: "repo", rootPath: "/repo" },
      runAgentTurn: codeThenDone(),
      code: async () => ({ status: "ok" as const, text: "edited" }),
      dispatch: fakeDispatch("RAI VERDICT: PASS\nno blocking defect found").fn,
      getExec: fakeTouchedTreeExec({
        codeNumstat: "195\t0\tsrc/committed.ts\n",
        status: "",
        unstagedStat: "",
        stagedStat: "",
      }),
    });

    const codeEntry = res.ledger.transcript.find((e) => e.kind === "code");
    expect(res.status).toBe("done");
    expect(codeEntry?.touched).toEqual({ files: 1, insertions: 195, deletions: 0 });
  });

  test("code touched stats still include uncommitted changes", async () => {
    const res = await runCoordinator({
      ...base(),
      roster: coder(),
      project: { id: "p1", name: "repo", rootPath: "/repo" },
      runAgentTurn: codeThenDone(),
      code: async () => ({ status: "ok" as const, text: "edited" }),
      dispatch: fakeDispatch("RAI VERDICT: PASS\nno blocking defect found").fn,
      getExec: fakeTouchedTreeExec({
        codeNumstat: "195\t0\tsrc/uncommitted.ts\n",
        status: " M src/uncommitted.ts",
        unstagedStat: " 1 file changed, 195 insertions(+)",
      }),
    });

    const codeEntry = res.ledger.transcript.find((e) => e.kind === "code");
    expect(res.status).toBe("done");
    expect(codeEntry?.touched).toEqual({ files: 1, insertions: 195, deletions: 0 });
  });

  test("code touched stats stay zero when trees are unchanged", async () => {
    const res = await runCoordinator({
      ...base(),
      roster: coder(),
      project: { id: "p1", name: "repo", rootPath: "/repo" },
      runAgentTurn: codeThenDone(),
      code: async () => ({ status: "ok" as const, text: "edited" }),
      dispatch: fakeDispatch("RAI VERDICT: PASS\nno blocking defect found").fn,
      getExec: fakeTouchedTreeExec({ codeNumstat: "" }),
    });

    const codeEntry = res.ledger.transcript.find((e) => e.kind === "code");
    expect(res.status).toBe("done");
    expect(codeEntry?.touched).toEqual({ files: 0, insertions: 0, deletions: 0 });
  });

  test("code touched stats fall back when pre-turn capture fails", async () => {
    const res = await runCoordinator({
      ...base(),
      roster: coder(),
      project: { id: "p1", name: "repo", rootPath: "/repo" },
      runAgentTurn: codeThenDone(),
      code: async () => ({ status: "ok" as const, text: "edited" }),
      dispatch: fakeDispatch("RAI VERDICT: PASS\nno blocking defect found").fn,
      getExec: fakeTouchedTreeExec({
        failWriteTreeCall: 2,
        status: " M src/fallback.ts",
        unstagedStat: " 1 file changed, 7 insertions(+), 2 deletions(-)",
      }),
    });

    const codeEntry = res.ledger.transcript.find((e) => e.kind === "code");
    expect(res.status).toBe("done");
    expect(codeEntry?.touched).toEqual({ files: 1, insertions: 7, deletions: 2 });
  });

  test("code arm restores baseline files deleted by a code turn", async () => {
    const { exec, restoreCalls } = fakeConfinementExec({
      baselinePaths: ["operator.txt"],
      deletedTreePaths: [],
      restoredTreePaths: ["operator.txt"],
    });
    const res = await runCoordinator({
      ...base(),
      roster: coder(),
      project: { id: "p1", name: "repo", rootPath: "/repo" },
      runAgentTurn: codeThenDone(),
      code: async () => ({ status: "ok" as const, text: "removed stray file" }),
      dispatch: fakeDispatch("RAI VERDICT: PASS\nno blocking defect found").fn,
      getExec: exec,
    });

    expect(res.status).toBe("done");
    expect(restoreCalls).toEqual([["restore", "--source", "baseline-tree", "--", "operator.txt"]]);
    const entry = res.ledger.transcript.find((e) => e.kind === "code");
    expect(entry?.text).toContain("delete confinement restored baseline file(s)");
    expect(entry?.text).toContain("operator.txt");
  });

  test("code arm allows deleting a file created during the run", async () => {
    const { exec, restoreCalls } = fakeConfinementExec({
      baselinePaths: ["operator.txt"],
      deletedTreePaths: ["operator.txt"],
    });
    const res = await runCoordinator({
      ...base(),
      roster: coder(),
      project: { id: "p1", name: "repo", rootPath: "/repo" },
      runAgentTurn: codeThenDone(),
      code: async () => ({ status: "ok" as const, text: "created then removed temp.txt" }),
      dispatch: fakeDispatch("RAI VERDICT: PASS\nno blocking defect found").fn,
      getExec: exec,
    });

    expect(res.status).toBe("done");
    expect(restoreCalls).toEqual([]);
    const entry = res.ledger.transcript.find((e) => e.kind === "code");
    expect(entry?.text).not.toContain("delete confinement");
  });

  test("default code arm defers the full matrix only when verify is configured", async () => {
    const withVerifySeen: Parameters<NonNullable<RibContext["runAgentTurn"]>>[0][] = [];
    const withVerify = await runCoordinator({
      ...base(),
      roster: coder(),
      project: { id: "p1", name: "repo", rootPath: "/repo" },
      runAgentTurn: capturingQueuedRun(
        [
          'go\n{"action":"progress","satisfied":false,"progress":true,"next_speaker":"atlas","instruction":"edit","mode":"code"}',
          "edited files",
          'done\n{"action":"done","summary":"shipped"}',
        ],
        withVerifySeen,
      ),
      dispatch: fakeDispatch("RAI VERDICT: PASS\nno blocking defect found").fn,
      getExec: fakeExec(0, "all good"),
      verify: ["bun run test"],
    });
    expect(withVerify.status).toBe("done");
    const withVerifyCodePrompt = withVerifySeen.find((req) => req.cwd === "/repo")?.prompt;
    expect(withVerifyCodePrompt).toMatch(/do not run.*full.*matrix/i);
    expect(withVerifyCodePrompt).toMatch(/verify gate owns it/i);
    expect(withVerifyCodePrompt).toMatch(/commit your work early/i);

    const withoutVerifySeen: Parameters<NonNullable<RibContext["runAgentTurn"]>>[0][] = [];
    const withoutVerify = await runCoordinator({
      ...base(),
      roster: coder(),
      project: { id: "p1", name: "repo", rootPath: "/repo" },
      runAgentTurn: capturingQueuedRun(
        [
          'go\n{"action":"progress","satisfied":false,"progress":true,"next_speaker":"atlas","instruction":"edit","mode":"code"}',
          "edited files",
          'done\n{"action":"done","summary":"shipped"}',
        ],
        withoutVerifySeen,
      ),
      dispatch: fakeDispatch("RAI VERDICT: PASS\nno blocking defect found").fn,
      verify: [],
    });
    expect(withoutVerify.status).toBe("done");
    const withoutVerifyCodePrompt = withoutVerifySeen.find((req) => req.cwd === "/repo")?.prompt;
    expect(withoutVerifyCodePrompt).not.toMatch(/full check\/test matrix/i);
    expect(withoutVerifyCodePrompt).not.toMatch(/verify gate owns it/i);
    expect(withoutVerifyCodePrompt).not.toMatch(/commit your work early/i);
  });

  test("verification gate: a configured check must pass before done (green → done)", async () => {
    const res = await runCoordinator({
      ...base(),
      roster: coder(),
      project: { id: "p1", name: "repo", rootPath: "/repo" },
      runAgentTurn: codeThenDone(),
      code: async () => ({ status: "ok" as const, text: "edited" }),
      getExec: fakeExec(0, "all good"),
      verify: ["bun run test"],
    });
    expect(res.status).toBe("done");
    expect(res.ledger.verification?.passed).toBe(true);
    expect(res.ledger.transcript.some((e) => e.kind === "verify")).toBe(true);
  });

  test("verification gate: multi-command verify records mixed per-check results and fails aggregate", async () => {
    const testCommand = "bun test";
    const typecheckCommand = "bun run typecheck";
    const res = await runCoordinator({
      ...base(),
      roster: coder(),
      project: { id: "p1", name: "repo", rootPath: "/repo" },
      runAgentTurn: codeThenDone(),
      code: async () => ({ status: "ok" as const, text: "edited" }),
      dispatch: fakeDispatch("RAI VERDICT: PASS\nno blocking defect found").fn,
      getExec: fakeExecByCommand({
        [testCommand]: { exitCode: 0, out: "tests green" },
        [typecheckCommand]: { exitCode: 2, out: "ts error" },
      }),
      verify: [testCommand, typecheckCommand],
      limits: { maxRounds: 20 },
    });
    expect(res.status).toBe("verification-failed");
    expect(res.ledger.verification?.passed).toBe(false);
    expect(res.ledger.verification?.command).toBe(typecheckCommand);
    expect(res.ledger.verification?.exitCode).toBe(2);
    expect(res.ledger.verification?.summary).toBe("ts error");
    expect(res.ledger.verification?.checks).toEqual([
      { command: testCommand, passed: true, exitCode: 0, summary: "tests green" },
      { command: typecheckCommand, passed: false, exitCode: 2, summary: "ts error" },
    ]);
  });

  test("verification gate: multi-command verify records all-green checks and passes aggregate", async () => {
    const testCommand = "bun test";
    const typecheckCommand = "bun run typecheck";
    const res = await runCoordinator({
      ...base(),
      roster: coder(),
      project: { id: "p1", name: "repo", rootPath: "/repo" },
      runAgentTurn: codeThenDone(),
      code: async () => ({ status: "ok" as const, text: "edited" }),
      dispatch: fakeDispatch("RAI VERDICT: PASS\nno blocking defect found").fn,
      getExec: fakeExecByCommand({
        [testCommand]: { exitCode: 0, out: "tests green" },
        [typecheckCommand]: { exitCode: 0, out: "types green" },
      }),
      verify: [testCommand, typecheckCommand],
    });
    expect(res.status).toBe("done");
    expect(res.ledger.verification?.passed).toBe(true);
    expect(res.ledger.verification?.command).toBe("2 checks");
    expect(res.ledger.verification?.exitCode).toBe(0);
    expect(res.ledger.verification?.summary).toBe("2 checks passed");
    expect(res.ledger.verification?.checks).toEqual([
      { command: testCommand, passed: true, exitCode: 0, summary: "tests green" },
      { command: typecheckCommand, passed: true, exitCode: 0, summary: "types green" },
    ]);
  });

  test("review gate: code changes require a fresh clean project-bound review before done", async () => {
    const d = fakeDispatch("RAI VERDICT: PASS\nno blocking defect found");
    const res = await runCoordinator({
      ...base(),
      roster: coder(),
      project: { id: "p1", name: "repo", rootPath: "/repo" },
      runAgentTurn: codeThenDone(),
      code: async () => ({ status: "ok" as const, text: "edited" }),
      dispatch: d.fn,
    });
    expect(res.status).toBe("done");
    expect(d.calls).toHaveLength(1);
    expect(d.calls[0]?.instruction).toContain("Adversarial review");
    expect(res.ledger.lastCleanReviewRound).toBe(1);
  });

  test("review gate: default dispatch scopes review diff to the run baseline", async () => {
    const memberPrompts: string[] = [];
    let managerTurns = 0;
    const runAgentTurn: NonNullable<RibContext["runAgentTurn"]> = (req) => {
      const prompt = req.prompt ?? "";
      if (prompt.includes("Goal:")) {
        managerTurns += 1;
        const text =
          managerTurns === 1
            ? 'go\n{"action":"progress","satisfied":false,"progress":true,"next_speaker":"atlas","instruction":"edit","mode":"code"}'
            : 'done\n{"action":"done","summary":"shipped"}';
        return { stream: oneShot(), result: Promise.resolve({ status: "ok" as const, text }) };
      }
      memberPrompts.push(prompt);
      return {
        stream: oneShot(),
        result: Promise.resolve({
          status: "ok" as const,
          text: "RAI VERDICT: PASS\nno blocking defect found",
        }),
      };
    };
    let writeTreeCalls = 0;
    const exec: RibExec = {
      runJSON: async () => ({ ok: false as const, error: "unused", code: null }),
      runText: async (cmd, args) => {
        if (cmd !== "git") return { ok: true as const, data: "", exitCode: 0 };
        if (args[0] === "add") return { ok: true as const, data: "", exitCode: 0 };
        if (args[0] === "write-tree") {
          writeTreeCalls += 1;
          return {
            ok: true as const,
            data: writeTreeCalls === 1 ? "baseline-tree" : "current-tree",
            exitCode: 0,
          };
        }
        if (args[0] === "rev-parse") return { ok: true as const, data: "head-sha", exitCode: 0 };
        if (args[0] === "diff" && args.includes("--name-status")) {
          return { ok: true as const, data: "A\tnew.ts\n", exitCode: 0 };
        }
        if (args[0] === "diff" && args.includes("--numstat")) {
          return { ok: true as const, data: "1\t0\tnew.ts\n", exitCode: 0 };
        }
        if (args[0] === "diff" && args.includes("--diff-filter=a")) {
          return { ok: true as const, data: "", exitCode: 0 };
        }
        if (args[0] === "diff" && args.includes("--")) {
          return {
            ok: true as const,
            data:
              "diff --git a/new.ts b/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+export const createdInRun = true;\n",
            exitCode: 0,
          };
        }
        return { ok: true as const, data: "", exitCode: 0 };
      },
    };

    const res = await runCoordinator({
      ...base(),
      roster: coder(),
      project: { id: "p1", name: "repo", rootPath: "/repo" },
      runAgentTurn,
      code: async () => ({ status: "ok" as const, text: "edited" }),
      getExec: exec,
    });

    expect(res.status).toBe("done");
    const reviewPrompt = memberPrompts.find((p) => p.includes("CODE DIFF UNDER REVIEW")) ?? "";
    expect(reviewPrompt).toContain("Run delta (baseline-scoped)");
    expect(reviewPrompt).toContain("new.ts");
    expect(reviewPrompt).toContain("createdInRun");
    expect(reviewPrompt).not.toContain("Untracked (new) files");
  });

  test("review gate: a PASS review attributes the verifying reviewer and provider", async () => {
    const reviewer = "vera";
    const reviewProvider = "reviewProvider";
    const res = await runCoordinator({
      ...base(),
      roster: [
        {
          slug: "atlas",
          name: "atlas",
          role: "Engineer",
          charter: "x",
          status: "active",
          tools: ["code"],
        },
        {
          slug: reviewer,
          name: "Vera",
          role: "Reviewer",
          charter: "x",
          status: "active",
          tools: ["read"],
        },
      ],
      project: { id: "p1", name: "repo", rootPath: "/repo" },
      runAgentTurn: codeThenDone(),
      code: async () => ({ status: "ok" as const, text: "edited" }),
      dispatch: async (members, instruction): Promise<DispatchOutcome> => ({
        task: instruction,
        perMember: members.map((m) => ({
          slug: m.slug,
          name: m.name,
          status: "ok" as const,
          text: "RAI VERDICT: PASS\nno blocking defect found",
          providerId: reviewProvider,
        })),
        notes: [],
      }),
    });

    const verify = res.ledger.transcript.find((e) => e.kind === "verify");
    expect(verify).toMatchObject({
      kind: "verify",
      speaker: reviewer,
      provider: reviewProvider,
      verdict: "pass",
    });
    expect(provenanceLines(res.ledger.transcript)).toContainEqual({
      who: reviewer,
      provider: reviewProvider,
      verb: "reviewed",
    });
  });

  test("review gate: a BLOCK verdict vetoes done", async () => {
    const d = fakeDispatch("RAI VERDICT: BLOCK\nsrc/x.ts:12 unsafe default");
    const res = await runCoordinator({
      ...base(),
      roster: coder(),
      project: { id: "p1", name: "repo", rootPath: "/repo" },
      runAgentTurn: codeThenDone(),
      code: async () => ({ status: "ok" as const, text: "edited" }),
      dispatch: d.fn,
      limits: { maxRounds: 4 },
    });
    expect(res.status).toBe("max-rounds");
    expect(res.ledger.transcript.some((e) => e.kind === "verify" && e.text.includes("BLOCK"))).toBe(
      true,
    );
  });

  test("review gate: a BLOCK review attributes the blocking reviewer", async () => {
    const reviewProvider = "reviewProvider";
    const res = await runCoordinator({
      ...base(),
      roster: [
        {
          slug: "atlas",
          name: "atlas",
          role: "Engineer",
          charter: "x",
          status: "active",
          tools: ["code"],
        },
        {
          slug: "vera",
          name: "vera",
          role: "Reviewer",
          charter: "x",
          status: "active",
          tools: ["read"],
        },
        {
          slug: "noah",
          name: "noah",
          role: "Reviewer",
          charter: "x",
          status: "active",
          tools: ["read"],
        },
      ],
      project: { id: "p1", name: "repo", rootPath: "/repo" },
      runAgentTurn: codeThenDone(),
      code: async () => ({ status: "ok" as const, text: "edited" }),
      dispatch: async (members, instruction): Promise<DispatchOutcome> => ({
        task: instruction,
        perMember: members.map((m) => ({
          slug: m.slug,
          name: m.name,
          status: "ok" as const,
          text:
            m.slug === "noah"
              ? "RAI VERDICT: BLOCK\nsrc/x.ts:12 unsafe default"
              : "RAI VERDICT: PASS\nno blocking defect found",
          providerId: reviewProvider,
        })),
        notes: [],
      }),
      limits: { maxRounds: 4 },
    });

    const block = res.ledger.transcript.find((e) => e.kind === "verify" && e.verdict === "block");
    expect(block).toMatchObject({
      kind: "verify",
      speaker: "noah",
      provider: reviewProvider,
      verdict: "block",
    });
  });

  test("#63: review prompt requires a reproducible defect and a PASS-by-default when unsubstantiated", async () => {
    const d = fakeDispatch("RAI VERDICT: PASS\nno blocking defect found");
    await runCoordinator({
      ...base(),
      roster: coder(),
      project: { id: "p1", name: "repo", rootPath: "/repo" },
      runAgentTurn: codeThenDone(),
      code: async () => ({ status: "ok" as const, text: "edited" }),
      dispatch: d.fn,
    });
    expect(d.calls[0]?.instruction).toMatch(/reproducible/i);
    expect(d.calls[0]?.instruction).toMatch(/cannot identify or substantiate/i);
  });

  test("#92: review prompt carries the consistency + test-adequacy lenses without weakening the grounding", async () => {
    const d = fakeDispatch("RAI VERDICT: PASS\nno blocking defect found");
    await runCoordinator({
      ...base(),
      roster: coder(),
      project: { id: "p1", name: "repo", rootPath: "/repo" },
      runAgentTurn: codeThenDone(),
      code: async () => ({ status: "ok" as const, text: "edited" }),
      dispatch: d.fn,
    });
    const instruction = d.calls[0]?.instruction ?? "";
    expect(instruction).toMatch(/consistency/i);
    expect(instruction).toMatch(/convention the surrounding code already follows/i);
    expect(instruction).toMatch(/test adequacy/i);
    // The lenses must not reopen the #63 over-blocking hole: each still requires a concrete citation.
    expect(instruction).toMatch(/each still requiring a concrete citation/i);
  });

  test("#63: max-rounds with an unresolved BLOCK and a GREEN floor flags an unsubstantiated review", async () => {
    const d = fakeDispatch("RAI VERDICT: BLOCK\nsrc/x.ts:12 unsafe default");
    const res = await runCoordinator({
      ...base(),
      roster: coder(),
      project: { id: "p1", name: "repo", rootPath: "/repo" },
      runAgentTurn: codeThenDone(),
      code: async () => ({ status: "ok" as const, text: "edited" }),
      dispatch: d.fn,
      getExec: fakeExec(0, "all good"),
      verify: ["bun run test"],
      limits: { maxRounds: 4 },
    });
    expect(res.status).toBe("max-rounds");
    // The deterministic floor passed, so the ceiling terminal must name the blocker as an
    // unverified review rather than terminating silently (issue #63).
    expect(res.ledger.summary ?? "").toMatch(/deterministic floor is GREEN/i);
    expect(res.ledger.summary ?? "").toMatch(/unsubstantiated or unverified review/i);
  });

  test("#63: max-rounds with an unresolved BLOCK and a RED floor does not claim the artifact passes", async () => {
    const d = fakeDispatch("RAI VERDICT: BLOCK\nsrc/x.ts:12 unsafe default");
    const res = await runCoordinator({
      ...base(),
      roster: coder(),
      project: { id: "p1", name: "repo", rootPath: "/repo" },
      runAgentTurn: codeThenDone(),
      code: async () => ({ status: "ok" as const, text: "edited" }),
      dispatch: d.fn,
      getExec: fakeExec(1, "1 fail"),
      verify: ["bun run test"],
      limits: { maxRounds: 4 },
    });
    expect(res.status).toBe("max-rounds");
    expect(res.ledger.summary ?? "").toMatch(/RED deterministic check/i);
    expect(res.ledger.summary ?? "").not.toMatch(/passes on its own/i);
  });

  test("#57: identical repeated outcomes give up instead of burning to max-rounds", async () => {
    // The manager always claims progress (never in_loop, never satisfied) and keeps dispatching
    // the same step; the member returns the SAME text every round. Without the deterministic
    // repeat backstop this runs to max-rounds — with it, the run recognizes the loop and gives up.
    const progressDirective =
      'go\n{"action":"progress","satisfied":false,"in_loop":false,"progress":true,"next_speaker":"atlas","instruction":"do the doomed thing"}';
    const res = await runCoordinator({
      ...base(),
      runAgentTurn: queuedRun(Array(20).fill(progressDirective)),
      dispatch: fakeDispatch("identical failing output").fn,
      limits: { maxRounds: 20, maxStall: 2, maxResets: 1 },
    });
    expect(res.status).toBe("gave-up");
    expect(res.rounds).toBeLessThan(20);
  });

  test("review gate: no new code after a clean review does not re-run review", async () => {
    const d = fakeDispatch("RAI VERDICT: PASS\nno blocking defect found");
    let verifyCalls = 0;
    const res = await runCoordinator({
      ...base(),
      roster: coder(),
      project: { id: "p1", name: "repo", rootPath: "/repo" },
      runAgentTurn: codeThenDone(),
      code: async () => ({ status: "ok" as const, text: "edited" }),
      dispatch: d.fn,
      getExec: {
        runJSON: async () => ({ ok: false as const, error: "unused", code: null }),
        runText: async (cmd, args) => {
          if (cmd === "bash") {
            verifyCalls += 1;
            return verifyCalls === 1
              ? { ok: true as const, data: "failing check", exitCode: 1 }
              : { ok: true as const, data: "green now", exitCode: 0 };
          }
          if (args[0] === "write-tree") return { ok: true as const, data: "abc123", exitCode: 0 };
          return { ok: true as const, data: "", exitCode: 0 };
        },
      },
      verify: ["bun run test"],
      limits: { maxRounds: 8 },
    });
    expect(res.status).toBe("done");
    expect(verifyCalls).toBe(2);
    expect(d.calls).toHaveLength(1);
  });

  test("verification gate: a red check vetoes done and terminates verification-failed", async () => {
    const res = await runCoordinator({
      ...base(),
      roster: coder(),
      project: { id: "p1", name: "repo", rootPath: "/repo" },
      // The manager keeps trying to finish; every done attempt re-runs the (still red) check.
      runAgentTurn: codeThenDone(),
      code: async () => ({ status: "ok" as const, text: "edited" }),
      getExec: fakeExec(1, "1 fail\nexpect mismatch"),
      verify: ["bun run test"],
      limits: { maxRounds: 20 },
    });
    expect(res.status).toBe("verification-failed");
    expect(res.ledger.verification?.passed).toBe(false);
    expect(res.ledger.facts.some((f) => f.includes("verification FAILED"))).toBe(true);
  });

  test("change-quality gate: done is vetoed and bounded to change-quality-failed", async () => {
    const seen: Parameters<NonNullable<RibContext["runAgentTurn"]>>[0][] = [];
    const maxRounds = 20;
    const res = await runCoordinator({
      ...base(),
      roster: coder(),
      project: { id: "p1", name: "repo", rootPath: "/repo" },
      runAgentTurn: capturingQueuedRun(
        [
          'go\n{"action":"progress","satisfied":false,"progress":true,"next_speaker":"atlas","instruction":"edit","mode":"code"}',
          'done\n{"action":"done","summary":"shipped"}',
        ],
        seen,
      ),
      code: async () => ({ status: "ok" as const, text: "edited" }),
      dispatch: fakeDispatch("RAI VERDICT: PASS\nno blocking defect found").fn,
      getExec: {
        runJSON: async () => ({ ok: false as const, error: "unused", code: null }),
        runText: async (_cmd, args) => {
          if (args[0] === "write-tree") return { ok: true as const, data: "abc123", exitCode: 0 };
          if (args[0] === "status") {
            return { ok: true as const, data: " M src/coordinator.ts", exitCode: 0 };
          }
          if (args[0] === "diff" && args.includes("--numstat")) {
            return {
              ok: true as const,
              data: "0\t12\ttest/removed.test.ts\n1\t0\tsrc/coordinator.ts\n",
              exitCode: 0,
            };
          }
          if (args[0] === "diff" && args.includes("--unified=0")) {
            return {
              ok: true as const,
              data: "diff --git a/src/coordinator.ts b/src/coordinator.ts\n+++ b/src/coordinator.ts\n@@ -0,0 +1 @@\n+// @ts-ignore temporary\n",
              exitCode: 0,
            };
          }
          return { ok: true as const, data: "", exitCode: 0 };
        },
      },
      limits: { maxRounds },
    });
    const qualityFailures = res.ledger.transcript.filter(
      (e) => e.kind === "verify" && e.text.includes("change-quality FAILED"),
    );
    expect(res.status).toBe("change-quality-failed");
    expect(res.status).not.toBe("max-rounds");
    expect(res.rounds).toBeLessThan(maxRounds);
    expect(seen).toHaveLength(4);
    expect(qualityFailures).toHaveLength(MAX_CHANGE_QUALITY_FAILURES);
    expect(res.ledger.changeQualityFailures).toBe(MAX_CHANGE_QUALITY_FAILURES);
    expect(res.ledger.summary).toContain(
      `change-quality failed after ${MAX_CHANGE_QUALITY_FAILURES} attempts`,
    );
    expect(res.ledger.summary).toContain("net-test-file-removal");
    expect(res.ledger.summary).toContain("added-suppression-comment");
  });

  test("mixed gate failures keep independent caps and terminal attribution", async () => {
    let verifyRuns = 0;
    const res = await runCoordinator({
      ...base(),
      roster: coder(),
      project: { id: "p1", name: "repo", rootPath: "/repo" },
      runAgentTurn: codeThenDone(),
      code: async () => ({ status: "ok" as const, text: "edited" }),
      dispatch: fakeDispatch("RAI VERDICT: PASS\nno blocking defect found").fn,
      getExec: {
        runJSON: async () => ({ ok: false as const, error: "unused", code: null }),
        runText: async (cmd, args) => {
          if (cmd === "bash") {
            verifyRuns += 1;
            return verifyRuns === 1
              ? { ok: true as const, data: "1 fail\nexpect mismatch", exitCode: 1 }
              : { ok: true as const, data: "all good", exitCode: 0 };
          }
          if (args[0] === "write-tree") return { ok: true as const, data: "abc123", exitCode: 0 };
          if (args[0] === "status")
            return { ok: true as const, data: " M src/coordinator.ts", exitCode: 0 };
          if (args[0] === "diff" && args.includes("--numstat")) {
            return {
              ok: true as const,
              data: "0\t12\ttest/removed.test.ts\n",
              exitCode: 0,
            };
          }
          if (args[0] === "diff" && args.includes("--unified=0")) {
            return {
              ok: true as const,
              data: "diff --git a/test/removed.test.ts b/test/removed.test.ts\n--- a/test/removed.test.ts\n+++ /dev/null\n",
              exitCode: 0,
            };
          }
          return { ok: true as const, data: "", exitCode: 0 };
        },
      },
      verify: ["bun run test"],
      limits: { maxRounds: 20 },
    });
    expect(verifyRuns).toBeGreaterThanOrEqual(2);
    expect(res.status).toBe("change-quality-failed");
    expect(res.status).not.toBe("verification-failed");
    expect(res.ledger.verifyFailures).toBe(0);
    expect(res.ledger.changeQualityFailures).toBe(MAX_CHANGE_QUALITY_FAILURES);
    expect(res.ledger.summary).toContain(
      `change-quality failed after ${MAX_CHANGE_QUALITY_FAILURES} attempts`,
    );
    expect(res.ledger.summary).not.toContain("verification failed after");
  });

  const resumedChangeQualityCases = [
    {
      name: "net test-file removal",
      numstat: "0\t12\ttest/removed.test.ts\n1\t0\tsrc/coordinator.ts\n",
      patch:
        "diff --git a/src/coordinator.ts b/src/coordinator.ts\n+++ b/src/coordinator.ts\n@@ -1 +1 @@\n+const keep = true;\n",
      expectedCode: "net-test-file-removal",
    },
    {
      name: "added @ts-ignore suppression",
      numstat: "1\t0\tsrc/coordinator.ts\n",
      patch:
        "diff --git a/src/coordinator.ts b/src/coordinator.ts\n+++ b/src/coordinator.ts\n@@ -0,0 +1 @@\n+// @ts-ignore temporary\n",
      expectedCode: "added-suppression-comment",
    },
  ] as const;

  for (const c of resumedChangeQualityCases) {
    test(`change-quality gate: resumed ledger baseline still blocks ${c.name}`, async () => {
      await saveLedger(home, {
        task: "ship the feature",
        projectId: "p1",
        baselineTree: "baseline-tree",
        facts: ["earlier code change happened before this invocation"],
        plan: [],
        round: 2,
        stallCount: 0,
        resetCount: 0,
        status: "active",
        transcript: [{ round: 1, kind: "code", speaker: "atlas", text: "edited earlier" }],
        lastCodeRound: 1,
        createdAt: NOW,
        updatedAt: NOW,
      });
      let capturedNumstatBaseline: string | undefined;
      const res = await runCoordinator({
        ...base(),
        roster: coder(),
        project: { id: "p1", name: "repo", rootPath: "/repo" },
        runAgentTurn: queuedRun(['done\n{"action":"done","summary":"ship it"}']),
        dispatch: fakeDispatch("RAI VERDICT: PASS\nno blocking defect found").fn,
        getExec: {
          runJSON: async () => ({ ok: false as const, error: "unused", code: null }),
          runText: async (_cmd, args) => {
            if (args[0] === "add") return { ok: true as const, data: "", exitCode: 0 };
            if (args[0] === "write-tree") {
              return { ok: true as const, data: "current-tree", exitCode: 0 };
            }
            if (args[0] === "diff" && args.includes("--numstat")) {
              capturedNumstatBaseline = args[3];
              return { ok: true as const, data: c.numstat, exitCode: 0 };
            }
            if (args[0] === "diff" && args.includes("--unified=0")) {
              return { ok: true as const, data: c.patch, exitCode: 0 };
            }
            return { ok: true as const, data: "", exitCode: 0 };
          },
        },
        limits: { maxRounds: 20 },
      });
      expect(capturedNumstatBaseline).toBe("baseline-tree");
      expect(res.status).toBe("change-quality-failed");
      expect(res.ledger.summary).toContain(c.expectedCode);
    });
  }

  test("verification gate: no verify commands skips command verification (quality gate may still run)", async () => {
    let ranVerifyCommand = false;
    const res = await runCoordinator({
      ...base(),
      roster: coder(),
      project: { id: "p1", name: "repo", rootPath: "/repo" },
      runAgentTurn: codeThenDone(),
      code: async () => ({ status: "ok" as const, text: "edited" }),
      getExec: {
        runJSON: async () => ({ ok: false as const, error: "unused", code: null }),
        runText: async (cmd, args) => {
          if (cmd === "bash") {
            ranVerifyCommand = true;
            return { ok: true as const, data: "unexpected", exitCode: 0 };
          }
          if (args[0] === "write-tree") return { ok: true as const, data: "abc123", exitCode: 0 };
          return { ok: true as const, data: "", exitCode: 0 };
        },
      },
    });
    expect(res.status).toBe("done");
    expect(res.ledger.verification).toBeUndefined();
    expect(ranVerifyCommand).toBe(false);
  });

  test("verification gate: skipped when no code was edited this run (no false command verify)", async () => {
    let ranVerifyCommand = false;
    let ranGit = false;
    const res = await runCoordinator({
      ...base(), // roster atlas/vera are read-only (no code) → a dispatch-only run
      project: { id: "p1", name: "repo", rootPath: "/repo" },
      runAgentTurn: queuedRun([
        'go\n{"action":"progress","satisfied":false,"progress":true,"next_speaker":"atlas","instruction":"look"}',
        'done\n{"action":"done","summary":"answered"}',
      ]),
      dispatch: fakeDispatch().fn,
      getExec: {
        runJSON: async () => ({ ok: false as const, error: "unused", code: null }),
        runText: async (cmd, args) => {
          if (cmd === "bash") {
            ranVerifyCommand = true;
            return { ok: true as const, data: "", exitCode: 0 };
          }
          ranGit = true;
          if (args[0] === "write-tree") {
            return { ok: true as const, data: "abc123", exitCode: 0 };
          }
          return { ok: true as const, data: "", exitCode: 0 };
        },
      },
      verify: ["bun run test"],
    });
    expect(res.status).toBe("done");
    expect(ranGit).toBe(true); // baseline capture still runs at coordinator start
    expect(ranVerifyCommand).toBe(false); // no code entry → command verification never ran
    expect(res.ledger.verification).toBeUndefined();
  });

  test("verification gate: verify requested but no exec seam → done, surfaced (not silent)", async () => {
    const res = await runCoordinator({
      ...base(),
      roster: coder(),
      project: { id: "p1", name: "repo", rootPath: "/repo" },
      runAgentTurn: codeThenDone(),
      code: async () => ({ status: "ok" as const, text: "edited" }),
      // no getExec injected — an older harness without the exec seam
      verify: ["bun run test"],
    });
    expect(res.status).toBe("done");
    expect(res.ledger.verification).toBeUndefined();
    expect(
      res.ledger.transcript.some(
        (e) => e.kind === "verify" && e.text.includes("exec seam unavailable"),
      ),
    ).toBe(true);
  });

  test("the live distillation seam runs its own turn and records the distilled decision", async () => {
    // No injected `distill` — exercise the default seam end-to-end. The scribe turn (not a
    // "Goal:" coordinator turn) returns the record directive that becomes the governed row.
    const writebacks: WritebackRequest[] = [];
    const run: NonNullable<RibContext["runAgentTurn"]> = (req) => {
      const p = req.prompt ?? "";
      const text = p.includes("Goal:")
        ? 'done\n{"action":"done","summary":"shipped it"}'
        : 'distilling\n{"action":"record","headline":"Bun runtime","lesson":"This repo builds with bun."}';
      return { stream: oneShot(), result: Promise.resolve({ status: "ok" as const, text }) };
    };
    const res = await runCoordinator({
      ...base(),
      project: { id: "p1", name: "repo", rootPath: "/repo" },
      runAgentTurn: run,
      dispatch: fakeDispatch().fn,
      getMemory: () => capturingMemory(writebacks),
    });
    expect(res.status).toBe("done");
    expect(writebacks).toHaveLength(1);
    expect(writebacks[0]?.memories[0]?.summary).toBe("Bun runtime");
    expect(writebacks[0]?.memories[0]?.content).toBe("This repo builds with bun.");
  });

  test("threads recalled team memory into the DISPATCHED member's turn, not just the manager's", async () => {
    // The manager delegates and members can't see the manager's context, so the recalled
    // memory must ride the dispatch instruction or it never reaches the agent doing the work.
    const prompts: string[] = [];
    const memory: MemoryTools = {
      recall: async (): Promise<RecallResponse> => ({
        schemaVersion: RECALL_RESPONSE_SCHEMA_VERSION,
        requestId: "r",
        items: [
          {
            memoryId: "m1",
            type: "decision",
            summary: "headline",
            content: "prefer the in-process fallback over a network call",
            provenance: "generated",
            usePolicy: {
              canUseAsInstruction: false,
              canUseAsEvidence: true,
              requiresUserConfirmation: false,
              doNotInjectAutomatically: false,
            },
            scope: { visibility: "project", projectId: "p1" },
            sourceRefs: [],
            artifacts: [],
            createdAt: NOW,
            rankingScore: 0.9,
          },
        ],
        trace: { traceId: "t", returned: 1 },
      }),
      writeback: async (req): Promise<WritebackResponse> => ({
        schemaVersion: WRITEBACK_RESPONSE_SCHEMA_VERSION,
        written: [{ memoryId: "w1", idempotencyKey: req.idempotencyKey }],
        blocked: [],
        deduped: [],
      }),
    };
    const coordinatorReplies = [
      'go\n{"action":"progress","satisfied":false,"progress":true,"next_speaker":"atlas","instruction":"do the step"}',
      'done\n{"action":"done","summary":"shipped"}',
    ];
    const run: NonNullable<RibContext["runAgentTurn"]> = (req) => {
      const p = req.prompt ?? "";
      prompts.push(p);
      // A coordinator turn carries the "Goal:" framing; anything else is a member turn.
      const text = p.includes("Goal:")
        ? (coordinatorReplies.shift() ?? 'done\n{"action":"done","summary":"ok"}')
        : "member did the step";
      return { stream: oneShot(), result: Promise.resolve({ status: "ok" as const, text }) };
    };
    const res = await runCoordinator({
      ...base(), // uses the DEFAULT dispatch (so withTeamMemory runs) — no injected dispatch
      project: { id: "p1", name: "repo", rootPath: "/repo" },
      runAgentTurn: run,
      getMemory: () => memory,
    });
    expect(res.status).toBe("done");
    // The member's turn (not a "Goal:" coordinator turn) carries the team-memory block.
    const memberPrompt = prompts.find((p) => !p.includes("Goal:"));
    expect(memberPrompt).toBeDefined();
    expect(memberPrompt).toContain("Team memory —");
    expect(memberPrompt).toContain("prefer the in-process fallback over a network call");
    expect(memberPrompt).toContain("Your task:");
  });

  test("a project-bound run gives the dispatched member repo READ tools confined to the root", async () => {
    // The live gap: a member dispatched to verify/review couldn't read the repo (dispatch was
    // text-only). With a project bound, the dispatched turn now carries the read rail + cwd.
    const reqs: { cwd?: string; allowedTools?: readonly string[]; prompt: string }[] = [];
    const replies = [
      'go\n{"action":"progress","satisfied":false,"progress":true,"next_speaker":"atlas","instruction":"review the file"}',
      'done\n{"action":"done","summary":"reviewed"}',
    ];
    const run: NonNullable<RibContext["runAgentTurn"]> = (req) => {
      const p = req.prompt ?? "";
      if (!p.includes("Goal:")) {
        reqs.push({ cwd: req.cwd, allowedTools: req.allowedTools, prompt: p });
      }
      const text = p.includes("Goal:")
        ? (replies.shift() ?? 'done\n{"action":"done","summary":"ok"}')
        : "I read greet.py — looks correct.";
      return { stream: oneShot(), result: Promise.resolve({ status: "ok" as const, text }) };
    };
    const res = await runCoordinator({
      ...base(), // DEFAULT dispatch, so the real dispatchFanout runs with the project
      project: { id: "p1", name: "repo", rootPath: "/repo" },
      runAgentTurn: run,
    });
    expect(res.status).toBe("done");
    // The dispatched member turn (the one confined to the project) carries the read rail.
    const dispatched = reqs.find((r) => r.cwd === "/repo");
    expect(dispatched).toBeDefined();
    expect(dispatched?.allowedTools).toEqual(["Read", "Glob", "Grep"]);
    expect(dispatched?.prompt).toContain("Read, Glob, and Grep");
  });

  test("skips the memory loop when no project is bound (memory is project-scoped)", async () => {
    let calls = 0;
    const memory: MemoryTools = {
      recall: async (): Promise<RecallResponse> => {
        calls++;
        return {
          schemaVersion: RECALL_RESPONSE_SCHEMA_VERSION,
          requestId: "r",
          items: [],
          trace: { traceId: "t", returned: 0 },
        };
      },
      writeback: async (req): Promise<WritebackResponse> => {
        calls++;
        return {
          schemaVersion: WRITEBACK_RESPONSE_SCHEMA_VERSION,
          written: [{ memoryId: "w1", idempotencyKey: req.idempotencyKey }],
          blocked: [],
          deduped: [],
        };
      },
    };
    const res = await runCoordinator({
      ...base(), // no project
      runAgentTurn: queuedRun(['done\n{"action":"done","summary":"ok"}']),
      dispatch: fakeDispatch().fn,
      getMemory: () => memory,
    });
    expect(res.status).toBe("done");
    expect(calls).toBe(0); // neither recall nor writeback fire without a project scope
  });

  test("reflects each participating member once when the run completes", async () => {
    const reflected: { slug: string; contribution: string }[] = [];
    const d = fakeDispatch("did the work");
    const res = await runCoordinator({
      ...base(),
      runAgentTurn: queuedRun([
        'go\n{"action":"progress","satisfied":false,"progress":true,"next_speaker":"atlas","instruction":"build X"}',
        'done\n{"action":"done","summary":"shipped"}',
      ]),
      dispatch: d.fn,
      reflectAtClose: async (contributions) => {
        for (const c of contributions) {
          reflected.push({ slug: c.member.slug, contribution: c.contribution });
        }
        return contributions.map((c) => c.member.slug);
      },
    });
    expect(res.status).toBe("done");
    // atlas did the round-0 dispatch, so it reflects once at loop close over its own work; vera
    // never acted, so it does not reflect.
    expect(reflected.map((r) => r.slug)).toEqual(["atlas"]);
    expect(reflected[0]?.contribution).toContain("did the work");
    // The reflection is recorded on the run's transcript.
    expect(res.ledger.transcript.some((e) => e.text.includes("reflected on the run"))).toBe(true);
  });

  test("a throwing reflectAtClose seam does not crash the completed run (fail-soft)", async () => {
    const d = fakeDispatch("did the work");
    const res = await runCoordinator({
      ...base(),
      runAgentTurn: queuedRun([
        'go\n{"action":"progress","satisfied":false,"progress":true,"next_speaker":"atlas","instruction":"build X"}',
        'done\n{"action":"done","summary":"shipped"}',
      ]),
      dispatch: d.fn,
      reflectAtClose: async () => {
        throw new Error("reflect boom");
      },
    });
    expect(res.status).toBe("done"); // the run still completes despite the reflection seam throwing
  });

  test("surfaces the team gaps the manager flags, accumulated across rounds, without mutating the roster", async () => {
    const d = fakeDispatch();
    const res = await runCoordinator({
      ...base(),
      runAgentTurn: queuedRun([
        'go\n{"action":"progress","satisfied":false,"progress":true,"next_speaker":"atlas","instruction":"do X","needs":["a security reviewer"]}',
        'done\n{"action":"done","summary":"shipped","needs":["a perf specialist"]}',
      ]),
      dispatch: d.fn,
    });
    expect(res.status).toBe("done");
    // Both rounds' recommendations accumulate (deduped); the roster (atlas, vera) is untouched —
    // the squad recommends a cast, it does not autonomously mutate its team.
    expect(res.ledger.teamGaps).toEqual(["a security reviewer", "a perf specialist"]);
    expect(res.ledger.transcript.some((e) => e.kind === "dispatch")).toBe(true);
  });

  test("does not fire per-member reflection when no member participated", async () => {
    let called = false;
    const res = await runCoordinator({
      ...base(),
      runAgentTurn: queuedRun(['done\n{"action":"done","summary":"nothing to do"}']),
      dispatch: fakeDispatch().fn,
      reflectAtClose: async () => {
        called = true;
        return [];
      },
    });
    expect(res.status).toBe("done");
    expect(called).toBe(false); // a straight done with no dispatched work spends no reflection turns
  });

  test("an unparseable coordinator reply counts as a stall (fallback)", async () => {
    const d = fakeDispatch();
    const res = await runCoordinator({
      ...base(),
      runAgentTurn: queuedRun(["I have no idea, here is some prose with no directive."]),
      dispatch: d.fn,
      limits: { maxRounds: 10, maxStall: 1, maxResets: 0 },
    });
    expect(res.status).toBe("gave-up");
  });

  test("resumes a persisted active ledger for the same task (restart-durability)", async () => {
    const persisted: CoordinatorLedger = {
      task: "ship the feature",
      facts: ["earlier finding"],
      plan: ["step"],
      round: 5,
      stallCount: 0,
      resetCount: 0,
      status: "active",
      transcript: [],
      createdAt: NOW,
      updatedAt: NOW,
    };
    await saveLedger(home, persisted);
    const d = fakeDispatch();
    const res = await runCoordinator({
      ...base(),
      runAgentTurn: queuedRun(['done\n{"action":"done","summary":"resumed and finished"}']),
      dispatch: d.fn,
    });
    // Started from round 5 (resumed), not 0 — and the earlier finding survived.
    expect(res.rounds).toBe(5);
    expect(res.ledger.facts).toContain("earlier finding");
  });

  test("routes a code step through the code arm and folds it into the ledger", async () => {
    const codeRoster: Member[] = [
      {
        slug: "atlas",
        name: "atlas",
        role: "Engineer",
        charter: "x",
        status: "active",
        tools: ["code", "read"],
      },
      {
        slug: "vera",
        name: "vera",
        role: "Reviewer",
        charter: "x",
        status: "active",
        tools: ["read"],
      },
    ];
    const coded: string[] = [];
    const res = await runCoordinator({
      ...base(),
      roster: codeRoster,
      project: { id: "p1", name: "repo", rootPath: "/repo" },
      runAgentTurn: queuedRun([
        'plan\n{"action":"progress","satisfied":false,"progress":true,"next_speaker":"atlas","mode":"code","instruction":"add a flag"}',
        'done\n{"action":"done","summary":"shipped"}',
      ]),
      dispatch: fakeDispatch().fn,
      code: async (member, instruction) => {
        coded.push(`${member.slug}:${instruction}`);
        return { status: "ok", text: "edited foo.ts" };
      },
    });
    expect(res.status).toBe("done");
    expect(coded).toEqual(["atlas:add a flag"]);
    expect(res.ledger.transcript.some((e) => e.kind === "code")).toBe(true);
    expect(res.ledger.facts.some((f) => f.includes("edited foo.ts"))).toBe(true);
  });

  test("routes a workflow step through the workflow arm and folds it", async () => {
    const authored: string[] = [];
    const res = await runCoordinator({
      ...base(),
      runAgentTurn: queuedRun([
        'plan\n{"action":"progress","satisfied":false,"progress":true,"next_speaker":"atlas","mode":"workflow","instruction":"author a lint flow"}',
        'done\n{"action":"done","summary":"shipped"}',
      ]),
      dispatch: fakeDispatch().fn,
      workflow: async (member, instruction) => {
        authored.push(`${member.slug}:${instruction}`);
        return {
          status: "ok",
          text: 'authored workflow "lint" (2 nodes)',
          name: "lint",
          nodeCount: 2,
        };
      },
    });
    expect(res.status).toBe("done");
    expect(authored).toEqual(["atlas:author a lint flow"]);
    expect(res.ledger.transcript.some((e) => e.kind === "workflow")).toBe(true);
    expect(res.ledger.facts.some((f) => f.includes("authored workflow"))).toBe(true);
  });

  test("the workflow arm authors AND runs when a project + run seam are present", async () => {
    const ran: unknown[] = [];
    // A prompt-only DAG is auto-run-safe (every node is a policy-gated agent turn);
    // bash/script/command/loop-until_bash workflows stay author-only (see the screen).
    const validWf = JSON.stringify({
      name: "verify",
      description: "d",
      nodes: [{ id: "a", prompt: "verify the build and report" }],
    });
    const res = await runCoordinator({
      ...base(),
      project: { id: "p1", name: "repo", rootPath: "/repo" },
      runWorkflow: async (def) => {
        ran.push(def);
        return { status: "succeeded" as const, nodes: { a: { state: "completed", output: "hi" } } };
      },
      runAgentTurn: queuedRun([
        'plan\n{"action":"progress","satisfied":false,"progress":true,"next_speaker":"atlas","mode":"workflow","instruction":"author a verify flow"}',
        validWf,
        'done\n{"action":"done","summary":"ok"}',
      ]),
      dispatch: fakeDispatch().fn,
    });
    expect(res.status).toBe("done");
    expect(ran).toHaveLength(1);
    expect(res.ledger.transcript.some((e) => e.kind === "workflow" && e.text.includes("RAN"))).toBe(
      true,
    );
  });

  test("the workflow arm is author-only without a project (run seam never called)", async () => {
    let ranCalled = false;
    const validWf = JSON.stringify({
      name: "verify",
      description: "d",
      nodes: [{ id: "a", bash: "echo hi" }],
    });
    const res = await runCoordinator({
      ...base(),
      runWorkflow: async () => {
        ranCalled = true;
        return { status: "succeeded" as const, nodes: {} };
      },
      runAgentTurn: queuedRun([
        'plan\n{"action":"progress","satisfied":false,"progress":true,"next_speaker":"atlas","mode":"workflow","instruction":"author"}',
        validWf,
        'done\n{"action":"done","summary":"ok"}',
      ]),
      dispatch: fakeDispatch().fn,
    });
    expect(ranCalled).toBe(false);
    expect(
      res.ledger.transcript.some((e) => e.kind === "workflow" && e.text.includes("not run")),
    ).toBe(true);
  });

  test("the workflow arm authors but refuses to auto-run a bash workflow (author-only)", async () => {
    let ranCalled = false;
    const dangerWf = JSON.stringify({
      name: "danger",
      description: "d",
      nodes: [{ id: "a", bash: "gh pr merge 1" }],
    });
    await runCoordinator({
      ...base(),
      project: { id: "p1", name: "repo", rootPath: "/repo" },
      runWorkflow: async () => {
        ranCalled = true;
        return { status: "succeeded" as const, nodes: {} };
      },
      runAgentTurn: queuedRun([
        'plan\n{"action":"progress","satisfied":false,"progress":true,"next_speaker":"atlas","mode":"workflow","instruction":"x"}',
        dangerWf,
        'done\n{"action":"done","summary":"ok"}',
      ]),
      dispatch: fakeDispatch().fn,
    });
    expect(ranCalled).toBe(false);
  });

  test("folds a single member's reply when the dispatch ran no synthesis", async () => {
    const dispatch = async (_members: Member[], instruction: string): Promise<DispatchOutcome> => ({
      task: instruction,
      perMember: [{ slug: "atlas", name: "atlas", status: "ok", text: "the lone reply" }],
      notes: [],
    });
    const res = await runCoordinator({
      ...base(),
      runAgentTurn: queuedRun([
        'go\n{"action":"progress","satisfied":false,"progress":true,"next_speaker":"atlas","instruction":"do X"}',
        'done\n{"action":"done","summary":"ok"}',
      ]),
      dispatch,
    });
    expect(res.ledger.facts.some((f) => f.includes("the lone reply"))).toBe(true);
  });

  test("a different task starts fresh rather than resuming", async () => {
    const stale: CoordinatorLedger = {
      task: "an old task",
      facts: ["stale"],
      plan: [],
      round: 9,
      stallCount: 0,
      resetCount: 0,
      status: "active",
      transcript: [],
      createdAt: NOW,
      updatedAt: NOW,
    };
    await saveLedger(home, stale);
    const d = fakeDispatch();
    const res = await runCoordinator({
      ...base(),
      runAgentTurn: queuedRun(['done\n{"action":"done","summary":"fresh"}']),
      dispatch: d.fn,
    });
    expect(res.rounds).toBe(0);
    expect(res.ledger.facts).not.toContain("stale");
  });

  test("incomplete-commit gate: a committed run that leaves a run edit uncommitted vetoes done and terminates verification-failed", async () => {
    let revParse = 0;
    const z = (p: string[]) => p.join("\0") + (p.length ? "\0" : "");
    const exec: RibExec = {
      runJSON: async () => ({ ok: false as const, error: "unused", code: null }),
      runText: async (cmd, args) => {
        if (cmd === "git" && args[0] === "rev-parse") {
          revParse += 1;
          // First rev-parse = run-start HEAD; every later one = advanced (a commit was created).
          return {
            ok: true as const,
            data: `${revParse === 1 ? "base-sha" : "new-sha"}\n`,
            exitCode: 0,
          };
        }
        if (cmd === "git" && args[0] === "write-tree") {
          return { ok: true as const, data: "curtree", exitCode: 0 };
        }
        if (cmd === "git" && args[0] === "diff" && args.includes("--name-only")) {
          const ref = args[args.indexOf("--find-renames") + 1];
          // HEAD..tree = uncommitted; baselineTree..tree = the run's full delta.
          return {
            ok: true as const,
            data: ref === "HEAD" ? z(["src/b.ts"]) : z(["src/a.ts", "src/b.ts"]),
            exitCode: 0,
          };
        }
        return { ok: true as const, data: "all good", exitCode: 0 };
      },
    };
    const res = await runCoordinator({
      ...base(),
      roster: coder(),
      project: { id: "p1", name: "repo", rootPath: "/repo" },
      runAgentTurn: codeThenDone(),
      code: async () => ({ status: "ok" as const, text: "edited and committed" }),
      dispatch: fakeDispatch("RAI VERDICT: PASS\nno blocking defect found").fn,
      getExec: exec,
      verify: ["bun run test"],
      limits: { maxRounds: 20 },
    });
    expect(res.status).toBe("verification-failed");
    const vetoes = res.ledger.transcript.filter(
      (e) => e.kind === "verify" && e.text.includes("these run edits are uncommitted"),
    );
    expect(vetoes.length).toBe(MAX_VERIFY_FAILURES);
    // src/b.ts is run-touched AND uncommitted → named; src/a.ts was committed → not named.
    expect(vetoes[0]?.text).toContain("- src/b.ts");
    expect(vetoes[0]?.text).not.toContain("src/a.ts");
  });
});

describe("collectIncompleteCommitPaths", () => {
  const z = (p: string[]) => p.join("\0") + (p.length ? "\0" : "");
  const exec = (opts: {
    head?: string;
    runDelta?: string[];
    uncommitted?: string[];
    fail?: "rev-parse" | "write-tree" | "diff";
  }): RibExec => ({
    runJSON: async () => ({ ok: false as const, error: "unused", code: null }),
    runText: async (cmd, args) => {
      if (cmd === "git" && args[0] === "rev-parse") {
        return opts.fail === "rev-parse"
          ? { ok: false as const, error: "no HEAD", code: 128 }
          : { ok: true as const, data: `${opts.head ?? "new-sha"}\n`, exitCode: 0 };
      }
      if (cmd === "git" && args[0] === "write-tree") {
        return opts.fail === "write-tree"
          ? { ok: false as const, error: "write-tree failed", code: 128 }
          : { ok: true as const, data: "curtree", exitCode: 0 };
      }
      if (cmd === "git" && args[0] === "diff") {
        if (opts.fail === "diff") return { ok: false as const, error: "diff failed", code: 128 };
        const ref = args[args.indexOf("--find-renames") + 1];
        return {
          ok: true as const,
          data: ref === "HEAD" ? z(opts.uncommitted ?? []) : z(opts.runDelta ?? []),
          exitCode: 0,
        };
      }
      return { ok: true as const, data: "", exitCode: 0 };
    },
  });

  test("no commit this run (HEAD unchanged): committed=false, no paths", async () => {
    const r = await collectIncompleteCommitPaths(
      exec({ head: "base-sha" }),
      "/repo",
      "btree",
      "base-sha",
    );
    expect(r).toEqual({ ok: true, committed: false, paths: [] });
  });

  test("committed with an uncommitted run edit: names the run-touched uncommitted path only", async () => {
    const r = await collectIncompleteCommitPaths(
      exec({
        head: "new-sha",
        runDelta: ["src/a.ts", "src/b.ts"],
        uncommitted: ["src/b.ts", "vendor/inherited.txt"],
      }),
      "/repo",
      "btree",
      "base-sha",
    );
    // src/b.ts: run-touched AND uncommitted → reported. src/a.ts: committed (not uncommitted).
    // vendor/inherited.txt: uncommitted but NOT run-touched (inherited dirt) → ignored.
    expect(r).toEqual({ ok: true, committed: true, paths: ["src/b.ts"] });
  });

  test("committed with everything committed (only inherited dirt remains): committed=true, no paths", async () => {
    const r = await collectIncompleteCommitPaths(
      exec({ head: "new-sha", runDelta: ["src/a.ts"], uncommitted: ["vendor/inherited.txt"] }),
      "/repo",
      "btree",
      "base-sha",
    );
    expect(r).toEqual({ ok: true, committed: true, paths: [] });
  });

  test("fails closed when git inspection errors after HEAD advanced", async () => {
    for (const fail of ["rev-parse", "write-tree", "diff"] as const) {
      const r = await collectIncompleteCommitPaths(
        exec({ head: "new-sha", fail }),
        "/repo",
        "btree",
        "base-sha",
      );
      expect(r.ok).toBe(false);
    }
  });
});

describe("squad_stop tool + coordinate run guard", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "squad-stop-tool-"));
    setSquadDataHome(home);
  });
  afterEach(async () => {
    rib.dispose?.();
    setSquadDataHome(undefined);
    await rm(home, { recursive: true, force: true });
  });

  const PROGRESS =
    'go\n{"action":"progress","satisfied":false,"progress":true,"next_speaker":"atlas","instruction":"look","mode":"dispatch"}';

  function slowRun(delayMs: number): NonNullable<RibContext["runAgentTurn"]> {
    return () => ({
      stream: oneShot(),
      result: new Promise((resolve) => {
        setTimeout(() => resolve({ status: "ok" as const, text: PROGRESS }), delayMs);
      }),
    });
  }

  async function bootWithMember(
    run: NonNullable<RibContext["runAgentTurn"]>,
  ): Promise<readonly ToolDefinition[]> {
    await scaffoldMember(scopeMembersDir(home, "alpha"), {
      slug: "atlas",
      name: "Atlas",
      role: "Engineer",
      charter: "# Atlas",
      status: "active",
      createdAt: NOW,
    });
    const ctx = {
      getDataDir: () => home,
      getProjects: () => [project("alpha", "alpha", "/repo/alpha")],
      runAgentTurn: run,
    } as unknown as RibContext;
    return rib.registerTools?.(ctx) ?? [];
  }

  test("squad_stop with no live run errors and names the scope", async () => {
    const tools = await bootWithMember(queuedRun([PROGRESS]));
    const capture = captureTool();

    await registeredTool(tools, "squad_stop").execute({ project: "alpha" }, capture.ctx as never);

    expect(capture.out().isError).toBe(true);
    expect(capture.out().content).toContain('no live coordinator run in scope "alpha"');
  });

  test("squad_stop trips a live run into an aborted ledger with the transcript intact", async () => {
    const tools = await bootWithMember(slowRun(80));
    const runCapture = captureTool();
    const running = registeredTool(tools, "squad_coordinate").execute(
      { task: "stoppable work", project: "alpha", maxRounds: 50 },
      runCapture.ctx as never,
    );
    await new Promise((r) => setTimeout(r, 120));

    const stopCapture = captureTool();
    await registeredTool(tools, "squad_stop").execute(
      { project: "alpha" },
      stopCapture.ctx as never,
    );
    await running;

    expect(stopCapture.out().isError).toBe(false);
    expect(stopCapture.out().content).toContain("stop requested");
    const ledger = await loadLedger(scopeDataHome(home, "alpha"));
    expect(ledger?.status).toBe("aborted");
    expect(runCapture.out().content).toContain("aborted");
  });

  test("coordinate refuses while the scope has a live run", async () => {
    const tools = await bootWithMember(slowRun(80));
    const runCapture = captureTool();
    const running = registeredTool(tools, "squad_coordinate").execute(
      { task: "first run", project: "alpha", maxRounds: 50 },
      runCapture.ctx as never,
    );
    await new Promise((r) => setTimeout(r, 120));

    const secondCapture = captureTool();
    await registeredTool(tools, "squad_coordinate").execute(
      { task: "second run", project: "alpha" },
      secondCapture.ctx as never,
    );
    expect(secondCapture.out().isError).toBe(true);
    expect(secondCapture.out().content).toContain("already has a live coordinator run");

    const stopCapture = captureTool();
    await registeredTool(tools, "squad_stop").execute(
      { project: "alpha" },
      stopCapture.ctx as never,
    );
    await running;
  });

  test("coordinate takes over a stale active ledger and records the takeover note", async () => {
    const staleAt = "2026-07-01T00:00:00.000Z";
    await saveLedger(scopeDataHome(home, "alpha"), {
      task: "orphaned work",
      status: "active",
      round: 3,
      facts: [],
      plan: [],
      stallCount: 0,
      resetCount: 0,
      transcript: [],
      createdAt: staleAt,
      updatedAt: staleAt,
    });
    const tools = await bootWithMember(queuedRun(['ok\n{"action":"done","summary":"fin"}']));
    const capture = captureTool();

    await registeredTool(tools, "squad_coordinate").execute(
      { task: "fresh run", project: "alpha" },
      capture.ctx as never,
    );

    expect(capture.out().isError).toBe(false);
    const ledger = await loadLedger(scopeDataHome(home, "alpha"));
    expect(ledger?.status).toBe("done");
    const note = ledger?.transcript.find((e) =>
      (e.text ?? "").includes("took over stale active coordinator ledger at round 3"),
    );
    expect(note).toBeDefined();
  });
});
