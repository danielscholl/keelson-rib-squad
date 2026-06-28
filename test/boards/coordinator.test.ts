import { describe, expect, test } from "bun:test";
import { canvasViewSchema } from "@keelson/shared";
import { buildCoordinatorBoard } from "../../src/boards/coordinator.ts";
import type { CoordinatorLedger } from "../../src/coordinator.ts";

const ledger = (over: Partial<CoordinatorLedger> = {}): CoordinatorLedger => ({
  task: "ship the search rib",
  facts: [],
  plan: [],
  round: 0,
  stallCount: 0,
  resetCount: 0,
  status: "active",
  transcript: [],
  createdAt: "2026-06-28T00:00:00.000Z",
  updatedAt: "2026-06-28T00:00:00.000Z",
  ...over,
});

function rowsTitled(board: ReturnType<typeof buildCoordinatorBoard>, title: string) {
  const section = board.sections.find((s) => s.kind === "rows" && s.title === title);
  return section?.kind === "rows" ? section.items : [];
}

describe("buildCoordinatorBoard idle", () => {
  test("renders a valid calm board with no ledger", () => {
    const board = buildCoordinatorBoard(undefined);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.view).toBe("board");
    expect(board.header?.status?.label).toBe("idle");
  });
});

describe("buildCoordinatorBoard with a ledger", () => {
  test("is a valid board; header carries the status pill + round chip", () => {
    const board = buildCoordinatorBoard(ledger({ status: "active", round: 3 }));
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.header?.status?.label).toBe("active");
    expect(board.header?.chip).toBe("round 3");
  });

  test("renders the goal, plan, findings, and abandoned steps", () => {
    const board = buildCoordinatorBoard(
      ledger({
        plan: ["investigate", "implement"],
        facts: ["uses bun"],
        failedSteps: ["atlas: do X"],
      }),
    );
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(rowsTitled(board, "Goal").some((i) => i.text.includes("ship the search rib"))).toBe(
      true,
    );
    expect(rowsTitled(board, "Plan")).toHaveLength(2);
    expect(rowsTitled(board, "Findings").some((i) => i.text.includes("uses bun"))).toBe(true);
    expect(
      rowsTitled(board, "Abandoned — do not resume").some((i) => i.text.includes("atlas: do X")),
    ).toBe(true);
  });

  test("a completed run shows the outcome and a done status", () => {
    const board = buildCoordinatorBoard(
      ledger({ status: "done", summary: "shipped it", round: 5 }),
    );
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.header?.status?.label).toBe("done");
    expect(rowsTitled(board, "Outcome").some((i) => i.text.includes("shipped it"))).toBe(true);
  });

  test("recent activity surfaces the transcript entries", () => {
    const board = buildCoordinatorBoard(
      ledger({
        transcript: [
          {
            round: 0,
            kind: "dispatch",
            speaker: "atlas",
            instruction: "do X",
            text: "did the work",
          },
          { round: 1, kind: "replan", text: "stalled — rebuilding the plan" },
        ],
      }),
    );
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(rowsTitled(board, "Recent activity").length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(board)).toContain("did the work");
  });

  test("omits empty sections with a bare ledger", () => {
    const board = buildCoordinatorBoard(ledger());
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(rowsTitled(board, "Plan")).toHaveLength(0);
    expect(rowsTitled(board, "Findings")).toHaveLength(0);
    expect(rowsTitled(board, "Abandoned — do not resume")).toHaveLength(0);
  });
});
