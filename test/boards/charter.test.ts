import { describe, expect, test } from "bun:test";
import { canvasViewSchema } from "@keelson/shared";
import { buildCharterBoard } from "../../src/boards/charter.ts";
import type { CastProposalRecord } from "../../src/cast.ts";

type Member = CastProposalRecord["members"][number];

// What a themed cast actually persists: foldThemedCharter prepends the name, the
// provenance line and the bold personality/backstory over the scan's own ## sections.
const THEMED = [
  "# Mal",
  "",
  "_Cast from Firefly._",
  "",
  "**Personality.** Dry, stubborn, loyal to the crew.",
  "**Backstory.** Held the line at Serenity Valley and never quite left it.",
  "",
  "## Role",
  "",
  "Tech Lead.",
  "",
  "## Mission",
  "",
  "Mal holds the map: sequence the work and keep the crew honest.",
  "",
  "## Voice",
  "",
  "Short sentences. No hedging.",
].join("\n");

const member = (over: Partial<Member> = {}): Member => ({
  slug: "mal",
  name: "Mal",
  role: "Tech Lead",
  charter: THEMED,
  tools: ["read"],
  identitySlot: 0,
  ...over,
});

type Board = ReturnType<typeof buildCharterBoard>;

function seatCard(board: Board) {
  const section = board.sections.find((s) => s.kind === "cards");
  if (section?.kind !== "cards") throw new Error("no seat card");
  return section.items[0];
}
function charterRows(board: Board) {
  const section = board.sections.find((s) => s.kind === "rows");
  if (section?.kind !== "rows") throw new Error("no charter rows");
  return section.items;
}
function row(board: Board, heading: string) {
  return charterRows(board).find((r) => r.chip?.label === heading);
}

describe("buildCharterBoard idle", () => {
  test("no seat renders a valid calm board — the snapshot composer's fallback", () => {
    const board = buildCharterBoard(undefined, "");
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.header?.status?.label).toBe("no seat");
    expect(board.sections).toEqual([]);
  });
});

describe("buildCharterBoard the seat", () => {
  test("is a valid board wearing the bench card's identity, so it reads as its back", () => {
    const board = buildCharterBoard(member(), "keelson");
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.header?.status?.label).toBe("picked");
    expect(board.header?.chip).toBe("keelson");
    const card = seatCard(board);
    expect(card?.title).toBe("Mal");
    expect(card?.dot).toBe("id-blue");
    expect(card?.pill?.label).toBe("Tech Lead");
  });

  test("repeats the bench card's capability line rather than restating it differently", () => {
    expect(
      seatCard(buildCharterBoard(member({ tools: ["code", "read"] }), "keelson"))?.fields,
    ).toEqual([{ value: "✎ code, read", tone: "caution" }]);
    expect(seatCard(buildCharterBoard(member(), "keelson"))?.fields).toEqual([{ value: "read" }]);
  });

  test("a dropped seat says so and folds to neutral", () => {
    const board = buildCharterBoard(member({ picked: false }), "keelson");
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.header?.status?.label).toBe("dropped");
    expect(seatCard(board)?.dot).toBe("neutral");
    expect(seatCard(board)?.pill).toEqual({ label: "dropped", tone: "warn" });
  });

  test("the scan's argument for the seat lands here — the card spends its prose on purpose", () => {
    const board = buildCharterBoard(
      member({ rationale: "src/search/ has 40 files and no owner." }),
      "keelson",
    );
    expect(seatCard(board)?.reason).toEqual({
      label: "why cast:",
      text: "src/search/ has 40 files and no owner.",
    });
  });

  test("no rationale renders no reason rather than an empty one", () => {
    expect(seatCard(buildCharterBoard(member(), "keelson"))?.reason).toBeUndefined();
  });

  test("an empty project name still chips something — the header is not optional", () => {
    expect(buildCharterBoard(member(), "")?.header?.chip).toBe("cast");
  });
});

describe("buildCharterBoard the charter", () => {
  test("the charter's own ## sections become the rows", () => {
    const board = buildCharterBoard(member(), "keelson");
    expect(charterRows(board).map((r) => r.chip?.label)).toEqual([
      undefined,
      "Role",
      "Mission",
      "Voice",
    ]);
  });

  test("the preamble drops the member's own name and the cast provenance", () => {
    // The board already says "Mal" twice; the charter needn't re-introduce its member.
    const preamble = charterRows(buildCharterBoard(member(), "keelson"))[0];
    expect(preamble?.text).toBe(
      "Personality. Dry, stubborn, loyal to the crew. Backstory. Held the line at Serenity Valley and never quite left it.",
    );
    expect(preamble?.text).not.toContain("Cast from Firefly");
  });

  test("a section body keeps its subject — the name strip is the preamble's alone", () => {
    // charterDisplay would eat the leading "Mal" and leave "holds the map".
    expect(row(buildCharterBoard(member(), "keelson"), "Mission")?.text).toBe(
      "Mal holds the map: sequence the work and keep the crew honest.",
    );
  });

  test("markdown is stripped from the prose", () => {
    const board = buildCharterBoard(
      member({ charter: "## Mission\n\n**Build** and ship the `search` rib." }),
      "keelson",
    );
    const mission = row(board, "Mission");
    expect(mission?.text).toBe("Build and ship the search rib.");
    expect(mission?.text).not.toContain("**");
    expect(mission?.text).not.toContain("`");
  });

  test("a one-paragraph section discloses nothing — a caret onto the same words is noise", () => {
    expect(row(buildCharterBoard(member(), "keelson"), "Mission")?.detail).toBeUndefined();
    expect(row(buildCharterBoard(member(), "keelson"), "Voice")?.detail).toBeUndefined();
  });

  test("a structured section re-hangs its shape under the prose", () => {
    const board = buildCharterBoard(
      member({ charter: "## Voice\n\n- Short sentences.\n- No hedging." }),
      "keelson",
    );
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(row(board, "Voice")?.detail).toBe("- Short sentences.\n- No hedging.");
  });

  test("the multi-paragraph preamble discloses its line breaks", () => {
    const preamble = charterRows(buildCharterBoard(member(), "keelson"))[0];
    expect(preamble?.detail).toBe(
      "Personality. Dry, stubborn, loyal to the crew.\nBackstory. Held the line at Serenity Valley and never quite left it.",
    );
  });

  test("a heading-less charter renders as one row rather than vanishing", () => {
    const board = buildCharterBoard(member({ charter: "Just some prose about Mal." }), "keelson");
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const rows = charterRows(board);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.chip).toBeUndefined();
    expect(rows[0]?.text).toBe("Just some prose about Mal.");
  });

  test("an empty charter says so — rows.text is min(1), so a blank would fail the board", () => {
    const board = buildCharterBoard(member({ charter: "" }), "keelson");
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(charterRows(board)).toEqual([
      { glyph: "warn", text: "This seat was proposed without a charter." },
    ]);
  });

  test("a charter of nothing but its own name degrades rather than rendering blank", () => {
    // charterDisplay strips the name to "", and rows.text won't take it.
    const board = buildCharterBoard(member({ charter: "# Mal" }), "keelson");
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(charterRows(board)[0]?.text).toBe("This seat was proposed without a charter.");
  });

  test("an oversized section is capped so the board degrades instead of failing to render", () => {
    // rows.detail is max(4000) and castMemberSchema puts no max on a charter — the scan
    // writes it, so an uncapped body takes the whole board down through the snapshot.
    const long = Array.from({ length: 400 }, (_, i) => `Line ${i} of a very long charter.`).join(
      "\n\n",
    );
    const board = buildCharterBoard(member({ charter: `## Mission\n\n${long}` }), "keelson");
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const detail = row(board, "Mission")?.detail ?? "";
    expect(detail.length).toBeLessThanOrEqual(4000);
    expect(detail.endsWith("…")).toBe(true);
  });
});
