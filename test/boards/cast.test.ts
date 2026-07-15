import { describe, expect, test } from "bun:test";
import { canvasViewSchema } from "@keelson/shared";
import {
  APPROVE_CAST_ACTION,
  buildCastBoard,
  CAST_MODEL_ACTION,
  CAST_PICK_ACTION,
  CAST_PROPOSE_ACTION,
  DISCARD_CAST_ACTION,
  VIEW_CHARTER_ACTION,
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

function actionItems(board: Board) {
  return board.sections.flatMap((s) => (s.kind === "actions" ? s.items : []));
}
// The briefing is a `cards` section too, so the bench keys on `grid` — the one thing
// that tells them apart. Keying on kind alone silently returns the briefing.
function benchSection(board: Board) {
  const section = board.sections.find((s) => s.kind === "cards" && s.grid === true);
  if (section?.kind !== "cards") throw new Error("no bench cards section");
  return section;
}
function benchCards(board: Board) {
  return benchSection(board).items;
}
function briefCard(board: Board) {
  const section = board.sections.find((s) => s.kind === "cards" && s.grid !== true);
  if (section?.kind !== "cards") throw new Error("no briefing card section");
  return section.items[0];
}
function provenanceRows(board: Board) {
  const section = board.sections.find((s) => s.kind === "rows");
  if (section?.kind !== "rows") throw new Error("no provenance rows section");
  return section.items;
}
function receipt(board: Board) {
  const rows = provenanceRows(board);
  return rows[rows.length - 1];
}
function cardAction(board: Board, title: string, type: string) {
  return benchCards(board)
    .find((c) => c.title === title)
    ?.actions?.find((a) => a.type === type);
}
function approve(board: Board) {
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

  test("four sections: the claim, its provenance, the bench, the decision", () => {
    const board = buildCastBoard(proposal());
    expect(board.sections.map((s) => s.kind)).toEqual(["cards", "rows", "cards", "actions"]);
  });

  test("one card per member carrying final name and role pill", () => {
    const cards = benchCards(buildCastBoard(proposal()));
    expect(cards).toHaveLength(2);
    expect(cards.find((c) => c.title === "Atlas")?.pill?.label).toBe("Backend Engineer");
    expect(cards.find((c) => c.title === "Vera")?.pill?.label).toBe("Reviewer");
  });

  test("always offers Approve & scaffold and Discard", () => {
    const types = actionItems(buildCastBoard(proposal())).map((i) => i.type);
    expect(types).toContain(APPROVE_CAST_ACTION);
    expect(types).toContain(DISCARD_CAST_ACTION);
  });

  test("the action constants are all distinct", () => {
    expect(
      new Set([
        CAST_PROPOSE_ACTION,
        CAST_PICK_ACTION,
        CAST_MODEL_ACTION,
        VIEW_CHARTER_ACTION,
        APPROVE_CAST_ACTION,
        DISCARD_CAST_ACTION,
      ]).size,
    ).toBe(6);
  });
});

describe("buildCastBoard capability", () => {
  test("code is marked; a read-only seat carries no tone at all", () => {
    const cards = benchCards(buildCastBoard(proposal()));
    const atlas = cards.find((c) => c.title === "Atlas")?.fields?.[0];
    // Write access is the one thing the governance floor exists to bound.
    expect(atlas).toEqual({ value: "✎ code, read", tone: "caution" });
    const vera = cards.find((c) => c.title === "Vera")?.fields?.[0];
    // `dim` is not in canvasToneSchema: toning the norm here fails the whole board.
    expect(vera?.tone).toBeUndefined();
  });

  test("a member with no capability tags reads as text-only, never blank", () => {
    expect(
      benchCards(buildCastBoard(proposal())).find((c) => c.title === "Vera")?.fields?.[0],
    ).toEqual({ value: "text-only" });
  });

  test("a read-only seat with tags lists them unmarked", () => {
    const board = buildCastBoard(
      proposal({
        members: [
          { slug: "vera", name: "Vera", role: "Reviewer", charter: "# Vera", tools: ["read"] },
        ],
      }),
    );
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(benchCards(board)[0]?.fields?.[0]).toEqual({ value: "read" });
  });
});

describe("buildCastBoard the ensemble hoist", () => {
  const cast = (members: CastProposalRecord["members"]) => buildCastBoard(proposal({ members }));
  const seat = (slug: string, over: Partial<CastProposalRecord["members"][number]> = {}) => ({
    slug,
    name: slug[0]!.toUpperCase() + slug.slice(1),
    role: "Member",
    charter: `# ${slug}\n\n## Mission\n\nWork.`,
    ...over,
  });

  test("one ensemble across the bench hoists to the briefing and leaves the cards", () => {
    const board = cast([
      seat("mal", { themeId: "firefly", themeLabel: "Firefly" }),
      seat("zoe", { themeId: "firefly", themeLabel: "Firefly" }),
    ]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(briefCard(board)?.title).toBe("Firefly ensemble");
    expect(benchCards(board).every((c) => !c.fields?.some((f) => f.label === "cast"))).toBe(true);
  });

  test("a cast spanning two ensembles counts them and keeps the field on the cards", () => {
    // themeSelectionOrder rolls to the next ensemble when the active one runs out of
    // capacity, so a cast genuinely can span two — hoisting would name only one.
    const board = cast([
      seat("mal", { themeId: "firefly", themeLabel: "Firefly" }),
      seat("keyser", { themeId: "suspects", themeLabel: "The Usual Suspects" }),
    ]);
    expect(briefCard(board)?.title).toBe("2 ensembles");
    expect(cardFieldValue(board, "Mal", "cast")).toBe("Firefly");
    expect(cardFieldValue(board, "Keyser", "cast")).toBe("The Usual Suspects");
  });

  test("a themed seat beside an uncast one is not uniform — the field stays where it's true", () => {
    // assignThemedIdentity leaves a seat uncast when every ensemble is exhausted.
    const board = cast([seat("mal", { themeId: "firefly", themeLabel: "Firefly" }), seat("atlas")]);
    expect(briefCard(board)?.title).toBe("keelson");
    expect(cardFieldValue(board, "Mal", "cast")).toBe("Firefly");
    expect(
      benchCards(board)
        .find((c) => c.title === "Atlas")
        ?.fields?.some((f) => f.label === "cast"),
    ).toBe(false);
  });

  test("a wholly uncast bench falls back to the project name", () => {
    const board = cast([seat("atlas"), seat("vera")]);
    expect(briefCard(board)?.title).toBe("keelson");
  });

  test("the hoist judges the picked seats, not the dropped ones", () => {
    const board = cast([
      seat("mal", { themeId: "firefly", themeLabel: "Firefly" }),
      seat("keyser", { themeId: "suspects", themeLabel: "The Usual Suspects", picked: false }),
    ]);
    expect(briefCard(board)?.title).toBe("Firefly ensemble");
  });

  test("an all-dropped bench still names its ensemble rather than going blank", () => {
    const board = cast([
      seat("mal", { themeId: "firefly", themeLabel: "Firefly", picked: false }),
      seat("zoe", { themeId: "firefly", themeLabel: "Firefly", picked: false }),
    ]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(briefCard(board)?.title).toBe("Firefly ensemble");
  });

  test("an empty project name still yields a renderable title — card titles are min(1)", () => {
    const board = buildCastBoard(proposal({ projectName: "" }));
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(briefCard(board)?.title).toBe("Proposed squad");
  });

  function cardFieldValue(board: Board, title: string, label: string) {
    return benchCards(board)
      .find((c) => c.title === title)
      ?.fields?.find((f) => f.label === label)?.value;
  }
});

describe("buildCastBoard the briefing card", () => {
  test("the claim wears a card: the ensemble, the capacity, the thesis", () => {
    const board = buildCastBoard(proposal({ summary: "an engineer and a reviewer" }));
    const card = briefCard(board);
    expect(card?.pill?.label).toBe("2 of 6 seats");
    expect(card?.reason?.text).toBe("an engineer and a reviewer");
    // No label on the thesis: the card's own rule already divides it from the head.
    expect(card?.reason?.label).toBeUndefined();
  });

  test("the ask rides the card; its absence is a provenance row, not a blank", () => {
    expect(briefCard(buildCastBoard(proposal()))?.footnote).toBe("your ask: ship the search rib");
    const p = proposal();
    p.mission = undefined;
    const board = buildCastBoard(p);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(briefCard(board)?.footnote).toBeUndefined();
    const warn = provenanceRows(board).find((r) => r.text.includes("cast from the repo alone"));
    expect(warn?.glyph).toBe("warn");
  });

  test("the pill counts the picked seats against capacity, not the bench", () => {
    const p = proposal();
    p.members[1]!.picked = false;
    expect(briefCard(buildCastBoard(p))?.pill?.label).toBe("1 of 6 seats");
  });

  test("a thesis-less scan renders the card without an empty reason", () => {
    const board = buildCastBoard(proposal());
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(briefCard(board)?.reason).toBeUndefined();
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

  test("a dropped seat loses its ring and hue but keeps its capability and purpose", () => {
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
    expect(atlas?.fields?.[0]?.value).toBe("✎ code, read");
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

describe("buildCastBoard card verbs", () => {
  test("the model verb is a lone modelPicker field — the host's solo-picker fast path", () => {
    const board = buildCastBoard(proposal());
    const a = cardAction(board, "Atlas", CAST_MODEL_ACTION);
    expect(a?.label).toBe("Model — default");
    expect(a?.payload).toEqual({ slug: "atlas", castAt: "2026-06-27T00:00:00.000Z" });
    expect(a?.fields).toHaveLength(1);
    expect(a?.fields?.[0]?.modelPicker?.providerField).toBe("provider");
    // Nothing to seed on an unpinned seat.
    expect(a?.fields?.[0]?.modelPicker?.providerDefault).toBeUndefined();
    expect(a?.fields?.[0]?.defaultValue).toBeUndefined();
  });

  test("a pinned seat reads its model off the label and seeds the picker", () => {
    const board = buildCastBoard(
      proposal({
        members: [
          {
            slug: "mal",
            name: "Mal",
            role: "Tech Lead",
            charter: "# Mal\n\n## Mission\n\nHold the map.",
            provider: "anthropic",
            model: "claude-opus-4-8",
          },
        ],
      }),
    );
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const a = cardAction(board, "Mal", CAST_MODEL_ACTION);
    expect(a?.label).toBe("Model — claude-opus-4-8");
    expect(a?.fields?.[0]?.defaultValue).toBe("claude-opus-4-8");
    expect(a?.fields?.[0]?.modelPicker?.providerDefault).toBe("anthropic");
  });

  test("a provider-only pin names its vendor rather than reading as the harness default", () => {
    // validateProviderPin admits a provider with no model, and the label is the only
    // place that pin is visible now that the card carries no model field.
    const board = buildCastBoard(
      proposal({
        members: [
          { slug: "mal", name: "Mal", role: "Tech Lead", charter: "# Mal", provider: "copilot" },
        ],
      }),
    );
    const a = cardAction(board, "Mal", CAST_MODEL_ACTION);
    expect(a?.label).toBe("Model — copilot default");
    expect(a?.fields?.[0]?.modelPicker?.providerDefault).toBe("copilot");
  });

  test("the charter verb is an icon with a hover hint, carrying the stale-click guard", () => {
    const a = cardAction(buildCastBoard(proposal()), "Atlas", VIEW_CHARTER_ACTION);
    expect(a?.label).toBe("▤");
    expect(a?.hint).toBe("Charter");
    expect(a?.payload).toEqual({ slug: "atlas", castAt: "2026-06-27T00:00:00.000Z" });
  });

  test("both card verbs ride every seat, dropped included", () => {
    const p = proposal();
    p.members[1]!.picked = false;
    const board = buildCastBoard(p);
    for (const card of benchCards(board)) {
      expect(card.actions?.map((a) => a.type)).toEqual([CAST_MODEL_ACTION, VIEW_CHARTER_ACTION]);
    }
  });
});

describe("buildCastBoard purpose", () => {
  test("the card's prose is what the seat is FOR, not the scan's argument for it", () => {
    const board = buildCastBoard(
      proposal({
        members: [
          {
            slug: "atlas",
            name: "Atlas",
            role: "Engineer",
            charter: "# Atlas\n\n## Mission\n\nBuild and ship the search rib.",
            rationale: "src/search/ has 40 files and no owner.",
          },
        ],
      }),
    );
    // The rationale is a one-time read; it moves to the charter board.
    expect(benchCards(board)[0]?.reason).toEqual({ text: "Build and ship the search rib." });
  });

  test("a charterless seat falls back to the scan's rationale rather than going blank", () => {
    const board = buildCastBoard(
      proposal({
        members: [
          {
            slug: "atlas",
            name: "Atlas",
            role: "Engineer",
            charter: "# Atlas",
            rationale: "src/search/ has 40 files and no owner.",
          },
        ],
      }),
    );
    expect(benchCards(board)[0]?.reason?.text).toBe("src/search/ has 40 files and no owner.");
  });

  test("no charter and no rationale still says something rather than rendering blank", () => {
    const board = buildCastBoard(
      proposal({
        members: [{ slug: "atlas", name: "Atlas", role: "Engineer", charter: "# Atlas" }],
      }),
    );
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(benchCards(board)[0]?.reason?.text).toBe(
      "This seat's charter doesn't say what it's for.",
    );
  });

  test("the mission line wins over the charter's first substantive line", () => {
    const board = buildCastBoard(proposal());
    // "## Role\n\nBuilds the search rib." — no Mission section, so the first line stands.
    expect(benchCards(board).find((c) => c.title === "Atlas")?.reason?.text).toBe(
      "Builds the search rib.",
    );
  });
});

describe("buildCastBoard the scan receipt", () => {
  const withRead = (over: Partial<{ files: string[]; searches: number; ms: number }> = {}) =>
    proposal({ read: { files: ["src/a.ts", "src/b.ts"], searches: 4, ms: 41_000, ...over } });

  test("collapses to one row: what was counted, how long, and the list on disclosure", () => {
    const files = Array.from({ length: 31 }, (_, i) => `src/f${i}.ts`);
    const board = buildCastBoard(withRead({ files, searches: 14, ms: 134_000 }));
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const row = receipt(board);
    expect(row?.text).toBe("31 files read · 14 searches (glob / grep)");
    expect(row?.trailing).toBe("2m 14s");
    expect(row?.detail).toContain("src/f0.ts");
    expect(row?.glyph).toBe("ok");
  });

  test("a thin scan keeps its words, not just its tone — the collapse can't mute it", () => {
    // The receipt is the one thing here a confabulation can't produce; a bare yellow
    // dot would say a 1-file cast is a 1-file cast to nobody.
    const row = receipt(buildCastBoard(withRead({ files: ["src/a.ts"], searches: 1, ms: 41_000 })));
    expect(row?.glyph).toBe("warn");
    expect(row?.text).toBe("Thin scan — 1 file read · 1 search (glob / grep)");
  });

  test("a thorough scan reads as ok and raises no thin warning", () => {
    const files = Array.from({ length: 31 }, (_, i) => `src/f${i}.ts`);
    const row = receipt(buildCastBoard(withRead({ files })));
    expect(row?.glyph).toBe("ok");
    expect(row?.text).not.toContain("Thin");
  });

  test("no capture says so — never a fabricated or zeroed receipt", () => {
    const board = buildCastBoard(proposal());
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(receipt(board)?.text).toContain("didn't report what the scan opened");
    expect(receipt(board)?.detail).toBeUndefined();
  });

  test("an empty file list renders no disclosure — detail is min(1)", () => {
    const board = buildCastBoard(withRead({ files: [], searches: 2 }));
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(receipt(board)?.detail).toBeUndefined();
  });

  test("a huge file list is capped so the board degrades instead of failing to render", () => {
    // rows.detail is max(4000): an uncapped list breaches it on a thorough scan of a
    // big repo and takes the WHOLE board down through expectView.
    const files = Array.from({ length: 400 }, (_, i) => `src/some/deep/path/module-${i}.ts`);
    const board = buildCastBoard(withRead({ files }));
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const detail = receipt(board)?.detail ?? "";
    expect(detail.length).toBeLessThanOrEqual(4000);
    expect(detail).toContain("…and 340 more");
    // The count still tells the truth even though the list is elided.
    expect(receipt(board)?.text).toContain("400 files read");
  });

  test("a cap/truncation note rides the provenance, above the bench it explains", () => {
    const board = buildCastBoard(proposal({ notes: ["proposed 9 members — capped to 6"] }));
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const note = provenanceRows(board).find((r) => r.text === "proposed 9 members — capped to 6");
    expect(note?.glyph).toBe("warn");
  });
});

describe("buildCastBoard identity", () => {
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
});
