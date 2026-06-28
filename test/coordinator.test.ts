import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  MemoryTools,
  MessageChunk,
  RecallResponse,
  RibContext,
  WritebackRequest,
  WritebackResponse,
} from "@keelson/shared";
import { RECALL_RESPONSE_SCHEMA_VERSION, WRITEBACK_RESPONSE_SCHEMA_VERSION } from "@keelson/shared";
import {
  type CoordinatorEntry,
  type CoordinatorLedger,
  failStuckTasks,
  loadLedger,
  parseCoordinatorDirective,
  runCoordinator,
  saveLedger,
} from "../src/coordinator.ts";
import type { DispatchOutcome } from "../src/dispatch.ts";
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

  test("returns null without a valid trailing directive", () => {
    expect(parseCoordinatorDirective("just prose, no json")).toBeNull();
    expect(parseCoordinatorDirective('{"action":"progress"} then more text')).toBeNull();
    expect(parseCoordinatorDirective('{"action":"bogus"}')).toBeNull();
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
});
