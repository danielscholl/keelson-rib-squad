import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  MessageChunk,
  RibAgentTurn,
  RibAgentTurnRequest,
  RibAgentTurnResult,
} from "@keelson/shared";
import { dispatchFanout } from "../src/dispatch.ts";
import {
  type MemberRecord,
  readMemberDoc,
  scaffoldMember,
  writeMemory,
} from "../src/member-store.ts";
import type { Member } from "../src/types.ts";

// dispatchFanout takes the agent-turn seam as a parameter, so these drive it
// against a FAKE runAgentTurn — concurrency is asserted with an in-flight counter,
// never wall-clock. Members are scaffolded on disk so composeMemberSystemPrompt
// has real charters to read.

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "squad-dispatch-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function seed(slug: string, name: string): Promise<Member> {
  const record: MemberRecord = {
    slug,
    name,
    role: "Specialist",
    charter: `# ${name}\n\nI am ${name}.`,
    status: "active",
    createdAt: "2026-06-06T00:00:00.000Z",
  };
  await scaffoldMember(root, record);
  return { slug, name, role: "Specialist", charter: `I am ${name}.`, status: "active" };
}

async function* oneChunkStream(text: string): AsyncGenerator<MessageChunk> {
  yield { type: "text", content: text };
  yield { type: "done" };
}

const okResult = (text: string): RibAgentTurnResult => ({ status: "ok", text });

function fakeTurn(result: Promise<RibAgentTurnResult>): RibAgentTurn {
  return { stream: oneChunkStream("x"), result };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("dispatchFanout", () => {
  test("fans out concurrently, bounded by `concurrency`", async () => {
    const members = await Promise.all([
      seed("a", "Alpha"),
      seed("b", "Beta"),
      seed("c", "Gamma"),
      seed("d", "Delta"),
      seed("e", "Echo"),
    ]);
    let inFlight = 0;
    let maxInFlight = 0;
    const gate = deferred<void>();
    const runAgentTurn = (_req: RibAgentTurnRequest): RibAgentTurn => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const result = (async (): Promise<RibAgentTurnResult> => {
        await gate.promise;
        inFlight--;
        return okResult("ok");
      })();
      return fakeTurn(result);
    };

    const concurrency = 3;
    const p = dispatchFanout({
      runAgentTurn,
      membersRoot: root,
      members,
      task: "T",
      concurrency,
      synthesize: false,
    });

    // Hold the barrier until the pool has a full lane-width in flight — a counter
    // condition, not a timer. Bounded so a broken pool fails the assertion rather
    // than hanging.
    for (let i = 0; i < 500 && inFlight < concurrency; i++) await tick();
    expect(inFlight).toBe(concurrency);
    gate.resolve();

    const outcome = await p;
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(concurrency);
    expect(outcome.perMember).toHaveLength(5);
    expect(outcome.perMember.every((r) => r.status === "ok")).toBe(true);
  });

  test("isolates a failing member — the rest still resolve ok", async () => {
    const members = await Promise.all([seed("a", "Alpha"), seed("b", "Beta"), seed("c", "Gamma")]);
    const runAgentTurn = (req: RibAgentTurnRequest): RibAgentTurn => {
      if (req.system?.includes("Beta")) {
        return fakeTurn(
          (async (): Promise<RibAgentTurnResult> => {
            throw new Error("boom");
          })(),
        );
      }
      return fakeTurn(Promise.resolve(okResult("fine")));
    };

    const outcome = await dispatchFanout({
      runAgentTurn,
      membersRoot: root,
      members,
      task: "T",
      synthesize: false,
    });
    const bySlug = Object.fromEntries(outcome.perMember.map((r) => [r.slug, r]));
    expect(bySlug.a?.status).toBe("ok");
    expect(bySlug.b?.status).toBe("error");
    expect(bySlug.b?.error).toContain("boom");
    expect(bySlug.c?.status).toBe("ok");
  });

  test("synthesis prompt carries every ok member's text", async () => {
    const members = await Promise.all([seed("a", "Alpha"), seed("b", "Beta"), seed("c", "Gamma")]);
    const task = "Plan the launch";
    let synthPrompt: string | undefined;
    const runAgentTurn = (req: RibAgentTurnRequest): RibAgentTurn => {
      if (req.prompt === task) {
        const name = req.system?.match(/^# (.+)$/m)?.[1] ?? "?";
        return fakeTurn(Promise.resolve(okResult(`reply::${name}`)));
      }
      synthPrompt = req.prompt;
      return fakeTurn(Promise.resolve(okResult("SYNTHESIZED")));
    };

    const outcome = await dispatchFanout({ runAgentTurn, membersRoot: root, members, task });
    expect(outcome.synthesis).toBe("SYNTHESIZED");
    expect(synthPrompt).toBeDefined();
    expect(synthPrompt).toContain(task);
    for (const name of ["Alpha", "Beta", "Gamma"]) {
      expect(synthPrompt).toContain(`reply::${name}`);
    }
  });

  test("synthesis is fail-soft — an errored synthesis turn yields no synthesis + a note", async () => {
    const members = await Promise.all([seed("a", "Alpha")]);
    const task = "T";
    const runAgentTurn = (req: RibAgentTurnRequest): RibAgentTurn => {
      if (req.prompt === task) return fakeTurn(Promise.resolve(okResult("member reply")));
      return fakeTurn(Promise.resolve({ status: "error", text: "", error: "synth blew up" }));
    };

    const outcome = await dispatchFanout({ runAgentTurn, membersRoot: root, members, task });
    expect(outcome.synthesis).toBeUndefined();
    expect(outcome.perMember[0]?.status).toBe("ok");
    expect(outcome.notes.some((n) => n.includes("synthesis turn error"))).toBe(true);
  });

  test("caps the wave at maxMembers and records a truncation note", async () => {
    const members = await Promise.all(
      ["a", "b", "c", "d", "e", "f", "g", "h"].map((s, i) => seed(s, `M${i}`)),
    );
    let calls = 0;
    const runAgentTurn = (_req: RibAgentTurnRequest): RibAgentTurn => {
      calls++;
      return fakeTurn(Promise.resolve(okResult("ok")));
    };

    const outcome = await dispatchFanout({
      runAgentTurn,
      membersRoot: root,
      members,
      task: "T",
      maxMembers: 3,
      synthesize: false,
    });
    expect(outcome.perMember).toHaveLength(3);
    expect(calls).toBe(3);
    expect(outcome.notes.some((n) => n.includes("truncated to 3 of 8"))).toBe(true);
  });

  test("a pre-aborted signal yields aborted results without invoking the seam", async () => {
    const members = await Promise.all([seed("a", "Alpha"), seed("b", "Beta")]);
    let calls = 0;
    const runAgentTurn = (_req: RibAgentTurnRequest): RibAgentTurn => {
      calls++;
      return fakeTurn(Promise.resolve(okResult("ok")));
    };
    const ac = new AbortController();
    ac.abort();

    const outcome = await dispatchFanout({
      runAgentTurn,
      membersRoot: root,
      members,
      task: "T",
      abortSignal: ac.signal,
    });
    expect(calls).toBe(0);
    expect(outcome.perMember.every((r) => r.status === "aborted")).toBe(true);
    expect(outcome.synthesis).toBeUndefined();
    expect(outcome.notes.length).toBeGreaterThan(0);
  });

  test("reflection is OFF by default — no extra turn, memory untouched", async () => {
    const members = await Promise.all([seed("a", "Alpha")]);
    let reflectionCalls = 0;
    const runAgentTurn = (req: RibAgentTurnRequest): RibAgentTurn => {
      if (req.prompt.includes("Curate your long-term memory")) reflectionCalls++;
      return fakeTurn(Promise.resolve(okResult("substantive reply")));
    };
    await dispatchFanout({
      runAgentTurn,
      membersRoot: root,
      members,
      task: "T",
      synthesize: false,
    });
    expect(reflectionCalls).toBe(0);
    expect(await readMemberDoc(root, "a", "memory.md")).toContain("_(empty)_");
  });

  test("reflect: writes a member's memory.md from its reflection turn on substance", async () => {
    const members = await Promise.all([seed("a", "Alpha")]);
    const runAgentTurn = (req: RibAgentTurnRequest): RibAgentTurn => {
      if (req.prompt.includes("Curate your long-term memory")) {
        // The reflection turn's reply IS the new memory document.
        return fakeTurn(Promise.resolve(okResult("# Memory\n\nThe operator prefers Bun.")));
      }
      return fakeTurn(Promise.resolve(okResult("substantive answer")));
    };
    const outcome = await dispatchFanout({
      runAgentTurn,
      membersRoot: root,
      members,
      task: "T",
      synthesize: false,
      reflect: true,
    });
    expect(await readMemberDoc(root, "a", "memory.md")).toContain("The operator prefers Bun.");
    expect(outcome.notes.some((n) => n.includes("reflection updated a memory"))).toBe(true);
  });

  test("reflect: skips a member with no substance — no reflection turn, memory untouched", async () => {
    const members = await Promise.all([seed("a", "Alpha")]);
    let reflectionCalls = 0;
    const runAgentTurn = (req: RibAgentTurnRequest): RibAgentTurn => {
      if (req.prompt.includes("Curate your long-term memory")) reflectionCalls++;
      return fakeTurn(Promise.resolve(okResult(""))); // ok but empty -> no substance
    };
    const outcome = await dispatchFanout({
      runAgentTurn,
      membersRoot: root,
      members,
      task: "T",
      synthesize: false,
      reflect: true,
    });
    expect(reflectionCalls).toBe(0);
    expect(await readMemberDoc(root, "a", "memory.md")).toContain("_(empty)_");
    expect(outcome.notes.some((n) => n.includes("no member produced substance"))).toBe(true);
  });

  test("reflect: a failed reflection turn leaves the prior memory intact", async () => {
    const members = await Promise.all([seed("a", "Alpha")]);
    await writeMemory(root, "a", "PRIOR DURABLE MEMORY");
    const runAgentTurn = (req: RibAgentTurnRequest): RibAgentTurn => {
      if (req.prompt.includes("Curate your long-term memory")) {
        return fakeTurn(
          Promise.resolve({ status: "error", text: "", error: "reflection blew up" }),
        );
      }
      return fakeTurn(Promise.resolve(okResult("substantive answer")));
    };
    const outcome = await dispatchFanout({
      runAgentTurn,
      membersRoot: root,
      members,
      task: "T",
      synthesize: false,
      reflect: true,
    });
    expect(await readMemberDoc(root, "a", "memory.md")).toContain("PRIOR DURABLE MEMORY");
    expect(outcome.notes.some((n) => n.includes("reflection for a error"))).toBe(true);
  });

  test("reflect: an over-cap reflection reply is rejected, prior memory kept", async () => {
    const members = await Promise.all([seed("a", "Alpha")]);
    await writeMemory(root, "a", "PRIOR DURABLE MEMORY");
    const runAgentTurn = (req: RibAgentTurnRequest): RibAgentTurn => {
      if (req.prompt.includes("Curate your long-term memory")) {
        return fakeTurn(Promise.resolve(okResult("x".repeat(5000)))); // over MEMORY_DOC_CAP
      }
      return fakeTurn(Promise.resolve(okResult("substantive answer")));
    };
    const outcome = await dispatchFanout({
      runAgentTurn,
      membersRoot: root,
      members,
      task: "T",
      synthesize: false,
      reflect: true,
    });
    expect(await readMemberDoc(root, "a", "memory.md")).toContain("PRIOR DURABLE MEMORY");
    expect(outcome.notes.some((n) => n.includes("not persisted"))).toBe(true);
  });

  test("a turn whose result outlives the timeout is reported as timeout", async () => {
    const members = await Promise.all([seed("a", "Alpha")]);
    const runAgentTurn = (_req: RibAgentTurnRequest): RibAgentTurn => {
      const result = new Promise<RibAgentTurnResult>((resolve) =>
        setTimeout(() => resolve(okResult("late")), 60),
      );
      return fakeTurn(result);
    };

    const outcome = await dispatchFanout({
      runAgentTurn,
      membersRoot: root,
      members,
      task: "T",
      perTurnTimeoutMs: 20,
      synthesize: false,
    });
    expect(outcome.perMember[0]?.status).toBe("timeout");
  });
});
