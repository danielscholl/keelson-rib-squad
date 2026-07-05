import { describe, expect, test } from "bun:test";
import { canvasViewSchema } from "@keelson/shared";
import { buildRosterBoard, type RosterPulse } from "../../src/boards/roster.ts";
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

function actionItems(board: ReturnType<typeof buildRosterBoard>) {
  return board.sections.flatMap((s) => (s.kind === "actions" ? s.items : []));
}
function cards(board: ReturnType<typeof buildRosterBoard>) {
  const section = board.sections.find((s) => s.kind === "cards");
  if (section?.kind !== "cards") throw new Error("no cards section");
  return section.items;
}

describe("buildRosterBoard cold start", () => {
  test("is a valid board with the roster header at 0 members", () => {
    const board = buildRosterBoard([]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.view).toBe("board");
    expect(board.header?.chip).toBe("roster");
    expect(board.header?.status?.label).toBe("0 members");
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
  });

  test("a describe-own action carries a multiline brief field", () => {
    const board = buildRosterBoard([]);
    const own = actionItems(board).find((i) => i.type === "describe-own");
    expect(own?.label).toBe("Describe & author");
    expect(own?.fields?.[0]?.name).toBe("brief");
    expect(own?.fields?.[0]?.multiline).toBe(true);
  });

  test("no cards section at cold start; the documented sections render", () => {
    const board = buildRosterBoard([]);
    expect(board.sections.some((s) => s.kind === "cards")).toBe(false);
    expect(board.sections.map((s) => s.kind)).toEqual(["rows", "actions", "actions", "rows"]);
  });

  test("leads with framing copy then the hero cast action with a verb label", () => {
    const board = buildRosterBoard([]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const intro = board.sections[0];
    expect(intro?.kind).toBe("rows");
    expect(intro?.kind === "rows" ? intro.items[0]?.text : "").toContain(
      "One scan of the repo composes the team",
    );
    const hero = board.sections[1];
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

  test("renders the three-step journey strip beneath authoring", () => {
    const board = buildRosterBoard([]);
    const journey = board.sections.find((s) => s.kind === "rows" && s.title === "Squad journey");
    expect(journey?.kind).toBe("rows");
    expect(journey?.kind === "rows" ? journey.items.map((i) => i.text) : []).toEqual([
      "1 Cast: the scan proposes a team, you approve or discard it",
      "2 Meet: each member becomes a chat agent you can enter",
      "3 Run: give the squad a task and the rounds stream in the Run loop panel",
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
    // Surfaced inline (a visible confirm-guarded button), not tucked in the ⋯ overflow.
    expect(retire?.inline).toBe(true);
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

describe("buildRosterBoard pulse", () => {
  const two = [member({ slug: "a", name: "Ada" }), member({ slug: "b", name: "Bo" })];
  const pulse = (over: Partial<RosterPulse> = {}): RosterPulse => ({
    members: 2,
    active: 2,
    inactive: 0,
    codeCapable: 0,
    ...over,
  });

  function pulseRow(board: ReturnType<typeof buildRosterBoard>) {
    const first = board.sections[0];
    if (first?.kind !== "rows") throw new Error("sections[0] is not a rows section");
    const item = first.items[0];
    if (!item) throw new Error("pulse row missing");
    return item;
  }

  test("omitting pulse keeps the historical no-pulse shape", () => {
    const board = buildRosterBoard(two);
    expect(board.sections.some((s) => s.kind === "rows")).toBe(false);
    expect(JSON.stringify(board)).not.toContain('"pulse"');
  });

  test("with pulse, sections[0] is one quiet summary line — never stat tiles", () => {
    const board = buildRosterBoard(two, pulse({ active: 1, inactive: 1, codeCapable: 1 }));
    expect(board.sections.some((s) => s.kind === "stats")).toBe(false);
    const row = pulseRow(board);
    expect(row.text).toBe("1 active · 1 inactive · 1 code-capable");
    expect(row.trailing).toBe("pulse");
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
  });

  test("a zero inactive count is omitted from the summary line", () => {
    const row = pulseRow(buildRosterBoard(two, pulse({ active: 2, inactive: 0, codeCapable: 1 })));
    expect(row.text).toBe("2 active · 1 code-capable");
  });

  test("the pulse leads even the cold-start board and stays valid", () => {
    const board = buildRosterBoard([], pulse({ members: 0, active: 0, inactive: 0 }));
    expect(board.sections[0]?.kind).toBe("rows");
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
  });
});

describe("buildRosterBoard persistent verbs", () => {
  test("a populated roster shows a single Add-a-member + Manage — Cast and archetypes are cold-start only", () => {
    const board = buildRosterBoard([member()]);
    const titles = board.sections
      .filter((s) => s.kind === "actions")
      .map((s) => (s.kind === "actions" ? s.title : undefined));
    expect(titles).toContain("Add a member");
    expect(titles).toContain("Manage");
    // Cast + the archetype quick-picks are cold-start scaffolding, not steady state.
    expect(titles).not.toContain("Cast a squad from this repo");
    expect(titles).not.toContain("or seat one member yourself");
    const items = actionItems(board);
    expect(items.some((i) => i.type === "cast-propose")).toBe(false);
    expect(items.filter((i) => i.type === "author-archetype")).toHaveLength(0);
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

  test("a Manage section offers retire-all only when there are members, with a count in the confirm", () => {
    const cold = buildRosterBoard([]);
    expect(cold.sections.some((s) => s.kind === "actions" && s.title === "Manage")).toBe(false);
    const board = buildRosterBoard([member({ slug: "a" }), member({ slug: "b", name: "Bo" })]);
    const manage = board.sections.find((s) => s.kind === "actions" && s.title === "Manage");
    expect(manage?.kind).toBe("actions");
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
