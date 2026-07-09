import { describe, expect, test } from "bun:test";
import type {
  MemoryTools,
  MessageChunk,
  RecallItem,
  RecallResponse,
  RibContext,
  WritebackRequest,
  WritebackResponse,
} from "@keelson/shared";
import { RECALL_RESPONSE_SCHEMA_VERSION, WRITEBACK_RESPONSE_SCHEMA_VERSION } from "@keelson/shared";
import {
  distillOutcome,
  recallGrounding,
  reflectDistilled,
  reflectOutcome,
} from "../src/memory.ts";

function recallItem(type: RecallItem["type"], summary: string): RecallItem {
  return {
    memoryId: `m-${summary}`,
    type,
    summary,
    content: `content for ${summary}`,
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
    createdAt: "2026-06-28T00:00:00.000Z",
    rankingScore: 0.5,
  };
}

interface FakeOpts {
  items?: RecallItem[];
  onWriteback?: (req: WritebackRequest) => void;
  written?: boolean;
  throwOn?: "recall" | "writeback";
}

function fakeMemory(opts: FakeOpts = {}): MemoryTools {
  return {
    recall: async (): Promise<RecallResponse> => {
      if (opts.throwOn === "recall") throw new Error("recall boom");
      const items = opts.items ?? [];
      return {
        schemaVersion: RECALL_RESPONSE_SCHEMA_VERSION,
        requestId: "req-1",
        items,
        trace: { traceId: "trace-1", returned: items.length },
      };
    },
    writeback: async (req): Promise<WritebackResponse> => {
      if (opts.throwOn === "writeback") throw new Error("writeback boom");
      opts.onWriteback?.(req);
      const wrote = opts.written ?? true;
      return {
        schemaVersion: WRITEBACK_RESPONSE_SCHEMA_VERSION,
        written: wrote ? [{ memoryId: "m1", idempotencyKey: req.idempotencyKey }] : [],
        blocked: [],
        deduped: [],
      };
    },
  };
}

describe("recallGrounding", () => {
  test("maps recalled decisions/lessons to grounding lines (surfacing content, not the headline)", async () => {
    // recallItem sets content = `content for ${summary}` — the substance, which is what
    // grounding surfaces so the coordinator sees WHAT was learned, not just that a row exists.
    const memory = fakeMemory({
      items: [recallItem("decision", "use bun"), recallItem("lesson", "tests need the symlink")],
    });
    const lines = await recallGrounding(memory, "p1", "ship the feature");
    expect(lines).toEqual([
      "[recalled decision] content for use bun",
      "[recalled lesson] content for tests need the symlink",
    ]);
  });

  test("returns [] without a memory seam or a project (memory is project-scoped)", async () => {
    expect(await recallGrounding(undefined, "p1", "t")).toEqual([]);
    expect(
      await recallGrounding(fakeMemory({ items: [recallItem("decision", "x")] }), undefined, "t"),
    ).toEqual([]);
  });

  test("fail-soft: a recall error yields [] (never throws)", async () => {
    expect(await recallGrounding(fakeMemory({ throwOn: "recall" }), "p1", "t")).toEqual([]);
  });
});

describe("reflectOutcome", () => {
  test("writes one governed decision row from the run's summary + recent facts", async () => {
    let captured: WritebackRequest | undefined;
    const memory = fakeMemory({ onWriteback: (req) => (captured = req) });
    const wrote = await reflectOutcome(memory, "p1", "ship the feature", "shipped it", [
      "uses bun",
      "added a test",
    ]);
    expect(wrote).toBe(true);
    expect(captured?.scope?.projectId).toBe("p1");
    const draft = captured?.memories[0];
    expect(draft?.type).toBe("decision");
    expect(draft?.provenance).toBe("generated");
    expect(draft?.summary).toBe("Squad outcome — ship the feature");
    expect(draft?.content).toContain("shipped it");
    expect(draft?.content).toContain("added a test");
    // contentHash is a sha256 hex digest.
    expect(draft?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    // idempotencyKey is content-derived so an identical outcome dedupes.
    expect(captured?.idempotencyKey).toBe(`squad-coord:p1:${draft?.contentHash}`);
  });

  test("no-ops (false) without a seam, a project, or a summary", async () => {
    expect(await reflectOutcome(undefined, "p1", "t", "s", [])).toBe(false);
    expect(await reflectOutcome(fakeMemory(), undefined, "t", "s", [])).toBe(false);
    expect(await reflectOutcome(fakeMemory(), "p1", "t", "   ", [])).toBe(false);
  });

  test("returns false when the store wrote nothing (e.g. deduped/blocked)", async () => {
    expect(await reflectOutcome(fakeMemory({ written: false }), "p1", "t", "s", [])).toBe(false);
  });

  test("fail-soft: a writeback error yields false (never throws)", async () => {
    expect(await reflectOutcome(fakeMemory({ throwOn: "writeback" }), "p1", "t", "s", [])).toBe(
      false,
    );
  });
});

describe("reflectDistilled", () => {
  test("writes one governed decision row from the distilled headline + lesson", async () => {
    let captured: WritebackRequest | undefined;
    const memory = fakeMemory({ onWriteback: (req) => (captured = req) });
    const wrote = await reflectDistilled(memory, "p1", {
      headline: "Bun is the runtime",
      content: "This repo builds with bun; run bun test before opening a PR.",
    });
    expect(wrote).toBe(true);
    const draft = captured?.memories[0];
    expect(draft?.type).toBe("decision");
    expect(draft?.provenance).toBe("generated");
    // The distilled lesson IS the row — no "Squad outcome —" prefix, no raw facts dump.
    expect(draft?.summary).toBe("Bun is the runtime");
    expect(draft?.content).toBe("This repo builds with bun; run bun test before opening a PR.");
    expect(draft?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(captured?.idempotencyKey).toBe(`squad-coord:p1:${draft?.contentHash}`);
  });

  test("no-ops (false) without a seam, a project, empty content, or empty headline", async () => {
    const ok = { headline: "h", content: "c" };
    expect(await reflectDistilled(undefined, "p1", ok)).toBe(false);
    expect(await reflectDistilled(fakeMemory(), undefined, ok)).toBe(false);
    expect(await reflectDistilled(fakeMemory(), "p1", { headline: "h", content: "   " })).toBe(
      false,
    );
    expect(await reflectDistilled(fakeMemory(), "p1", { headline: "  ", content: "c" })).toBe(
      false,
    );
  });

  test("fail-soft: a writeback error yields false (never throws)", async () => {
    expect(
      await reflectDistilled(fakeMemory({ throwOn: "writeback" }), "p1", {
        headline: "h",
        content: "c",
      }),
    ).toBe(false);
  });
});

async function* doneStream(): AsyncGenerator<MessageChunk> {
  yield { type: "done" };
}

// A one-shot turn seam that returns canned text (and captures the prompt it was given), so a
// distillation turn can be driven without a provider. `status` defaults to ok.
function fakeTurn(
  text: string,
  opts: { status?: "ok" | "error"; onPrompt?: (prompt: string) => void } = {},
): NonNullable<RibContext["runAgentTurn"]> {
  return (req) => {
    opts.onPrompt?.(req.prompt ?? "");
    return {
      stream: doneStream(),
      result: Promise.resolve({ status: opts.status ?? "ok", text }),
    };
  };
}

describe("distillOutcome", () => {
  const input = {
    task: "ship the feature",
    summary: "shipped it",
    facts: ["uses bun", "added a test"],
    recalled: ["[recalled decision] prefer the in-process fallback"],
  };

  test("a 'record' directive yields a distilled lesson (headline + content)", async () => {
    const res = await distillOutcome(
      fakeTurn(
        'reasoning\n{"action":"record","headline":"Bun runtime","lesson":"This repo builds with bun; run bun test before a PR."}',
      ),
      input,
    );
    expect(res).toEqual({
      kind: "lesson",
      headline: "Bun runtime",
      content: "This repo builds with bun; run bun test before a PR.",
    });
  });

  test("the prompt grounds the turn in the task, facts, and prior memory (delta discipline)", async () => {
    let prompt = "";
    await distillOutcome(fakeTurn('{"action":"skip"}', { onPrompt: (p) => (prompt = p) }), input);
    expect(prompt).toContain("ship the feature");
    expect(prompt).toContain("uses bun");
    // The recalled memory is shown so the turn records a delta, not a restatement.
    expect(prompt).toContain("Already in the team's memory");
    expect(prompt).toContain("prefer the in-process fallback");
  });

  test("the prompt forbids recording ephemeral run-status as a durable lesson", async () => {
    let prompt = "";
    await distillOutcome(fakeTurn('{"action":"skip"}', { onPrompt: (p) => (prompt = p) }), input);
    expect(prompt).toContain("run facts, not project knowledge");
  });

  test("a 'skip' directive abstains (the pollution gate)", async () => {
    const res = await distillOutcome(fakeTurn('nothing durable\n{"action":"skip"}'), input);
    expect(res).toEqual({ kind: "abstain" });
  });

  test("an unparseable reply is unavailable (caller falls back to raw), not abstain", async () => {
    const res = await distillOutcome(fakeTurn("just prose, no directive"), input);
    expect(res).toEqual({ kind: "unavailable" });
  });

  test("a malformed 'record' (empty lesson) is unavailable, not a silent empty row", async () => {
    const res = await distillOutcome(
      fakeTurn('{"action":"record","headline":"x","lesson":"   "}'),
      input,
    );
    expect(res).toEqual({ kind: "unavailable" });
  });

  test("a failed turn is unavailable (fail-soft)", async () => {
    const res = await distillOutcome(fakeTurn("", { status: "error" }), input);
    expect(res).toEqual({ kind: "unavailable" });
  });

  test("an already-aborted run is unavailable without spending a turn", async () => {
    let ran = false;
    const turn = fakeTurn('{"action":"record","headline":"h","lesson":"l"}', {
      onPrompt: () => (ran = true),
    });
    const ac = new AbortController();
    ac.abort();
    const res = await distillOutcome(turn, { ...input, abortSignal: ac.signal });
    expect(res).toEqual({ kind: "unavailable" });
    expect(ran).toBe(false);
  });
});
