import { describe, expect, test } from "bun:test";
import { canvasViewSchema } from "@keelson/shared";
import { buildRunDetailBoard } from "../../src/boards/coordinator.ts";
import { buildRunsBoard, VIEW_RUN_ACTION } from "../../src/boards/runs.ts";
import type { CoordinatorLedger } from "../../src/coordinator.ts";
import type { RunSummary } from "../../src/runs-store.ts";

const run = (over: Partial<RunSummary> = {}): RunSummary => ({
  id: "2026-07-02T16-14-45-216Z",
  task: "Implement **the** usage tab",
  status: "done",
  round: 11,
  createdAt: "2026-07-02T16:14:45.216Z",
  updatedAt: "2026-07-02T16:54:00.000Z",
  ...over,
});

describe("buildRunsBoard", () => {
  test("renders one card per run with a status pill and a View action carrying the id", () => {
    const board = buildRunsBoard([run(), run({ id: "r2", status: "max-rounds", round: 16 })]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const cards = board.sections.find((s) => s.kind === "cards");
    if (cards?.kind !== "cards") throw new Error("no cards section");
    expect(cards.items).toHaveLength(2);
    const first = cards.items[0];
    // Markdown is stripped from the task title.
    expect(first?.title).toBe("Implement the usage tab");
    expect(first?.pill?.label).toBe("done");
    expect(first?.pill?.tone).toBe("ok");
    const view = first?.actions?.[0];
    expect(view?.type).toBe(VIEW_RUN_ACTION);
    expect(view?.payload).toEqual({ id: "2026-07-02T16-14-45-216Z" });
    expect(cards.items[1]?.pill?.tone).toBe("caution");
  });

  test("no runs renders the calm idle board", () => {
    const board = buildRunsBoard([]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.header?.status?.label).toBe("no runs");
  });
});

describe("buildRunDetailBoard", () => {
  const ledger = (over: Partial<CoordinatorLedger> = {}): CoordinatorLedger => ({
    task: "ship it",
    facts: [],
    plan: [],
    round: 3,
    stallCount: 0,
    resetCount: 0,
    status: "done",
    summary: "shipped",
    transcript: [
      { round: 0, kind: "code", speaker: "atlas", text: "edited", provider: "claude" },
      { round: 1, kind: "verify", text: "verification passed: 2 checks", verdict: "pass" },
    ],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:30:00.000Z",
    ...over,
  });

  test("renders the archived run's sections without the task composer", () => {
    const board = buildRunDetailBoard(ledger(), "r1");
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.title).toBe("Run");
    expect(board.header?.chip).toBe("r1");
    expect(board.header?.status?.label).toBe("done");
    // A history drawer is read-only: no composer, no actions at all.
    expect(board.sections.some((s) => s.kind === "actions")).toBe(false);
    // The full run body is there: standup + gate history + minds + ledger groups.
    const titles = board.sections.map((s) => ("title" in s ? s.title : undefined));
    expect(titles).toContain("Standup");
    expect(titles).toContain("Gate history");
    expect(titles).toContain("Minds");
  });

  test("an unknown run renders a calm not-found board", () => {
    const board = buildRunDetailBoard(undefined, "missing-id");
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.header?.status?.label).toBe("not found");
    expect(JSON.stringify(board)).toContain("missing-id");
  });
});
