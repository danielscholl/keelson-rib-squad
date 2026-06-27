import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assignThemedIdentity,
  type CastingRegistry,
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
