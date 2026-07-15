import { describe, expect, test } from "bun:test";
import { canvasViewSchema } from "@keelson/shared";
import { buildRosterBoard } from "../../src/boards/roster.ts";
import type { CastProposalRecord } from "../../src/cast.ts";
import { foldThemedCharter } from "../../src/casting/registry.ts";
import type { PendingGenesis } from "../../src/pending-genesis.ts";
import { GENESIS_STARTERS } from "../../src/starters.ts";
import type { Member } from "../../src/types.ts";

const member = (over: Partial<Member> = {}): Member => ({
  slug: "lead",
  name: "Lead",
  role: "Tech Lead",
  charter: "You are the Lead.",
  status: "active",
  ...over,
});

const PERSONALITY = "Pragmatic, precise, and protective of clear operator feedback.";
const MISSION = "Keep the release train green.";

// A member as the cast actually writes one: the themed preamble folded above the
// charter's own ## sections. Built through foldThemedCharter itself so the fixture can't
// drift from the fold the board has to survive.
const castMember = (over: Partial<Member> = {}): Member =>
  member({
    slug: "rowan",
    name: "Rowan",
    themeId: "usual-suspects",
    personality: PERSONALITY,
    charter: foldThemedCharter(`# Rowan\n\n## Role\n\nLead.\n\n## Mission\n\n${MISSION}`, {
      name: "Rowan",
      personality: PERSONALITY,
      backstory: "Rowan builds dependable command-line tools and guards their seams.",
      themeLabel: "The Usual Suspects",
    }),
    ...over,
  });

const proposal = (count = 5): CastProposalRecord => ({
  projectId: "p1",
  projectName: "keelson",
  rootPath: "/repo/keelson",
  members: Array.from({ length: count }, (_, i) => ({
    name: `M${i}`,
    role: "Member",
    charter: `# M${i}`,
  })),
  notes: [],
  createdAt: "2026-07-08T00:00:00.000Z",
});

function actionItems(board: ReturnType<typeof buildRosterBoard>) {
  return board.sections.flatMap((s) => (s.kind === "actions" ? s.items : []));
}
function cards(board: ReturnType<typeof buildRosterBoard>) {
  const section = board.sections.find((s) => s.kind === "cards");
  if (section?.kind !== "cards") throw new Error("no cards section");
  return section.items;
}
function journey(board: ReturnType<typeof buildRosterBoard>) {
  const section = board.sections.find((s) => s.kind === "journey");
  if (section?.kind !== "journey") throw new Error("no journey section");
  return section.items;
}
function liveStrip(board: ReturnType<typeof buildRosterBoard>) {
  const section = board.sections.find(
    (s) => s.kind === "actions" && s.items.some((i) => i.type === "select-project"),
  );
  return section?.kind === "actions" ? section : undefined;
}

describe("buildRosterBoard cold start", () => {
  test("is a valid board with the roster header at 0 members", () => {
    const board = buildRosterBoard([]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.view).toBe("board");
    // The redundant ROSTER slug chip is gone; the head carries the count + title.
    expect(board.header?.chip).toBeUndefined();
    expect(board.header?.status?.label).toBe("0 members");
    // Cold start emits no roster peek or collapse hint — the cast launchpad stays open.
    expect(board.header?.people).toBeUndefined();
    expect(board.header?.defaultCollapsed).toBeUndefined();
  });

  test("the secondary authoring group mirrors GENESIS_STARTERS in order", () => {
    const board = buildRosterBoard([]);
    const section = board.sections.find(
      (s) => s.kind === "actions" && s.title === "or seat one member yourself",
    );
    expect(section?.kind).toBe("actions");
    const authors =
      section?.kind === "actions" ? section.items.filter((i) => i.type === "author-archetype") : [];
    expect(authors).toHaveLength(GENESIS_STARTERS.length);
    expect(authors.map((a) => a.payload)).toEqual(GENESIS_STARTERS.map((s) => ({ slug: s.slug })));
    expect(authors.map((a) => a.label)).toEqual(
      GENESIS_STARTERS.map((s) => `${s.name} — ${s.tagline}`),
    );
    expect(authors.map((a) => (a.payload as { slug: string }).slug)).toEqual([
      "lead",
      "engineer",
      "reviewer",
      "tester",
    ]);
    // Each preset wears the identity seat it will occupy, in cast order.
    expect(authors.map((a) => a.tone)).toEqual(["id-blue", "id-amber", "id-teal", "id-rose"]);
  });

  test("a describe-own action carries a multiline brief field and the fifth seat tone", () => {
    const board = buildRosterBoard([]);
    const own = actionItems(board).find((i) => i.type === "describe-own");
    expect(own?.label).toBe("Describe & author");
    expect(own?.tone).toBe("id-olive");
    expect(own?.fields?.[0]?.name).toBe("brief");
    expect(own?.fields?.[0]?.multiline).toBe(true);
  });

  test("no cards section at cold start; the documented sections render", () => {
    const board = buildRosterBoard([]);
    expect(board.sections.some((s) => s.kind === "cards")).toBe(false);
    // No seats row anymore — identity moved to the head (and it's absent at cold start).
    expect(board.sections.map((s) => s.kind)).toEqual(["rows", "actions", "actions", "journey"]);
  });

  test("leads with framing copy then the hero cast action with a verb label", () => {
    const board = buildRosterBoard([]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const intro = board.sections.find((s) => s.kind === "rows");
    expect(intro?.kind).toBe("rows");
    expect(intro?.kind === "rows" ? intro.items[0]?.text : "").toContain(
      "One scan of the repo composes the team",
    );
    const hero = board.sections.find(
      (s) => s.kind === "actions" && s.title === "Cast a squad from this repo",
    );
    expect(hero?.kind).toBe("actions");
    expect(hero?.title).toBe("Cast a squad from this repo");
    const cast = hero?.kind === "actions" ? hero.items[0] : undefined;
    expect(cast?.type).toBe("cast-propose");
    expect(cast?.label).toBe("Cast a squad");
    expect(cast).toBeDefined();
    // No free-text "project" field — casting follows the project picker selection.
    expect(cast?.fields?.map((f) => f.name)).toEqual(["mission"]);
    expect(cast?.fields?.find((f) => f.name === "mission")?.multiline).toBe(true);
    expect(cast?.inline).toBe(true);
    // The cast section leads the manual author section (the defining capability first).
    const actionTitles = board.sections
      .filter((s) => s.kind === "actions")
      .map((s) => (s.kind === "actions" ? s.title : undefined));
    expect(actionTitles).toEqual(["Cast a squad from this repo", "or seat one member yourself"]);
  });

  test("renders the first-class three-step journey beneath authoring", () => {
    const board = buildRosterBoard([]);
    expect(journey(board)).toEqual([
      {
        title: "Cast",
        text: "The scan proposes a team; you approve or discard it.",
      },
      {
        title: "Meet",
        text: "Each member becomes a chat agent you can enter and talk to.",
      },
      {
        title: "Run",
        text: "Give the squad a task — the loop's rounds and findings stream here.",
      },
    ]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
  });
});

describe("buildRosterBoard populated", () => {
  test("valid; header counts singular/plural", () => {
    expect(buildRosterBoard([member()]).header?.status?.label).toBe("1 member");
    const two = buildRosterBoard([member({ slug: "a" }), member({ slug: "b", name: "Bo" })]);
    expect(canvasViewSchema.safeParse(two).success).toBe(true);
    expect(two.header?.status?.label).toBe("2 members");
  });

  test("each card dot is the member's persisted identity tone; no slot folds to neutral", () => {
    const board = buildRosterBoard([
      member({ slug: "a", identitySlot: 0 }),
      member({ slug: "b", name: "Bo", identitySlot: 1 }),
      member({ slug: "c", name: "Cy", identitySlot: 4 }),
      member({ slug: "d", name: "Dee" }),
    ]);
    expect(cards(board).map((c) => c.dot)).toEqual(["id-blue", "id-amber", "id-olive", "neutral"]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
  });

  test("populated head carries the roster peek + collapse hint; unreserved members fold to neutral", () => {
    const board = buildRosterBoard([
      member({ slug: "teal", name: "Teal", identitySlot: 2 }),
      member({ slug: "blue", name: "Blue", identitySlot: 0 }),
      member({ slug: "amber", name: "Amber", identitySlot: 1 }),
      member({ slug: "rose", name: "Rose", identitySlot: 3 }),
      member({ slug: "olive", name: "Olive", identitySlot: 4 }),
      member({ slug: "six", name: "Sixth" }),
    ]);
    // One identity dot per member (names revealed on hover), in list order; a sixth
    // past the five hues folds to the neutral tone — mirroring its card dot.
    expect(board.header?.people).toEqual([
      { name: "Teal", tone: "id-teal" },
      { name: "Blue", tone: "id-blue" },
      { name: "Amber", tone: "id-amber" },
      { name: "Rose", tone: "id-rose" },
      { name: "Olive", tone: "id-olive" },
      { name: "Sixth", tone: "neutral" },
    ]);
    expect(board.header?.defaultCollapsed).toBe(true);
    expect(cards(board).map((c) => ({ title: c.title, dot: c.dot }))).toContainEqual({
      title: "Sixth",
      dot: "neutral",
    });
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
  });

  test("exactly one pill per card carrying the role, with a 'Member' fallback", () => {
    expect(cards(buildRosterBoard([member({ role: "Tech Lead" })]))[0]?.pill).toEqual({
      label: "Tech Lead",
    });
    expect(cards(buildRosterBoard([member({ role: "" })]))[0]?.pill?.label).toBe("Member");
  });

  test("fields: the capability, marked only when the seat can write; no charter or model field", () => {
    const coder = cards(buildRosterBoard([member({ tools: ["code", "read"] })]))[0];
    expect(coder?.fields?.some((f) => f.label === "charter")).toBe(false);
    expect(coder?.fields?.some((f) => f.label === "model")).toBe(false);
    // `code` is what the governance floor bounds — the only capability toned.
    expect(coder?.fields?.at(-1)).toEqual({ value: "✎ code, read", tone: "caution" });
    const textOnly = cards(buildRosterBoard([member({ model: "claude-x" })]))[0];
    expect(textOnly?.fields?.at(-1)).toEqual({ value: "text-only" });
    // The pin is the model action's label now, not a dead field.
    expect(textOnly?.actions?.find((a) => a.type === "set-model")?.label).toBe("Model — claude-x");
  });

  test("the purpose is the mission, not the personality preamble the fold prepends", () => {
    const card = cards(buildRosterBoard([castMember()]))[0];
    // The defect this pass exists to kill: a 120-char window over the FLATTENED charter
    // opened on `**Personality.**` and quoted the line the card renders again below it.
    expect(card?.reason?.text).toBe(MISSION);
    expect(card?.reason?.text).not.toContain("Personality");
    expect(card?.reason?.text).not.toBe(card?.footnote);
    expect(card?.reason?.label).toBeUndefined();
  });

  test("a charter that says nothing falls back rather than emitting an empty reason", () => {
    // reason.text is min(1): an empty excerpt would fail the whole board through expectView.
    const card = cards(buildRosterBoard([member({ charter: "   " })]))[0];
    expect(card?.reason?.text).toBe("This member's charter doesn't say what it's for.");
    expect(canvasViewSchema.safeParse(buildRosterBoard([member({ charter: "   " })])).success).toBe(
      true,
    );
  });

  test("the cards lay out as the bench's own three-track grid", () => {
    const section = buildRosterBoard([member()]).sections.find((s) => s.kind === "cards");
    expect(section).toMatchObject({ grid: true, columns: 3 });
  });

  test("each card leads with a non-destructive Enter, then the model picker, then a destructive Retire", () => {
    const board = buildRosterBoard([member({ slug: "lead", name: "Lead" })]);
    const actions = cards(board)[0]?.actions ?? [];
    const enter = actions.find((a) => a.type === "enter-member");
    // The card title carries the name; the verb doesn't repeat it.
    expect(enter).toMatchObject({
      type: "enter-member",
      label: "Enter",
      payload: { slug: "lead" },
    });
    expect(enter?.destructive ?? false).toBe(false);
    expect(actions[0]?.type).toBe("enter-member");

    // A lone modelPicker field is the host's solo-picker fast path — and pairing the
    // provider structurally is what keeps setMemberModel's "a pinned model needs its
    // provider" unreachable from the board.
    const setModel = actions.find((a) => a.type === "set-model");
    expect(setModel?.fields?.map((f) => f.name)).toEqual(["model"]);
    expect(setModel?.fields?.[0]?.modelPicker?.providerField).toBe("provider");

    const retire = actions.find((a) => a.type === "retire");
    expect(retire).toMatchObject({ type: "retire", destructive: true, payload: { slug: "lead" } });
    expect(retire?.confirm?.confirmLabel).toBe("Retire");
    // Destructive: tucked in the card's ⋯ overflow (no inline), still confirm-guarded.
    expect(retire?.inline ?? false).toBe(false);
    expect(actions.findIndex((a) => a.type === "retire")).toBe(actions.length - 1);
  });

  test("the slug still rides the serialized board (guards collect-roster toContain)", () => {
    expect(JSON.stringify(buildRosterBoard([member({ slug: "lead" })]))).toContain("lead");
  });

  test("a cast member's personality is the footnote, stripped of markdown", () => {
    const card = cards(
      buildRosterBoard([castMember({ personality: "**Bold** and `direct`; ships fast." })]),
    )[0];
    expect(card?.title).toBe("Rowan");
    expect(card?.footnote).toContain("Bold and direct");
    expect(card?.footnote).not.toContain("**");
    expect(card?.footnote).not.toContain("`");
  });

  test("an un-cast member has no personality footnote", () => {
    expect(cards(buildRosterBoard([member()]))[0]?.footnote).toBeUndefined();
  });

  test("a personality that renders to nothing yields no footnote, not a stand-in line", () => {
    // stripMd can empty a personality that was only markup, and the footnote is the
    // character's voice — there is no honest placeholder for it.
    for (const personality of ["   ", "**", "``"]) {
      expect(cards(buildRosterBoard([castMember({ personality })]))[0]?.footnote).toBeUndefined();
    }
    // But markup that isn't a paired wrapper is text, and survives as the voice.
    expect(cards(buildRosterBoard([castMember({ personality: "*_*" })]))[0]?.footnote).toBe("*_*");
  });
});

describe("buildRosterBoard ensemble hoist", () => {
  const chip = (members: Member[]) => buildRosterBoard(members).header?.chip;
  const castField = (members: Member[]) =>
    cards(buildRosterBoard(members))[0]?.fields?.find((f) => f.label === "cast")?.value;

  test("a uniform roster says its ensemble once in the head, not on all five cards", () => {
    const roster = [castMember({ slug: "a" }), castMember({ slug: "b", name: "Bo" })];
    expect(chip(roster)).toBe("The Usual Suspects");
    expect(castField(roster)).toBeUndefined();
  });

  test("a roster spanning two ensembles hoists nothing and keeps the cards' cast field", () => {
    // themeSelectionOrder rolls to the next ensemble once the active one runs dry, so a
    // roster legitimately spans two — the chip would be a lie.
    const roster = [castMember({ slug: "a" }), castMember({ slug: "b", themeId: "flux" })];
    expect(chip(roster)).toBeUndefined();
    expect(castField(roster)).toBe("The Usual Suspects");
  });

  test("one hand-authored member among a cast roster un-hoists it", () => {
    const roster = [castMember({ slug: "a" }), member({ slug: "atlas", name: "Atlas" })];
    expect(chip(roster)).toBeUndefined();
  });

  test("an all-uncast roster hoists nothing and shows no cast field", () => {
    // The all-undefined case folds through the same guard: its one label IS undefined.
    const roster = [member({ slug: "a" }), member({ slug: "b", name: "Bo" })];
    expect(chip(roster)).toBeUndefined();
    expect(castField(roster)).toBeUndefined();
  });
});

describe("buildRosterBoard live runs elsewhere", () => {
  test("renders a leading switch strip on the cold-start board", () => {
    const board = buildRosterBoard([], null, Date.parse("2026-07-08T00:00:00.000Z"), null, [
      { scopeId: "beta", name: "rib-squad", task: "Ship the cue", round: 2 },
    ]);

    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.sections[0]?.kind).toBe("actions");
    const strip = liveStrip(board);
    expect(strip?.title).toBe("● 1 live run in rib-squad");
    expect(strip?.items[0]).toMatchObject({
      type: "select-project",
      label: "Switch to rib-squad",
      glyph: "→",
      tone: "info",
      payload: { scopeId: "beta" },
    });
  });

  test("renders a leading switch strip on a populated roster", () => {
    const board = buildRosterBoard(
      [member()],
      undefined,
      Date.parse("2026-07-08T00:00:00.000Z"),
      undefined,
      [{ scopeId: "beta", name: "Beta", task: "Ship the cue", round: 2 }],
    );

    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.sections[0]).toBe(liveStrip(board));
    expect(board.sections[1]?.kind).toBe("cards");
  });

  test("omitting or passing an empty live-runs list renders no strip", () => {
    const omitted = buildRosterBoard([]);
    const empty = buildRosterBoard(
      [],
      undefined,
      Date.parse("2026-07-08T00:00:00.000Z"),
      undefined,
      [],
    );

    expect(empty).toEqual(omitted);
    expect(liveStrip(omitted)).toBeUndefined();
    expect(actionItems(omitted).some((i) => i.type === "select-project")).toBe(false);
  });

  test("pluralizes the title and falls back from name to scope id", () => {
    const board = buildRosterBoard([], null, Date.parse("2026-07-08T00:00:00.000Z"), null, [
      { scopeId: "beta", name: "Beta", task: "Beta task", round: 1 },
      { scopeId: "gamma", task: "Gamma task", round: 3 },
    ]);
    const strip = liveStrip(board);

    expect(strip?.title).toBe("● 2 live runs in Beta, gamma");
    expect(strip?.items.map((item) => item.label)).toEqual(["Switch to Beta", "Switch to gamma"]);
    expect(strip?.items.map((item) => item.payload)).toEqual([
      { scopeId: "beta" },
      { scopeId: "gamma" },
    ]);
  });
});

describe("buildRosterBoard persistent verbs", () => {
  test("a populated roster's foot is one Hire chip — Cast and archetypes are cold-start only", () => {
    const board = buildRosterBoard([member()]);
    const titles = board.sections
      .filter((s) => s.kind === "actions")
      .map((s) => (s.kind === "actions" ? s.title : undefined));
    // Cast + the archetype quick-picks are cold-start scaffolding, not steady state.
    expect(titles).not.toContain("Cast a squad from this repo");
    expect(titles).not.toContain("or seat one member yourself");
    const items = actionItems(board);
    expect(items.some((i) => i.type === "cast-propose")).toBe(false);
    expect(items.filter((i) => i.type === "author-archetype")).toHaveLength(0);
    // Hiring is still reachable — one describe-your-own genesis launch, as a title-less
    // wrap chip: the label is the title, and `wrap` keeps the button compact at rest.
    const hire = items.find((i) => i.type === "describe-own");
    expect(hire?.label).toBe("Hire a member…");
    expect(hire?.fields?.[0]?.name).toBe("brief");
    const foot = board.sections.find(
      (s) => s.kind === "actions" && s.items.some((i) => i.type === "describe-own"),
    );
    expect(foot).toMatchObject({ wrap: true });
    expect(foot?.kind === "actions" ? foot.title : "unset").toBeUndefined();
    expect(board.sections.some((s) => s.kind === "cards")).toBe(true);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
  });

  test("cold start keeps the full launchpad — Cast + archetype quick-picks + describe", () => {
    const items = actionItems(buildRosterBoard([]));
    expect(items.some((i) => i.type === "cast-propose")).toBe(true);
    expect(items.filter((i) => i.type === "author-archetype")).toHaveLength(
      GENESIS_STARTERS.length,
    );
    expect(items.some((i) => i.type === "describe-own")).toBe(true);
  });

  test("the teardown verb has left the board — it lives in the region head's ⋯", () => {
    // Asserted on the surface descriptor in rib.test.ts. The board spends its foot on the
    // one verb that GROWS the roster.
    const hasRetireAll = (b: ReturnType<typeof buildRosterBoard>) =>
      b.sections.some((s) => s.kind === "actions" && s.items.some((i) => i.type === "retire-all"));
    expect(hasRetireAll(buildRosterBoard([]))).toBe(false);
    expect(hasRetireAll(buildRosterBoard([member({ slug: "a" }), member({ slug: "b" })]))).toBe(
      false,
    );
  });

  test("a code capability does not add a card verb — entering the member is the path to a code task", () => {
    const coder = cards(buildRosterBoard([member({ slug: "mc", tools: ["code"] })]))[0];
    const textOnly = cards(buildRosterBoard([member({ slug: "verbal" })]))[0];
    expect(coder?.actions?.map((a) => a.type)).toEqual(textOnly?.actions?.map((a) => a.type));
  });
});

describe("buildRosterBoard authoring boot card", () => {
  const START = "2026-07-08T00:00:00.000Z";
  const startMs = Date.parse(START);
  const pending = (over: Partial<PendingGenesis> = {}): PendingGenesis => ({
    startedAt: START,
    ...over,
  });

  // The boot card is the last card in the section — seated cards compose before it.
  function boot(board: ReturnType<typeof buildRosterBoard>) {
    const section = board.sections.find((s) => s.kind === "cards");
    if (section?.kind !== "cards") throw new Error("no cards section");
    return section.items[section.items.length - 1];
  }

  test("a pending genesis on an empty roster seats a boot card and no launchpad", () => {
    const board = buildRosterBoard([], pending({ role: "Engineer" }), startMs + 6_000);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    // No cold-start launchpad while authoring the first member — just the boot card.
    expect(board.sections.map((s) => s.kind)).toEqual(["cards"]);
    const card = boot(board);
    expect(card?.title).toBe("Casting…");
    expect(card?.pill).toEqual({ label: "authoring", tone: "brand" });
    expect(card?.stacked).toBe(true);
    // The archetype role is honest; name + theme calibrate; the elapsed count advances.
    const values = card?.fields?.map((f) => f.value);
    expect(values).toContain("seat: Engineer");
    expect(values).toContain("name: calibrating…");
    expect(values).toContain("charter: calibrating… · 6s");
  });

  test("a freeform brief (no role) calibrates the seat too", () => {
    const card = boot(buildRosterBoard([], pending(), startMs + 1_000));
    expect(card?.fields?.map((f) => f.value)).toContain("seat: calibrating…");
  });

  test("the boot card takes the next free identity slot's tone", () => {
    // Slot 0 is taken → the boot card wears slot 1 (amber).
    const card = boot(
      buildRosterBoard([member({ slug: "a", identitySlot: 0 })], pending(), startMs + 1_000),
    );
    expect(card?.dot).toBe("id-amber");
  });

  test("while pending, the steady-state Add-a-member + retire-all verbs are withheld", () => {
    const board = buildRosterBoard([member({ slug: "a" })], pending(), startMs + 1_000);
    const items = board.sections.flatMap((s) => (s.kind === "actions" ? s.items : []));
    expect(items.some((i) => i.type === "describe-own")).toBe(false);
    expect(items.some((i) => i.type === "retire-all")).toBe(false);
    // The seated member and the boot card both render.
    const section = board.sections.find((s) => s.kind === "cards");
    expect(section?.kind === "cards" ? section.items.length : 0).toBe(2);
  });

  test("past the stall window the boot card flips to a warn card with a Dismiss", () => {
    const board = buildRosterBoard([], pending({ role: "Engineer" }), startMs + 200_000);
    const card = boot(board);
    expect(card?.dot).toBe("warn");
    expect(card?.pill).toEqual({ label: "stalled", tone: "warn" });
    expect(card?.actions?.[0]?.type).toBe("dismiss-genesis");
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
  });

  test("an unparseable startedAt presents as stalled (a Dismiss, never a NaN card)", () => {
    const card = boot(buildRosterBoard([], { startedAt: "not-a-date" }, startMs));
    expect(card?.actions?.[0]?.type).toBe("dismiss-genesis");
  });

  test("a pending cast seats the squad-cast boot card — scan liturgy, no launchpad", () => {
    const board = buildRosterBoard([], pending({ kind: "cast" }), startMs + 42_000);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.sections.map((s) => s.kind)).toEqual(["cards"]);
    const card = boot(board);
    expect(card?.title).toBe("Casting a squad…");
    expect(card?.pill).toEqual({ label: "casting", tone: "brand" });
    expect(card?.stacked).toBe(true);
    const values = card?.fields?.map((f) => f.value);
    expect(values).toContain("scanning the repo…");
    expect(values).toContain("team: calibrating…");
    expect(values).toContain("cast: calibrating… · 42s");
  });

  test("a cast outlives the member stall window — still casting at 200s, stalled past 330s", () => {
    const casting = boot(buildRosterBoard([], pending({ kind: "cast" }), startMs + 200_000));
    expect(casting?.pill).toEqual({ label: "casting", tone: "brand" });
    const stalled = boot(buildRosterBoard([], pending({ kind: "cast" }), startMs + 331_000));
    expect(stalled?.pill).toEqual({ label: "stalled", tone: "warn" });
    expect(stalled?.actions?.[0]?.type).toBe("dismiss-genesis");
  });

  test("a marker carrying an error flips to the failed card at once", () => {
    const board = buildRosterBoard(
      [],
      pending({ kind: "cast", error: "repo-scan turn error: boom" }),
      startMs + 5_000,
    );
    const card = boot(board);
    expect(card?.pill).toEqual({ label: "failed", tone: "warn" });
    expect(card?.fields?.[0]?.value).toContain("repo-scan turn error: boom");
    expect(card?.actions?.[0]?.type).toBe("dismiss-genesis");
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
  });

  test("a blank error still says what happened rather than rendering an empty line", () => {
    const board = buildRosterBoard([], pending({ kind: "cast", error: "   " }), startMs + 5_000);
    expect(boot(board)?.fields?.[0]?.value).toBe("casting failed without a message.");
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
  });
});

describe("buildRosterBoard proposal awaiting review", () => {
  test("an empty roster with a pending proposal hands the moment off — no launchpad", () => {
    const board = buildRosterBoard([], null, Date.parse("2026-07-08T00:00:00.000Z"), proposal());
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    // One quiet hand-off row; no Cast hero, no archetypes, no journey.
    expect(board.sections.map((s) => s.kind)).toEqual(["rows"]);
    expect(actionItems(board)).toEqual([]);
    const row = board.sections[0]?.kind === "rows" ? board.sections[0].items[0] : undefined;
    expect(row?.text).toContain("proposed squad of 5 members awaits review");
  });

  test("a populated roster with a pending proposal withholds add/manage for the hand-off row", () => {
    const board = buildRosterBoard(
      [member()],
      null,
      Date.parse("2026-07-08T00:00:00.000Z"),
      proposal(1),
    );
    expect(board.sections.map((s) => s.kind)).toEqual(["cards", "rows"]);
    expect(actionItems(board)).toEqual([]);
    const rows = board.sections[1];
    const row = rows?.kind === "rows" ? rows.items[0] : undefined;
    expect(row?.text).toContain("proposed squad of 1 member awaits");
  });

  test("a genesis in flight outranks the proposal — the boot card carries the moment", () => {
    const board = buildRosterBoard(
      [],
      { startedAt: "2026-07-08T00:00:00.000Z", kind: "cast" },
      Date.parse("2026-07-08T00:00:10.000Z"),
      proposal(),
    );
    expect(board.sections.map((s) => s.kind)).toEqual(["cards"]);
  });
});
