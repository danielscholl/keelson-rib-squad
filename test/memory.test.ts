import { describe, expect, test } from "bun:test";
import type {
  MemoryTools,
  RecallItem,
  RecallResponse,
  WritebackRequest,
  WritebackResponse,
} from "@keelson/shared";
import { RECALL_RESPONSE_SCHEMA_VERSION, WRITEBACK_RESPONSE_SCHEMA_VERSION } from "@keelson/shared";
import { recallGrounding, reflectOutcome } from "../src/memory.ts";

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
  test("maps recalled decisions/lessons to grounding lines", async () => {
    const memory = fakeMemory({
      items: [recallItem("decision", "use bun"), recallItem("lesson", "tests need the symlink")],
    });
    const lines = await recallGrounding(memory, "p1", "ship the feature");
    expect(lines).toEqual([
      "[recalled decision] use bun",
      "[recalled lesson] tests need the symlink",
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
