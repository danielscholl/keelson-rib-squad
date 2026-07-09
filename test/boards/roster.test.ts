import { describe, expect, test } from "bun:test";
import { canvasViewSchema } from "@keelson/shared";
import { buildRosterBoard } from "../../src/boards/roster.ts";
import type { CastProposalRecord } from "../../src/cast.ts";
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

  test("fields: a truncated charter ((no charter) fallback) and model only when set", () => {
    const withModel = cards(buildRosterBoard([member({ model: "claude-x" })]))[0];
    expect(withModel?.fields?.find((f) => f.label === "charter")?.value).toBe("You are the Lead.");
    expect(withModel?.fields?.find((f) => f.label === "model")?.value).toBe("claude-x");
    const noModel = cards(buildRosterBoard([member({ model: undefined })]))[0];
    expect(noModel?.fields?.some((f) => f.label === "model")).toBe(false);
    const noCharter = cards(buildRosterBoard([member({ charter: "   " })]))[0];
    expect(noCharter?.fields?.find((f) => f.label === "charter")?.value).toBe("(no charter)");
  });

  test("the charter excerpt strips markdown and drops only the leading self-name heading", () => {
    const card = cards(
      buildRosterBoard([
        member({
          name: "McManus",
          charter: "# McManus\n\n## Mission\n\n**Ship** the `rib`.\n\n# Keep this heading",
        }),
      ]),
    )[0];
    const excerpt = card?.fields?.find((f) => f.label === "charter")?.value;
    expect(excerpt).toBe("Mission Ship the rib. Keep this heading");
    expect(String(excerpt ?? "").startsWith("McManus")).toBe(false);
  });

  test("each card leads with a non-destructive Enter, then Set model, then a destructive Retire", () => {
    const board = buildRosterBoard([member({ slug: "lead", name: "Lead" })]);
    const actions = cards(board)[0]?.actions ?? [];
    const enter = actions.find((a) => a.type === "enter-member");
    expect(enter).toMatchObject({
      type: "enter-member",
      label: "Enter Lead",
      payload: { slug: "lead" },
    });
    expect(enter?.destructive ?? false).toBe(false);
    expect(actions[0]?.type).toBe("enter-member");

    const setModel = actions.find((a) => a.type === "set-model");
    expect(setModel?.fields?.map((f) => f.name)).toEqual(["model", "provider"]);

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

  test("a cast member shows its ensemble and a personality sub-line", () => {
    const card = cards(
      buildRosterBoard([
        member({
          slug: "mcmanus",
          name: "McManus",
          themeId: "usual-suspects",
          personality: "**Bold** and `direct`; ships fast.",
        }),
      ]),
    )[0];
    expect(card?.title).toBe("McManus");
    expect(card?.fields?.find((f) => f.label === "cast")?.value).toBe("The Usual Suspects");
    expect(card?.reason?.label).toBe("personality");
    expect(card?.reason?.text).toContain("Bold and direct");
    expect(card?.reason?.text).not.toContain("**");
    expect(card?.reason?.text).not.toContain("`");
  });

  test("an un-cast member shows no cast field and no personality line", () => {
    const card = cards(buildRosterBoard([member()]))[0];
    expect(card?.fields?.some((f) => f.label === "cast")).toBe(false);
    expect(card?.reason).toBeUndefined();
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
    const empty = buildRosterBoard([], undefined, Date.parse("2026-07-08T00:00:00.000Z"), undefined, []);

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
    expect(strip?.items.map((item) => item.payload)).toEqual([{ scopeId: "beta" }, { scopeId: "gamma" }]);
  });
});

describe("buildRosterBoard persistent verbs", () => {
  test("a populated roster shows a single Add-a-member + retire-all — Cast and archetypes are cold-start only", () => {
    const board = buildRosterBoard([member()]);
    const titles = board.sections
      .filter((s) => s.kind === "actions")
      .map((s) => (s.kind === "actions" ? s.title : undefined));
    expect(titles).toContain("Add a member");
    // Cast + the archetype quick-picks are cold-start scaffolding, not steady state.
    expect(titles).not.toContain("Cast a squad from this repo");
    expect(titles).not.toContain("or seat one member yourself");
    const items = actionItems(board);
    expect(items.some((i) => i.type === "cast-propose")).toBe(false);
    expect(items.filter((i) => i.type === "author-archetype")).toHaveLength(0);
    // The retire-all verb is present (now a title-less, quiet actions section).
    expect(items.some((i) => i.type === "retire-all")).toBe(true);
    // Adding a member is still reachable — one describe-your-own genesis launch.
    const add = items.find((i) => i.type === "describe-own");
    expect(add?.fields?.[0]?.name).toBe("brief");
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

  test("the retire-all verb appears only when there are members, quiet and with a count in the confirm", () => {
    const hasRetireAll = (b: ReturnType<typeof buildRosterBoard>) =>
      b.sections.find((s) => s.kind === "actions" && s.items.some((i) => i.type === "retire-all"));
    expect(hasRetireAll(buildRosterBoard([]))).toBeUndefined();
    const board = buildRosterBoard([member({ slug: "a" }), member({ slug: "b", name: "Bo" })]);
    const manage = hasRetireAll(board);
    expect(manage?.kind).toBe("actions");
    // Quiet: no "Manage" section title anymore.
    expect(manage?.kind === "actions" ? manage.title : "unset").toBeUndefined();
    const retireAll = manage?.kind === "actions" ? manage.items[0] : undefined;
    expect(retireAll?.type).toBe("retire-all");
    expect(retireAll?.destructive).toBe(true);
    expect(retireAll?.confirm?.body).toContain("2 members");
  });

  test("a code-capable member's card carries an Assign-a-code-task action; a text-only member does not", () => {
    const coder = cards(buildRosterBoard([member({ slug: "mc", tools: ["code"] })]))[0];
    const assign = coder?.actions?.find((a) => a.type === "assign-code");
    expect(assign).toBeDefined();
    expect(assign?.payload).toEqual({ slug: "mc" });
    expect(assign?.fields?.[0]?.name).toBe("task");
    expect(assign?.fields?.[0]?.multiline).toBe(true);
    const textOnly = cards(buildRosterBoard([member({ slug: "verbal" })]))[0];
    expect(textOnly?.actions?.some((a) => a.type === "assign-code")).toBe(false);
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
