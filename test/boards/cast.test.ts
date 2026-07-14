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

type Board = ReturnType<typeof buildCastBoard>;
type Leaf = Extract<
  Board["sections"][number],
  { kind: "columns" }
>["columns"][number]["sections"][number];

// The bench and the rail live inside a `columns` section, so flatten one level before
// looking for anything — `columns` nests leaves only, so one level is the whole tree.
function leaves(board: Board): Leaf[] {
  return board.sections.flatMap((s) =>
    s.kind === "columns" ? s.columns.flatMap((c) => c.sections) : [s],
  );
}
function actionItems(board: Board) {
  return leaves(board).flatMap((s) => (s.kind === "actions" ? s.items : []));
}
function benchCards(board: Board) {
  const section = leaves(board).find((s) => s.kind === "cards");
  if (section?.kind !== "cards") throw new Error("no bench cards section");
  return section.items;
}
function benchSection(board: Board) {
  const section = leaves(board).find((s) => s.kind === "cards");
  if (section?.kind !== "cards") throw new Error("no bench cards section");
  return section;
}
function rowsTitled(board: Board, title: string) {
  const section = leaves(board).find((s) => s.kind === "rows" && s.title === title);
  if (section?.kind !== "rows") throw new Error(`no rows section titled ${title}`);
  return section.items;
}
function charterRows(board: Board) {
  return rowsTitled(board, "Charters in full");
}
function briefRows(board: Board) {
  const section = leaves(board).find((s) => s.kind === "rows" && s.boxed === true);
  if (section?.kind !== "rows") throw new Error("no brief rows section");
  return section.items;
}
function statItems(board: Board) {
  const section = leaves(board).find((s) => s.kind === "stats");
  if (section?.kind !== "stats") throw new Error("no stats section");
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
    expect(benchSection(board).title).toBe("Click a seat to pick it back");
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

describe("buildCastBoard brief + stats", () => {
  test("the mission and the scan's thesis get a home — both were dead data", () => {
    const board = buildCastBoard(proposal({ summary: "an engineer and a reviewer" }));
    const rows = briefRows(board);
    expect(rows.find((r) => r.text === "your ask")?.trailing).toBe("ship the search rib");
    expect(rows.find((r) => r.text === "the thesis")?.trailing).toBe("an engineer and a reviewer");
  });

  test("no mission says so with a warn rather than rendering nothing", () => {
    const p = proposal();
    p.mission = undefined;
    const board = buildCastBoard(p);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const ask = briefRows(board).find((r) => r.text === "your ask");
    expect(ask?.glyph).toBe("warn");
    expect(ask?.trailing).toContain("cast from the repo alone");
  });

  test("never more than four stats — a fifth squeezes the value column", () => {
    const board = buildCastBoard(
      proposal({ read: { files: ["a.ts", "b.ts"], searches: 3, ms: 41_000 } }),
    );
    expect(statItems(board).length).toBeLessThanOrEqual(4);
  });

  test("stats count the picked seats, the bench against capacity, and the coders", () => {
    const p = proposal();
    p.members[1]!.picked = false;
    const items = statItems(buildCastBoard(p));
    expect(items.find((i) => i.label === "Picked")?.value).toBe("1 of 2");
    expect(items.find((i) => i.label === "Bench")?.value).toBe("2 of 6");
    expect(items.find((i) => i.label === "Can code")?.value).toBe(1);
  });

  test("a dropped coder stops counting toward Can code", () => {
    const p = proposal();
    p.members[0]!.picked = false; // Atlas is the only code-capable member
    expect(statItems(buildCastBoard(p)).find((i) => i.label === "Can code")?.value).toBe(0);
  });
});

describe("buildCastBoard scan receipt", () => {
  const withRead = (over: Partial<{ files: string[]; searches: number; ms: number }> = {}) =>
    proposal({ read: { files: ["src/a.ts", "src/b.ts"], searches: 4, ms: 41_000, ...over } });

  test("reports what the scan actually opened, with the file list on disclosure", () => {
    const files = Array.from({ length: 31 }, (_, i) => `src/f${i}.ts`);
    const board = buildCastBoard(withRead({ files, searches: 14, ms: 134_000 }));
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const rows = rowsTitled(board, "Scan receipt");
    expect(rows[0]?.text).toBe("31 files read");
    expect(rows[0]?.trailing).toBe("2m 14s");
    expect(rows[0]?.detail).toContain("src/f0.ts");
    expect(rows[1]?.text).toBe("14 searches");
    expect(statItems(board).find((i) => i.label === "Files read")?.value).toBe(31);
  });

  test("a thin scan is toned and named, not just printed", () => {
    const board = buildCastBoard(withRead({ files: ["src/a.ts"], searches: 1, ms: 41_000 }));
    const rows = rowsTitled(board, "Scan receipt");
    expect(rows[0]?.glyph).toBe("warn");
    expect(rows.some((r) => r.text.startsWith("Thin:"))).toBe(true);
    expect(statItems(board).find((i) => i.label === "Files read")?.tone).toBe("warn");
  });

  test("a thorough scan reads as ok and raises no thin warning", () => {
    const files = Array.from({ length: 31 }, (_, i) => `src/f${i}.ts`);
    const board = buildCastBoard(withRead({ files }));
    expect(rowsTitled(board, "Scan receipt")[0]?.glyph).toBe("ok");
    expect(rowsTitled(board, "Scan receipt").some((r) => r.text.startsWith("Thin:"))).toBe(false);
    expect(statItems(board).find((i) => i.label === "Files read")?.tone).toBe("ok");
  });

  test("no capture says so — never a fabricated or zeroed receipt", () => {
    const board = buildCastBoard(proposal());
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const rows = rowsTitled(board, "Scan receipt");
    expect(rows[0]?.text).toContain("didn't report what the scan opened");
    // A "0 files read" stat would be a claim the empty capture can't support.
    expect(statItems(board).some((i) => i.label === "Files read")).toBe(false);
  });

  test("a huge file list is capped so the board degrades instead of failing to render", () => {
    // rows.detail is max(4000): an uncapped list breaches it on a thorough scan of a
    // big repo and takes the WHOLE board down through expectView.
    const files = Array.from({ length: 400 }, (_, i) => `src/some/deep/path/module-${i}.ts`);
    const board = buildCastBoard(withRead({ files }));
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const detail = rowsTitled(board, "Scan receipt")[0]?.detail ?? "";
    expect(detail.length).toBeLessThanOrEqual(4000);
    expect(detail).toContain("…and 340 more");
    // The count still tells the truth even though the list is elided.
    expect(statItems(board).find((i) => i.label === "Files read")?.value).toBe(400);
  });

  test("the bench sits beside the rail — the adjacency is the judgement", () => {
    const board = buildCastBoard(withRead());
    const cols = board.sections.find((s) => s.kind === "columns");
    if (cols?.kind !== "columns") throw new Error("no columns section");
    expect(cols.columns[0]?.sections[0]?.kind).toBe("cards");
    expect(cols.columns[1]?.sections[0]?.kind).toBe("rows");
    // The bench gets the weight; the rail is the counterweight, not the peer.
    expect(cols.columns[0]?.weight).toBeGreaterThan(cols.columns[1]?.weight ?? 1);
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
