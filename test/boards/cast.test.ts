import { describe, expect, test } from "bun:test";
import { canvasViewSchema } from "@keelson/shared";
import {
  APPROVE_CAST_ACTION,
  buildCastBoard,
  CAST_PICK_ACTION,
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
      slug: "atlas",
      name: "Atlas",
      role: "Backend Engineer",
      charter: "# Atlas\n\n## Role\n\nBuilds the search rib.",
      tools: ["code", "read"],
    },
    {
      slug: "vera",
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
function benchCards(board: ReturnType<typeof buildCastBoard>) {
  const section = board.sections.find((s) => s.kind === "cards");
  if (section?.kind !== "cards") throw new Error("no bench cards section");
  return section.items;
}
function charterRows(board: ReturnType<typeof buildCastBoard>) {
  const section = board.sections.find((s) => s.kind === "rows" && s.title === "Charters in full");
  if (section?.kind !== "rows") throw new Error("no charters rows section");
  return section.items;
}
function approve(board: ReturnType<typeof buildCastBoard>) {
  return actionItems(board).find((i) => i.type === APPROVE_CAST_ACTION);
}

describe("buildCastBoard idle", () => {
  test("renders a valid calm board with no proposal", () => {
    const board = buildCastBoard(undefined);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.view).toBe("board");
    expect(board.header?.status?.label).toBe("no proposal");
    // No approve/discard verbs and no shell rows when there is nothing to act on.
    expect(actionItems(board)).toHaveLength(0);
    expect(board.sections.some((s) => s.kind === "cards")).toBe(false);
    expect(board.sections).toEqual([]);
  });
});

describe("buildCastBoard with a proposal", () => {
  test("is a valid board; header counts picked of total and chips the project", () => {
    const board = buildCastBoard(proposal());
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.header?.status?.label).toBe("2 of 2 picked");
    expect(board.header?.chip).toBe("keelson");
  });

  test("one card per member carrying final name, role pill + capability (text-only fallback)", () => {
    const cards = benchCards(buildCastBoard(proposal()));
    expect(cards).toHaveLength(2);
    const atlas = cards.find((c) => c.title === "Atlas");
    expect(atlas?.pill?.label).toBe("Backend Engineer");
    expect(atlas?.fields?.find((f) => f.label === "can")?.value).toBe("code, read");
    const vera = cards.find((c) => c.title === "Vera");
    // A member with no capability tags reads as text-only, never blank.
    expect(vera?.fields?.find((f) => f.label === "can")?.value).toBe("text-only");
  });

  test("a cast member names its ensemble; an uncast one omits the field", () => {
    const cards = benchCards(
      buildCastBoard(
        proposal({
          members: [
            {
              slug: "mal",
              name: "Mal",
              role: "Tech Lead",
              charter: "# Mal\n\n## Mission\n\nHold the map.",
              tools: ["read"],
              model: "claude-opus-4-8",
              themeId: "firefly",
              themeLabel: "Firefly",
            },
            {
              slug: "atlas",
              name: "Atlas",
              role: "Engineer",
              charter: "# Atlas\n\n## Mission\n\nBuild.",
              tools: ["code", "read"],
            },
          ],
        }),
      ),
    );
    const mal = cards.find((c) => c.title === "Mal");
    expect(mal?.fields?.find((f) => f.label === "cast")?.value).toBe("Firefly");
    expect(mal?.fields?.find((f) => f.label === "model")?.value).toBe("claude-opus-4-8");
    const atlas = cards.find((c) => c.title === "Atlas");
    expect(atlas?.fields?.some((f) => f.label === "cast")).toBe(false);
  });

  test("a provider-only pin renders as the engine rather than as nothing", () => {
    const cards = benchCards(
      buildCastBoard(
        proposal({
          members: [
            {
              slug: "mal",
              name: "Mal",
              role: "Tech Lead",
              charter: "# Mal\n\n## Mission\n\nHold the map.",
              provider: "copilot",
            },
          ],
        }),
      ),
    );
    expect(cards[0]?.fields?.find((f) => f.label === "engine")?.value).toBe("copilot");
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

  test("the action constants are all distinct", () => {
    expect(
      new Set([CAST_PROPOSE_ACTION, CAST_PICK_ACTION, APPROVE_CAST_ACTION, DISCARD_CAST_ACTION])
        .size,
    ).toBe(4);
  });
});

describe("buildCastBoard picking", () => {
  test("the card body is the pick toggle: selected, declaring the desired next state", () => {
    const board = buildCastBoard(proposal());
    const atlas = benchCards(board).find((c) => c.title === "Atlas");
    expect(atlas?.selected).toBe(true);
    expect(atlas?.action).toEqual({
      type: CAST_PICK_ACTION,
      payload: { slug: "atlas", picked: false, castAt: "2026-06-27T00:00:00.000Z" },
    });
  });

  test("a dropped seat loses its ring and hue but keeps its fields and reason", () => {
    const board = buildCastBoard(
      proposal({
        members: [
          {
            slug: "atlas",
            name: "Atlas",
            role: "Engineer",
            charter: "# Atlas\n\n## Mission\n\nBuild.",
            tools: ["code", "read"],
            identitySlot: 0,
            picked: false,
          },
        ],
      }),
    );
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const atlas = benchCards(board)[0];
    expect(atlas?.selected).toBe(false);
    expect(atlas?.dot).toBe("neutral");
    expect(atlas?.pill).toEqual({ label: "dropped", tone: "warn" });
    // The reason to pick it back has to survive dropping it.
    expect(atlas?.reason?.text).toBe("Build.");
    expect(atlas?.fields?.find((f) => f.label === "can")?.value).toBe("code, read");
    // Picking it back declares picked: true.
    expect(atlas?.action?.payload).toEqual({
      slug: "atlas",
      picked: true,
      castAt: "2026-06-27T00:00:00.000Z",
    });
  });

  test("the header and the approve label count only the picked seats", () => {
    const p = proposal();
    p.members[1]!.picked = false;
    const board = buildCastBoard(p);
    expect(board.header?.status?.label).toBe("1 of 2 picked");
    expect(approve(board)?.label).toBe("Approve 1 & scaffold");
    // The confirm names the blast radius on both sides of the decision.
    expect(approve(board)?.confirm?.body).toContain("1 proposed member");
    expect(approve(board)?.confirm?.body).toContain("1 dropped seat");
  });

  test("every seat dropped gates approve with a reason instead of hiding it", () => {
    const p = proposal();
    for (const m of p.members) m.picked = false;
    const board = buildCastBoard(p);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.header?.status?.tone).toBe("warn");
    const a = approve(board);
    expect(a?.disabled).toBe(true);
    expect(a?.reason).toContain("Every seat is dropped");
    // The bench title inverts to say what to do about it.
    const bench = board.sections.find((s) => s.kind === "cards");
    expect(bench?.kind === "cards" && bench.title).toBe("Click a seat to pick it back");
  });

  test("approve and discard carry the proposal's createdAt so a stale click is rejectable", () => {
    const board = buildCastBoard(proposal());
    expect(approve(board)?.payload).toEqual({ castAt: "2026-06-27T00:00:00.000Z" });
    expect(actionItems(board).find((i) => i.type === DISCARD_CAST_ACTION)?.payload).toEqual({
      castAt: "2026-06-27T00:00:00.000Z",
    });
  });

  test("approve is the board's filled verb; discard stays the quiet destructive one", () => {
    const board = buildCastBoard(proposal());
    expect(approve(board)?.tone).toBe("brand");
    const discard = actionItems(board).find((i) => i.type === DISCARD_CAST_ACTION);
    expect(discard?.destructive).toBe(true);
    // The discard confirm has to name the price it used to hide.
    expect(discard?.confirm?.body).toContain("different team");
  });
});

describe("buildCastBoard reasons", () => {
  test("the scan's rationale is the card's reason when present", () => {
    const board = buildCastBoard(
      proposal({
        members: [
          {
            slug: "atlas",
            name: "Atlas",
            role: "Engineer",
            charter: "# Atlas\n\n## Mission\n\nBuild.",
            rationale: "src/search/ has 40 files and no owner.",
          },
        ],
      }),
    );
    expect(benchCards(board)[0]?.reason).toEqual({
      label: "why cast:",
      text: "src/search/ has 40 files and no owner.",
    });
  });

  test("no rationale degrades to the charter's mission excerpt, never to empty", () => {
    const board = buildCastBoard(proposal());
    const atlas = benchCards(board).find((c) => c.title === "Atlas");
    expect(atlas?.reason?.text).toBe("Builds the search rib.");
  });

  test("a charterless reason says so rather than rendering blank", () => {
    const board = buildCastBoard(
      proposal({
        members: [{ slug: "atlas", name: "Atlas", role: "Engineer", charter: "# Atlas" }],
      }),
    );
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(benchCards(board)[0]?.reason?.text).toBe("The scan returned no reason for this seat.");
  });
});

describe("buildCastBoard identity + charters", () => {
  test("cards wear the persisted identity tone; a slotless member folds to neutral", () => {
    const board = buildCastBoard(
      proposal({
        members: [
          {
            slug: "keyser",
            name: "Keyser",
            role: "Tech Lead",
            charter:
              "# Keyser\n\n_Cast from The Usual Suspects._\n\n## Mission\n\nGuard the seams.",
            identitySlot: 0,
          },
          {
            slug: "edie",
            name: "Edie",
            role: "Reviewer",
            charter: "# Edie\n\n## Mission\n\nReview everything.",
            identitySlot: 4,
          },
        ],
      }),
    );
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(benchCards(board).map((c) => c.dot)).toEqual(["id-blue", "id-olive"]);
    // A proposal member with no slot (an older stored proposal) folds to neutral.
    expect(benchCards(buildCastBoard(proposal()))[0]?.dot).toBe("neutral");
  });

  test("a 6th seat folds to neutral rather than repeating the 5th's hue", () => {
    const board = buildCastBoard(
      proposal({
        members: ["a", "b", "c", "d", "e", "f"].map((s, i) => ({
          slug: s,
          name: s.toUpperCase(),
          role: "Member",
          charter: `# ${s.toUpperCase()}\n\n## Mission\n\nWork.`,
          identitySlot: i,
        })),
      }),
    );
    expect(benchCards(board).map((c) => c.dot)).toEqual([
      "id-blue",
      "id-amber",
      "id-teal",
      "id-rose",
      "id-olive",
      "neutral",
    ]);
  });

  test("the charter appendix discloses the full md-stripped charter per member", () => {
    const board = buildCastBoard(
      proposal({
        members: [
          {
            slug: "atlas",
            name: "Atlas",
            role: "Engineer",
            charter:
              "# Atlas\n\n## Role\n\nEngineer\n\n## Mission\n\n**Build** and ship the `search` rib.",
          },
        ],
      }),
    );
    const row = charterRows(board).find((r) => r.chip?.label === "Atlas");
    expect(row?.text).toBe("cast as Engineer");
    // The member's own H1 name is dropped from the disclosed body — the appendix
    // never re-introduces its own member — and the charter's section newlines are
    // preserved so it reads as structured blocks, not one run-on paragraph.
    expect(row?.detail).toBe("Role\n\nEngineer\n\nMission\n\nBuild and ship the search rib.");
    expect(row?.detail).not.toContain("**");
    expect(row?.detail).not.toContain("`");
  });

  test("the charter appendix marks a dropped seat", () => {
    const p = proposal();
    p.members[1]!.picked = false;
    const rows = charterRows(buildCastBoard(p));
    expect(rows.find((r) => r.chip?.label === "Atlas")?.trailing).toBeUndefined();
    expect(rows.find((r) => r.chip?.label === "Vera")?.trailing).toBe("dropped");
  });
});
