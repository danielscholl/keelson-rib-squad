import { describe, expect, test } from "bun:test";
import { type CanvasTone, canvasViewSchema } from "@keelson/shared";
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

const TONES: readonly CanvasTone[] = [
  "ok",
  "warn",
  "error",
  "neutral",
  "info",
  "caution",
  "brand",
  "accent",
];

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

  test("the author-archetype actions mirror GENESIS_STARTERS in order", () => {
    const board = buildRosterBoard([]);
    const authors = actionItems(board).filter((i) => i.type === "author-archetype");
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

  test("leads with a cast-a-squad CTA carrying just a mission field (selection-driven scope)", () => {
    const board = buildRosterBoard([]);
    const cast = actionItems(board).find((i) => i.type === "cast-propose");
    expect(cast).toBeDefined();
    // No free-text "project" field — casting follows the project picker selection (#80).
    expect(cast?.fields?.map((f) => f.name)).toEqual(["mission"]);
    expect(cast?.fields?.find((f) => f.name === "mission")?.multiline).toBe(true);
    // The cast section leads the manual author section (the defining capability first).
    const actionTitles = board.sections
      .filter((s) => s.kind === "actions")
      .map((s) => (s.kind === "actions" ? s.title : undefined));
    expect(actionTitles).toEqual(["Cast a squad", "Author a member"]);
  });
});

describe("buildRosterBoard populated", () => {
  test("valid; header counts singular/plural", () => {
    expect(buildRosterBoard([member()]).header?.status?.label).toBe("1 member");
    const two = buildRosterBoard([member({ slug: "a" }), member({ slug: "b", name: "Bo" })]);
    expect(canvasViewSchema.safeParse(two).success).toBe(true);
    expect(two.header?.status?.label).toBe("2 members");
  });

  test("each card dot is a canvas tone; dotFor is deterministic and can differ", () => {
    const board = buildRosterBoard([member({ slug: "a" }), member({ slug: "tester", name: "T" })]);
    for (const card of cards(board)) {
      expect(card.dot).toBeDefined();
      expect(TONES).toContain(card.dot as CanvasTone);
    }
    const again = buildRosterBoard([member({ slug: "a" })]);
    expect(cards(again)[0]?.dot).toBe(cards(board)[0]?.dot);
    const spread = buildRosterBoard(
      ["a", "b", "c", "d", "e", "f", "g", "h"].map((slug) => member({ slug })),
    );
    expect(new Set(cards(spread).map((c) => c.dot)).size).toBeGreaterThan(1);
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
          personality: "Bold and direct; ships fast.",
        }),
      ]),
    )[0];
    expect(card?.title).toBe("McManus");
    expect(card?.fields?.find((f) => f.label === "cast")?.value).toBe("The Usual Suspects");
    expect(card?.reason?.label).toBe("personality");
    expect(card?.reason?.text).toContain("Bold and direct");
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

  function statsItems(board: ReturnType<typeof buildRosterBoard>) {
    const first = board.sections[0];
    if (first?.kind !== "stats") throw new Error("sections[0] is not a stats section");
    return first.items;
  }

  test("omitting pulse keeps the historical no-stats shape", () => {
    const board = buildRosterBoard(two);
    expect(board.sections[0]?.kind).not.toBe("stats");
    expect(board.sections.some((s) => s.kind === "stats")).toBe(false);
  });

  test("with pulse, sections[0] is a stats section carrying the four labels", () => {
    const board = buildRosterBoard(two, pulse({ active: 1, inactive: 1, codeCapable: 1 }));
    expect(board.sections[0]?.kind).toBe("stats");
    expect(statsItems(board).map((i) => i.label)).toEqual([
      "Members",
      "Active",
      "Inactive",
      "Code-capable",
    ]);
    const byLabel = new Map(statsItems(board).map((i) => [i.label, i.value]));
    expect(byLabel.get("Members")).toBe(2);
    expect(byLabel.get("Active")).toBe(1);
    expect(byLabel.get("Inactive")).toBe(1);
    expect(byLabel.get("Code-capable")).toBe(1);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
  });

  test("a zero count tones neutral so an idle squad stays calm", () => {
    const items = statsItems(buildRosterBoard(two, pulse({ active: 0, inactive: 0 })));
    expect(items.find((i) => i.label === "Active")?.tone).toBe("neutral");
    expect(items.find((i) => i.label === "Inactive")?.tone).toBe("neutral");
  });

  test("the pulse leads even the cold-start board and stays valid", () => {
    const board = buildRosterBoard([], pulse({ members: 0, active: 0, inactive: 0 }));
    expect(board.sections[0]?.kind).toBe("stats");
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
    expect(titles).not.toContain("Cast a squad");
    expect(titles).not.toContain("Author a member");
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
