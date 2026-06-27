import { describe, expect, test } from "bun:test";
import { canvasViewSchema } from "@keelson/shared";
import {
  APPROVE_CAST_ACTION,
  buildCastBoard,
  CAST_PROPOSE_ACTION,
  DISCARD_CAST_ACTION,
} from "../../src/boards/cast.ts";
import type { CastProposalRecord } from "../../src/cast.ts";

const proposal = (over: Partial<CastProposalRecord> = {}): CastProposalRecord => ({
  projectId: "p1",
  projectName: "keelson",
  rootPath: "/repo/keelson",
  mission: "ship the search rib",
  members: [
    {
      name: "Atlas",
      role: "Backend Engineer",
      charter: "# Atlas\n\n## Role\n\nBuilds the search rib.",
      tools: ["code", "read"],
    },
    {
      name: "Vera",
      role: "Reviewer",
      charter: "# Vera\n\n## Role\n\nReviews changes for correctness.",
    },
  ],
  notes: [],
  createdAt: "2026-06-27T00:00:00.000Z",
  ...over,
});

function actionItems(board: ReturnType<typeof buildCastBoard>) {
  return board.sections.flatMap((s) => (s.kind === "actions" ? s.items : []));
}
function cards(board: ReturnType<typeof buildCastBoard>) {
  const section = board.sections.find((s) => s.kind === "cards");
  if (section?.kind !== "cards") throw new Error("no cards section");
  return section.items;
}

describe("buildCastBoard idle", () => {
  test("renders a valid calm board with no proposal", () => {
    const board = buildCastBoard(undefined);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.view).toBe("board");
    expect(board.header?.status?.label).toBe("no proposal");
    // No approve/discard verbs when there is nothing to act on.
    expect(actionItems(board)).toHaveLength(0);
    expect(board.sections.some((s) => s.kind === "cards")).toBe(false);
  });
});

describe("buildCastBoard with a proposal", () => {
  test("is a valid board; header counts members and chips the project", () => {
    const board = buildCastBoard(proposal());
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.header?.status?.label).toBe("2 members");
    expect(board.header?.chip).toBe("keelson");
  });

  test("one card per member carrying role + capability tags (text-only fallback)", () => {
    const items = cards(buildCastBoard(proposal()));
    expect(items).toHaveLength(2);
    const atlas = items.find((c) => c.title === "Atlas");
    expect(atlas?.pill?.label).toBe("Backend Engineer");
    expect(atlas?.fields?.find((f) => f.label === "tools")?.value).toBe("code, read");
    const vera = items.find((c) => c.title === "Vera");
    // A member with no capability tags reads as text-only, never blank.
    expect(vera?.fields?.find((f) => f.label === "tools")?.value).toBe("text-only");
  });

  test("always offers Approve & scaffold and Discard", () => {
    const types = actionItems(buildCastBoard(proposal())).map((i) => i.type);
    expect(types).toContain(APPROVE_CAST_ACTION);
    expect(types).toContain(DISCARD_CAST_ACTION);
  });

  test("surfaces a cap/truncation note when present", () => {
    const board = buildCastBoard(proposal({ notes: ["proposed 9 members — capped to 6"] }));
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(JSON.stringify(board)).toContain("capped to 6");
  });

  test("the propose action constant is distinct from approve/discard", () => {
    expect(new Set([CAST_PROPOSE_ACTION, APPROVE_CAST_ACTION, DISCARD_CAST_ACTION]).size).toBe(3);
  });

  test("the charter excerpt prefers the Mission line over the one-word Role body (#12)", () => {
    const board = buildCastBoard(
      proposal({
        members: [
          {
            name: "Atlas",
            role: "Engineer",
            charter:
              "# Atlas\n\n## Role\n\nEngineer\n\n## Mission\n\nBuild and ship the search rib.",
          },
        ],
      }),
    );
    const card = cards(board).find((c) => c.title === "Atlas");
    expect(card?.reason?.text).toBe("Build and ship the search rib.");
    expect(card?.reason?.text).not.toBe("Engineer");
  });
});
