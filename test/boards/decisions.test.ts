import { describe, expect, test } from "bun:test";
import { canvasViewSchema } from "@keelson/shared";
import {
  buildDecisionsBoard,
  type DecisionItem,
  RECORD_DECISION_ACTION,
} from "../../src/boards/decisions.ts";

const decision = (over: Partial<DecisionItem> = {}): DecisionItem => ({
  summary: "Adopt trunk-based development",
  type: "decision",
  content: "Merge small PRs to main daily rather than long-lived branches.",
  provenance: "generated",
  createdAt: "2026-06-20T12:00:00.000Z",
  ...over,
});

function actionItems(board: ReturnType<typeof buildDecisionsBoard>) {
  return board.sections.flatMap((s) => (s.kind === "actions" ? s.items : []));
}
function cards(board: ReturnType<typeof buildDecisionsBoard>) {
  const section = board.sections.find((s) => s.kind === "cards");
  if (section?.kind !== "cards") throw new Error("no cards section");
  return section.items;
}

describe("buildDecisionsBoard cold start", () => {
  test("is a valid board with the ledger header at 0 decisions", () => {
    const board = buildDecisionsBoard([]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.view).toBe("board");
    expect(board.header?.chip).toBe("ledger");
    expect(board.header?.status?.label).toBe("0 decisions");
  });

  test("has no cards section but still offers the record action", () => {
    const board = buildDecisionsBoard([]);
    expect(board.sections.some((s) => s.kind === "cards")).toBe(false);
    const record = actionItems(board).find((i) => i.type === RECORD_DECISION_ACTION);
    expect(record).toBeDefined();
    expect(record?.fields?.map((f) => f.name)).toEqual(["summary", "content"]);
  });
});

describe("buildDecisionsBoard populated", () => {
  test("valid; header counts singular/plural", () => {
    expect(buildDecisionsBoard([decision()]).header?.status?.label).toBe("1 decision");
    const two = buildDecisionsBoard([decision(), decision({ summary: "Use Bun" })]);
    expect(canvasViewSchema.safeParse(two).success).toBe(true);
    expect(two.header?.status?.label).toBe("2 decisions");
  });

  test("one card per decision with summary, type pill, fields, and a context reason", () => {
    const board = buildDecisionsBoard([decision()]);
    const card = cards(board)[0];
    expect(card?.title).toBe("Adopt trunk-based development");
    expect(card?.pill?.label).toBe("decision");
    expect(card?.fields?.find((f) => f.label === "provenance")?.value).toBe("generated");
    expect(card?.fields?.find((f) => f.label === "recorded")?.value).toBe("2026-06-20");
    expect(card?.reason?.text).toContain("Merge small PRs");
  });

  test("a lesson type and lifecycle render through; lifecycle tones the dot", () => {
    const board = buildDecisionsBoard([
      decision({ type: "lesson", lifecycle: "superseded", summary: "Old approach" }),
    ]);
    const card = cards(board)[0];
    expect(card?.pill?.label).toBe("lesson");
    expect(card?.fields?.find((f) => f.label === "lifecycle")?.value).toBe("superseded");
    expect(card?.dot).toBe("warn");
  });

  test("missing optional fields degrade gracefully and stay valid", () => {
    const board = buildDecisionsBoard([{ summary: "Bare decision" }]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const card = cards(board)[0];
    expect(card?.pill?.label).toBe("decision"); // type fallback
    expect(card?.reason).toBeUndefined(); // no content -> no reason line
    expect(card?.fields ?? []).toEqual([]); // no provenance/lifecycle/date
  });

  test("populated boards still carry the record action last", () => {
    const board = buildDecisionsBoard([decision()]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(actionItems(board).some((i) => i.type === RECORD_DECISION_ACTION)).toBe(true);
    expect(board.sections[board.sections.length - 1]?.kind).toBe("actions");
  });
});
