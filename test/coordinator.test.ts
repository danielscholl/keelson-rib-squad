import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageChunk, RibContext } from "@keelson/shared";
import {
  type CoordinatorLedger,
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

  test("returns null without a valid trailing directive", () => {
    expect(parseCoordinatorDirective("just prose, no json")).toBeNull();
    expect(parseCoordinatorDirective('{"action":"progress"} then more text')).toBeNull();
    expect(parseCoordinatorDirective('{"action":"bogus"}')).toBeNull();
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
