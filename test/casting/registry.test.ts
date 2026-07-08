import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assignThemedIdentity,
  type CastingRegistry,
  CUSTOM_THEME_CAPACITY,
  foldThemedCharter,
  loadRegistry,
  resolveThemingConfig,
  retireCastingName,
  saveRegistry,
} from "../../src/casting/registry.ts";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "squad-casting-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("registry persistence", () => {
  test("round-trips through save/load", async () => {
    const reg: CastingRegistry = {
      version: 1,
      activeThemeId: "usual-suspects",
      themeHistory: ["usual-suspects"],
      members: {
        mcmanus: {
          themedName: "McManus",
          themeId: "usual-suspects",
          status: "active",
          originalName: "Atlas",
        },
      },
    };
    await saveRegistry(home, reg);
    expect(await loadRegistry(home)).toEqual(reg);
  });

  test("a missing registry reads as empty", async () => {
    expect(await loadRegistry(home)).toEqual({ version: 1, themeHistory: [], members: {} });
  });

  test("a corrupt registry reads as empty (fail-soft, never throws)", async () => {
    await writeFile(join(home, "casting-registry.json"), "{not json");
    expect(await loadRegistry(home)).toEqual({ version: 1, themeHistory: [], members: {} });
  });

  test("drops malformed member entries on load", async () => {
    await writeFile(
      join(home, "casting-registry.json"),
      JSON.stringify({
        version: 1,
        themeHistory: [],
        members: { bad: { themedName: 42 }, ok: { themedName: "Mal", themeId: "firefly" } },
      }),
    );
    const reg = await loadRegistry(home);
    expect(reg.members.bad).toBeUndefined();
    expect(reg.members.ok?.themedName).toBe("Mal");
  });
});

describe("assignThemedIdentity", () => {
  test("genesis: themes a proposed name into a best-fit ensemble character", async () => {
    const id = await assignThemedIdentity(home, { proposedName: "Atlas", role: "Engineer" });
    expect(id.name).toBe("McManus");
    expect(id.slug).toBe("mcmanus");
    expect(id.themeId).toBe("usual-suspects");
    expect(id.personality).toBeTruthy();
    expect(id.backstory).toBeTruthy();
    // The proposed name is retained as lineage.
    expect(id.originalName).toBe("Atlas");
  });

  test("persists the reservation to the registry", async () => {
    await assignThemedIdentity(home, { proposedName: "Atlas", role: "Engineer" });
    const reg = await loadRegistry(home);
    expect(reg.activeThemeId).toBe("usual-suspects");
    expect(reg.members.mcmanus).toMatchObject({
      themedName: "McManus",
      themeId: "usual-suspects",
      status: "active",
      originalName: "Atlas",
    });
  });

  test("batch: a whole roster casts unique characters from ONE ensemble", async () => {
    const roles = ["Tech Lead", "Engineer", "Reviewer", "Tester", "Docs", "DevOps"];
    const ids = [];
    for (let i = 0; i < roles.length; i++) {
      ids.push(await assignThemedIdentity(home, { proposedName: `Member${i}`, role: roles[i]! }));
    }
    const names = ids.map((i) => i.name);
    const slugs = ids.map((i) => i.slug);
    expect(new Set(names).size).toBe(roles.length); // all unique
    expect(new Set(slugs).size).toBe(roles.length);
    expect(new Set(ids.map((i) => i.themeId))).toEqual(new Set(["usual-suspects"]));
  });

  test("uniqueness: an active name is never reused", async () => {
    const first = await assignThemedIdentity(home, { proposedName: "Atlas", role: "Engineer" });
    const second = await assignThemedIdentity(home, { proposedName: "Bob", role: "Engineer" });
    expect(second.name).not.toBe(first.name);
    expect(second.slug).not.toBe(first.slug);
  });

  test("name stability: re-casting the same proposed name returns the same character", async () => {
    const first = await assignThemedIdentity(home, { proposedName: "Atlas", role: "Engineer" });
    const again = await assignThemedIdentity(home, { proposedName: "Atlas", role: "Engineer" });
    expect(again.name).toBe(first.name);
    expect(again.slug).toBe(first.slug);
    // No second registry entry was created.
    expect(Object.keys((await loadRegistry(home)).members)).toHaveLength(1);
  });

  test("slug-collision-safe against a member dir already on disk", async () => {
    // A member already occupies the slug McManus would take.
    await mkdir(join(home, "members", "mcmanus"), { recursive: true });
    const id = await assignThemedIdentity(home, { proposedName: "Atlas", role: "Engineer" });
    expect(id.slug).not.toBe("mcmanus");
    expect(id.name).not.toBe("McManus");
  });

  test("opt-out keeps the proposed name (no theming)", async () => {
    const id = await assignThemedIdentity(
      home,
      { proposedName: "Atlas", role: "Engineer" },
      { mode: "off" },
    );
    expect(id.name).toBe("Atlas");
    expect(id.slug).toBe("atlas");
    expect(id.themeId).toBeUndefined();
    expect(id.personality).toBeUndefined();
    // Opting out does not write a registry.
    expect(await loadRegistry(home)).toEqual({ version: 1, themeHistory: [], members: {} });
  });

  test("rolls to the next ensemble once the first is exhausted", async () => {
    // The Usual Suspects holds 8 characters; the 9th member rolls to the next.
    const ids = [];
    for (let i = 0; i < 9; i++) {
      ids.push(await assignThemedIdentity(home, { proposedName: `M${i}`, role: "Engineer" }));
    }
    const themes = ids.map((i) => i.themeId);
    expect(themes.slice(0, 8).every((t) => t === "usual-suspects")).toBe(true);
    expect(themes[8]).toBe("oceans-eleven");
    // All nine remain uniquely named across the two ensembles.
    expect(new Set(ids.map((i) => i.name)).size).toBe(9);
  });

  test("a pinned ensemble overrides the default selection", async () => {
    const id = await assignThemedIdentity(
      home,
      { proposedName: "Atlas", role: "Tech Lead" },
      { mode: "themed", pin: "firefly" },
    );
    expect(id.themeId).toBe("firefly");
    expect(id.name).toBe("Mal");
  });
});

describe("assignThemedIdentity with an llmProposal", () => {
  test("invents a new custom ensemble from newThemeLabel", async () => {
    const id = await assignThemedIdentity(home, {
      proposedName: "Atlas",
      role: "Engineer",
      llmProposal: {
        newThemeLabel: "Apollo 13",
        characterName: "Gene Kranz",
        personality: "Unflappable under pressure.",
        backstory: "Flight director who brings the crew home.",
      },
    });
    expect(id.name).toBe("Gene Kranz");
    expect(id.themeLabel).toBe("Apollo 13");
    expect(id.personality).toBe("Unflappable under pressure.");

    const reg = await loadRegistry(home);
    expect(reg.activeThemeId).toBe(id.themeId);
    expect(reg.customThemes?.[id.themeId!]?.label).toBe("Apollo 13");
    expect(reg.customThemes?.[id.themeId!]?.characters.map((c) => c.name)).toEqual(["Gene Kranz"]);
  });

  test("reuses an already-invented custom ensemble by id, growing its roster", async () => {
    const first = await assignThemedIdentity(home, {
      proposedName: "Atlas",
      role: "Lead",
      llmProposal: {
        newThemeLabel: "Apollo 13",
        characterName: "Gene Kranz",
        personality: "p",
        backstory: "b",
      },
    });
    const second = await assignThemedIdentity(home, {
      proposedName: "Bob",
      role: "Engineer",
      llmProposal: {
        themeId: first.themeId,
        characterName: "Jim Lovell",
        personality: "p2",
        backstory: "b2",
      },
    });
    expect(second.themeId).toBe(first.themeId);
    expect(second.themeLabel).toBe("Apollo 13");
    const reg = await loadRegistry(home);
    expect(reg.customThemes?.[first.themeId!]?.characters.map((c) => c.name).sort()).toEqual([
      "Gene Kranz",
      "Jim Lovell",
    ]);
  });

  test("a proposal whose characterName is already taken falls through to the deterministic engine", async () => {
    await assignThemedIdentity(home, { proposedName: "Atlas", role: "Engineer" }); // -> McManus (rung 1)
    const id = await assignThemedIdentity(home, {
      proposedName: "Bob",
      role: "Reviewer",
      llmProposal: {
        themeId: "usual-suspects",
        characterName: "McManus",
        personality: "p",
        backstory: "b",
      },
    });
    expect(id.themeId).toBe("usual-suspects");
    expect(id.name).not.toBe("McManus");
  });

  test("a static-theme proposal naming an unknown character falls through to the deterministic engine", async () => {
    const id = await assignThemedIdentity(home, {
      proposedName: "Atlas",
      role: "Engineer",
      llmProposal: {
        themeId: "usual-suspects",
        characterName: "Neo",
        personality: "p",
        backstory: "b",
      },
    });
    expect(id.themeId).toBe("usual-suspects");
    expect(id.name).not.toBe("Neo");
  });

  test("a malformed llmProposal (blank characterName) falls through to the deterministic engine", async () => {
    const id = await assignThemedIdentity(home, {
      proposedName: "Atlas",
      role: "Engineer",
      llmProposal: {
        newThemeLabel: "Some Show",
        characterName: "   ",
        personality: "p",
        backstory: "b",
      },
    });
    expect(id.themeId).toBe("usual-suspects");
    // No custom theme was minted from the rejected proposal.
    expect((await loadRegistry(home)).customThemes).toBeUndefined();
  });

  test("an absent llmProposal behaves exactly like the deterministic-only call", async () => {
    const id = await assignThemedIdentity(home, { proposedName: "Atlas", role: "Engineer" });
    expect(id.themeId).toBe("usual-suspects");
    expect(id.name).toBe("McManus");
  });

  test("a pin mismatch (proposal invents a different ensemble) falls through to the pinned ensemble", async () => {
    const id = await assignThemedIdentity(
      home,
      {
        proposedName: "Atlas",
        role: "Tech Lead",
        llmProposal: {
          newThemeLabel: "Some Other Show",
          characterName: "Nobody",
          personality: "p",
          backstory: "b",
        },
      },
      { mode: "themed", pin: "firefly" },
    );
    expect(id.themeId).toBe("firefly");
    expect(id.name).toBe("Mal");
  });

  test("a proposal inventing exactly the pinned (not-yet-known) ensemble is accepted", async () => {
    const id = await assignThemedIdentity(
      home,
      {
        proposedName: "Atlas",
        role: "Tech Lead",
        llmProposal: {
          newThemeLabel: "Apollo 13",
          characterName: "Gene Kranz",
          personality: "p",
          backstory: "b",
        },
      },
      { mode: "themed", pin: "Apollo 13" },
    );
    expect(id.name).toBe("Gene Kranz");
    expect(id.themeLabel).toBe("Apollo 13");
  });

  test("name-stability outranks a fresh, different llmProposal on re-cast", async () => {
    const first = await assignThemedIdentity(home, {
      proposedName: "Atlas",
      role: "Engineer",
      llmProposal: {
        newThemeLabel: "Apollo 13",
        characterName: "Gene Kranz",
        personality: "p",
        backstory: "b",
      },
    });
    const again = await assignThemedIdentity(home, {
      proposedName: "Atlas",
      role: "Engineer",
      llmProposal: {
        newThemeLabel: "A Totally Different Show",
        characterName: "Someone Else",
        personality: "p2",
        backstory: "b2",
      },
    });
    expect(again.name).toBe(first.name);
    expect(again.themeId).toBe(first.themeId);
    // characterInRegistry resolves the custom theme's stored voice, not the fresh proposal's.
    expect(again.personality).toBe(first.personality);
  });

  test("retire frees a custom-themed character for reuse and links lineage, without duplicating the roster", async () => {
    const first = await assignThemedIdentity(home, {
      proposedName: "Atlas",
      role: "Lead",
      llmProposal: {
        newThemeLabel: "Apollo 13",
        characterName: "Gene Kranz",
        personality: "original voice",
        backstory: "b",
      },
    });
    await retireCastingName(home, first.slug);

    const reused = await assignThemedIdentity(home, {
      proposedName: "Carl",
      role: "Lead",
      llmProposal: {
        themeId: first.themeId,
        characterName: "Gene Kranz",
        personality: "a different voice",
        backstory: "different",
      },
    });
    expect(reused.name).toBe("Gene Kranz");
    expect(reused.slug).toBe(first.slug);
    // The custom theme's canonical character (voice included) is reused verbatim,
    // not overwritten by the new proposal's wording.
    expect(reused.personality).toBe("original voice");

    const reg = await loadRegistry(home);
    expect(reg.members[first.slug]?.status).toBe("active");
    expect(reg.members[first.slug]?.previousName).toBe("Atlas");
    expect(reg.customThemes?.[first.themeId!]?.characters).toHaveLength(1);
    const archived = Object.values(reg.members).find((e) => e.status === "retired");
    expect(archived?.succeededBy).toBe(first.slug);
  });

  test("a custom theme rejects growth past CUSTOM_THEME_CAPACITY, falling through to the deterministic engine", async () => {
    const themeId = "packed-show";
    const characters = Array.from({ length: CUSTOM_THEME_CAPACITY }, (_, i) => ({
      name: `Character ${i}`,
      personality: "p",
      backstory: "b",
      preferredRoles: [],
    }));
    await saveRegistry(home, {
      version: 1,
      activeThemeId: themeId,
      themeHistory: [themeId],
      members: {},
      customThemes: { [themeId]: { label: "Packed Show", characters } },
    });

    const id = await assignThemedIdentity(home, {
      proposedName: "Atlas",
      role: "Engineer",
      llmProposal: { themeId, characterName: "Character 11", personality: "p", backstory: "b" },
    });
    // "packed-show" is a custom theme, invisible to the static-only deterministic
    // rung — it rolls to the catalog head instead of growing past capacity.
    expect(id.themeId).toBe("usual-suspects");
  });
});

describe("retire frees the name", () => {
  test("a retired character's name returns to the pool and links lineage on reuse", async () => {
    const first = await assignThemedIdentity(home, { proposedName: "Atlas", role: "Engineer" });
    expect(first.name).toBe("McManus");

    await retireCastingName(home, "mcmanus");
    const afterRetire = await loadRegistry(home);
    expect(afterRetire.members.mcmanus?.status).toBe("retired");

    // The freed name is available again; reusing it links the two via lineage.
    const reused = await assignThemedIdentity(home, { proposedName: "Bob", role: "Engineer" });
    expect(reused.name).toBe("McManus");
    expect(reused.slug).toBe("mcmanus");

    const reg = await loadRegistry(home);
    expect(reg.members.mcmanus?.status).toBe("active");
    expect(reg.members.mcmanus?.originalName).toBe("Bob");
    // Lineage: the active entry points back; the archived retired entry points forward.
    expect(reg.members.mcmanus?.previousName).toBe("Atlas");
    const archived = Object.values(reg.members).find((e) => e.status === "retired");
    expect(archived?.themedName).toBe("McManus");
    expect(archived?.succeededBy).toBe("mcmanus");
  });

  test("retiring an unknown slug is a fail-soft no-op", async () => {
    await expect(retireCastingName(home, "ghost")).resolves.toBeUndefined();
    await expect(retireCastingName(join(home, "nope"), "x")).resolves.toBeUndefined();
  });
});

describe("resolveThemingConfig", () => {
  test("themes ON by default", () => {
    expect(resolveThemingConfig({})).toEqual({ mode: "themed" });
  });

  test("KEELSON_SQUAD_THEMING=off opts out", () => {
    expect(resolveThemingConfig({ KEELSON_SQUAD_THEMING: "off" })).toEqual({ mode: "off" });
    expect(resolveThemingConfig({ KEELSON_SQUAD_THEMING: "false" })).toEqual({ mode: "off" });
  });

  test("KEELSON_SQUAD_THEME pins an ensemble", () => {
    expect(resolveThemingConfig({ KEELSON_SQUAD_THEME: "firefly" })).toEqual({
      mode: "themed",
      pin: "firefly",
    });
  });
});

describe("foldThemedCharter", () => {
  test("prepends the character's voice and drops the original H1, keeping the body", () => {
    const folded = foldThemedCharter(
      "# Atlas\n\n## Role\n\nBuilds.\n\n## Mission\n\nShip the search rib.",
      {
        name: "McManus",
        personality: "Bold and direct.",
        backstory: "The hotshot operator.",
        themeLabel: "The Usual Suspects",
      },
    );
    expect(folded.startsWith("# McManus")).toBe(true);
    expect(folded).toContain("Cast from The Usual Suspects");
    expect(folded).toContain("Bold and direct.");
    expect(folded).toContain("The hotshot operator.");
    // The original Role/Mission body survives; the old H1 does not.
    expect(folded).toContain("## Mission");
    expect(folded).toContain("Ship the search rib.");
    expect(folded).not.toContain("# Atlas");
  });
});
