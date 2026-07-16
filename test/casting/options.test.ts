import { describe, expect, test } from "bun:test";
import { castingOptions } from "../../src/casting/options.ts";
import type { CastingRegistry, ThemingConfig } from "../../src/casting/registry.ts";
import { THEMES } from "../../src/casting/themes.ts";

const empty: CastingRegistry = { version: 1, themeHistory: [], members: {} };
const themed: ThemingConfig = { mode: "themed" };
const off: ThemingConfig = { mode: "off" };

describe("castingOptions", () => {
  test("off mode returns a minimal, static view with no catalog", () => {
    expect(castingOptions(empty, off)).toEqual({
      mode: "off",
      themeHistory: [],
      catalog: [],
      customThemes: [],
      takenCharacterNames: [],
    });
  });

  test("a fresh registry has no active theme but lists the full static catalog", () => {
    const view = castingOptions(empty, themed);
    expect(view.mode).toBe("themed");
    expect(view.activeTheme).toBeUndefined();
    expect(view.themeHistory).toEqual([]);
    expect(view.catalog).toHaveLength(THEMES.length);
    expect(view.catalog[0]).toEqual({
      id: THEMES[0]!.id,
      label: THEMES[0]!.label,
      characterNames: THEMES[0]!.characters.map((c) => c.name),
    });
    expect(view.customThemes).toEqual([]);
    expect(view.takenCharacterNames).toEqual([]);
  });

  test("an active static theme reports remaining capacity and taken names", () => {
    const usualSuspects = THEMES[0]!;
    const reg: CastingRegistry = {
      version: 1,
      activeThemeId: usualSuspects.id,
      themeHistory: [usualSuspects.id],
      members: {
        mcmanus: { themedName: "McManus", themeId: usualSuspects.id, status: "active" },
        verbal: { themedName: "Verbal", themeId: usualSuspects.id, status: "active" },
      },
    };
    const view = castingOptions(reg, themed);
    expect(view.activeTheme).toEqual({
      id: usualSuspects.id,
      label: usualSuspects.label,
      remainingCapacity: usualSuspects.characters.length - 2,
    });
    expect(view.takenCharacterNames).toEqual(["McManus", "Verbal"]);
  });

  test("an exhausted static theme reports zero remaining capacity", () => {
    const usualSuspects = THEMES[0]!;
    const members: CastingRegistry["members"] = {};
    for (const c of usualSuspects.characters) {
      members[c.name.toLowerCase()] = {
        themedName: c.name,
        themeId: usualSuspects.id,
        status: "active",
      };
    }
    const reg: CastingRegistry = {
      version: 1,
      activeThemeId: usualSuspects.id,
      themeHistory: [usualSuspects.id],
      members,
    };
    expect(castingOptions(reg, themed).activeTheme?.remainingCapacity).toBe(0);
  });

  test("a theme whose members are all retired is no longer active", () => {
    const usualSuspects = THEMES[0]!;
    const reg: CastingRegistry = {
      version: 1,
      activeThemeId: usualSuspects.id,
      themeHistory: [usualSuspects.id],
      members: {
        mcmanus: { themedName: "McManus", themeId: usualSuspects.id, status: "retired" },
        verbal: { themedName: "Verbal", themeId: usualSuspects.id, status: "retired" },
      },
    };
    const view = castingOptions(reg, themed);
    // The cast that empties a roster must not pin the next one to the same ensemble.
    expect(view.activeTheme).toBeUndefined();
    expect(view.takenCharacterNames).toEqual([]);
    // Still in history, so the next cast is nudged toward freshness rather than blind.
    expect(view.themeHistory).toEqual([usualSuspects.id]);
  });

  test("an unseated active theme falls back to the ensemble the roster still sits in", () => {
    const usualSuspects = THEMES[0]!;
    const oceans = THEMES[1]!;
    const reg: CastingRegistry = {
      version: 1,
      // The squad rolled to a second ensemble, then that ensemble's only member retired
      // while the first still seats members — the roster has a cast, the pointer doesn't.
      activeThemeId: oceans.id,
      themeHistory: [usualSuspects.id, oceans.id],
      members: {
        mcmanus: { themedName: "McManus", themeId: usualSuspects.id, status: "active" },
        verbal: { themedName: "Verbal", themeId: usualSuspects.id, status: "active" },
        danny: { themedName: "Danny", themeId: oceans.id, status: "retired" },
      },
    };
    // Reporting no active theme here would tell the next cast to found a fresh ensemble
    // and scatter a live squad; only an empty roster has no cast.
    expect(castingOptions(reg, themed).activeTheme).toEqual({
      id: usualSuspects.id,
      label: usualSuspects.label,
      remainingCapacity: usualSuspects.characters.length - 2,
    });
  });

  test("a custom theme is listed with its own remaining capacity, active or not", () => {
    const reg: CastingRegistry = {
      version: 1,
      activeThemeId: "apollo-13",
      themeHistory: ["apollo-13"],
      members: {
        "gene-kranz": { themedName: "Gene Kranz", themeId: "apollo-13", status: "active" },
      },
      customThemes: {
        "apollo-13": {
          label: "Apollo 13",
          characters: [
            { name: "Gene Kranz", personality: "p", backstory: "b", preferredRoles: [] },
          ],
        },
      },
    };
    const view = castingOptions(reg, themed);
    expect(view.activeTheme).toEqual({ id: "apollo-13", label: "Apollo 13", remainingCapacity: 9 });
    expect(view.customThemes).toEqual([
      { id: "apollo-13", label: "Apollo 13", characterNames: ["Gene Kranz"], remainingCapacity: 9 },
    ]);
  });

  test("surfaces a resolvable or unresolvable pin verbatim either way", () => {
    expect(castingOptions(empty, { mode: "themed", pin: "firefly" }).pin).toBe("firefly");
    expect(castingOptions(empty, { mode: "themed", pin: "Apollo 13" }).pin).toBe("Apollo 13");
  });
});
