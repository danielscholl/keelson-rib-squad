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
function memberRows(board: ReturnType<typeof buildCastBoard>) {
  const section = board.sections.find((s) => s.kind === "rows" && s.title === "Members");
  if (section?.kind !== "rows") throw new Error("no members rows section");
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

  test("one row per member carrying final name, role + capability tags (text-only fallback)", () => {
    const items = memberRows(buildCastBoard(proposal()));
    expect(items).toHaveLength(2);
    const atlas = items.find((r) => r.chip?.label === "Atlas");
    // The role leads the summary as "cast as …"; capability + model stay in trailing.
    expect(atlas?.text).toContain("cast as Backend Engineer");
    expect(atlas?.trailing).toContain("code, read");
    expect(atlas?.trailing).not.toContain("Backend Engineer");
    const vera = items.find((r) => r.chip?.label === "Vera");
    // A member with no capability tags reads as text-only, never blank.
    expect(vera?.trailing).toContain("text-only");
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

  test("the charter row prefers the Mission line and discloses the full md-stripped charter", () => {
    const board = buildCastBoard(
      proposal({
        members: [
          {
            name: "Atlas",
            role: "Engineer",
            charter:
              "# Atlas\n\n## Role\n\nEngineer\n\n## Mission\n\n**Build** and ship the `search` rib.",
          },
        ],
      }),
    );
    const row = memberRows(board).find((r) => r.chip?.label === "Atlas");
    expect(row?.text).toBe("cast as Engineer — Build and ship the search rib.");
    // The member's own H1 name is dropped from the disclosed body — the card
    // never re-introduces its own member — and the charter's section newlines are
    // preserved so it reads as structured blocks, not one run-on paragraph.
    expect(row?.detail).toBe("Role\n\nEngineer\n\nMission\n\nBuild and ship the search rib.");
    expect(row?.detail).not.toContain("**");
    expect(row?.detail).not.toContain("`");
  });

  test("short charters still disclose the full md-stripped charter", () => {
    const board = buildCastBoard(
      proposal({
        members: [
          {
            name: "Atlas",
            role: "Engineer",
            charter: "# Atlas\n\n## Mission\n\nBuild.",
          },
        ],
      }),
    );
    const row = memberRows(board).find((r) => r.chip?.label === "Atlas");
    expect(row?.text).toBe("cast as Engineer — Build.");
    expect(row?.detail).toBe("Mission\n\nBuild.");
  });

  test("a leading provenance line never becomes the excerpt, even without a Mission section", () => {
    const board = buildCastBoard(
      proposal({
        members: [
          {
            name: "Keyser",
            role: "Tech Lead",
            charter: "# Keyser\n\n_Cast from The Usual Suspects._\n\nGuard the seams.",
          },
        ],
      }),
    );
    const row = memberRows(board).find((r) => r.chip?.label === "Keyser");
    expect(row?.text).toBe("cast as Tech Lead — Guard the seams.");
    expect(row?.detail).toBe("Guard the seams.");
  });

  test("member rows wear the persisted identity tone; the cast-provenance line is dropped", () => {
    const board = buildCastBoard(
      proposal({
        members: [
          {
            name: "Keyser",
            role: "Tech Lead",
            charter:
              "# Keyser\n\n_Cast from The Usual Suspects._\n\n## Mission\n\nGuard the seams.",
            identitySlot: 0,
          },
          {
            name: "Edie",
            role: "Reviewer",
            charter: "# Edie\n\n## Mission\n\nReview everything.",
            identitySlot: 4,
          },
        ],
      }),
    );
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const keyser = memberRows(board).find((r) => r.chip?.label === "Keyser");
    expect(keyser?.chip?.tone).toBe("id-blue");
    expect(keyser?.glyph).toBe("id-blue");
    expect(keyser?.detail).toBe("Mission\n\nGuard the seams.");
    expect(keyser?.detail).not.toContain("_");
    const edie = memberRows(board).find((r) => r.chip?.label === "Edie");
    expect(edie?.chip?.tone).toBe("id-olive");
    // A proposal member with no slot (an older stored proposal) folds to neutral.
    const slotless = memberRows(buildCastBoard(proposal()))[0];
    expect(slotless?.chip?.tone).toBe("neutral");
  });
});
