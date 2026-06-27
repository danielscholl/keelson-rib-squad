import { describe, expect, test } from "bun:test";
import {
  assignCharacter,
  selectTheme,
  type ThemeUsage,
  themeSelectionOrder,
} from "../../src/casting/engine.ts";
import { THEMES, themeById } from "../../src/casting/themes.ts";

const usualSuspects = themeById("usual-suspects")!;

const usage = (over: Partial<ThemeUsage> = {}): ThemeUsage => ({
  themeHistory: [],
  activeCountByTheme: {},
  ...over,
});

describe("assignCharacter best-fit", () => {
  test("prefers a character whose PRIMARY role matches", () => {
    expect(assignCharacter("Engineer", usualSuspects, new Set())?.name).toBe("McManus");
    expect(assignCharacter("Reviewer", usualSuspects, new Set())?.name).toBe("Edie");
    expect(assignCharacter("Tech Lead", usualSuspects, new Set())?.name).toBe("Keyser");
  });

  test("falls back to a character that merely LISTS the role", () => {
    // Fenster is the only primary tester; with it taken, the next tester is Edie,
    // who only lists tester (primary reviewer).
    const picked = assignCharacter("Tester", usualSuspects, new Set(["Fenster"]));
    expect(picked?.name).toBe("Edie");
    expect(picked?.preferredRoles).toContain("tester");
  });

  test("falls back to any free character when no role matches", () => {
    // No "pm" anywhere in The Usual Suspects -> first free character.
    expect(assignCharacter("PM", usualSuspects, new Set())?.name).toBe("Keyser");
  });

  test("returns undefined only when every character is taken", () => {
    const all = new Set(usualSuspects.characters.map((c) => c.name));
    expect(assignCharacter("Engineer", usualSuspects, all)).toBeUndefined();
  });

  test("never returns a taken character", () => {
    const taken = new Set(["McManus"]);
    const picked = assignCharacter("Engineer", usualSuspects, taken);
    expect(picked?.name).not.toBe("McManus");
    expect(taken.has(picked?.name ?? "")).toBe(false);
  });
});

describe("selectTheme (deterministic)", () => {
  test("a fresh squad casts from the catalog head", () => {
    expect(selectTheme(usage()).id).toBe(THEMES[0]!.id);
  });

  test("reuses the active ensemble while it has capacity", () => {
    const u = usage({
      activeThemeId: "oceans-eleven",
      themeHistory: ["oceans-eleven"],
      activeCountByTheme: { "oceans-eleven": 3 },
    });
    expect(selectTheme(u).id).toBe("oceans-eleven");
  });

  test("rolls to the next ensemble when the active one is exhausted", () => {
    const us = themeById("usual-suspects")!;
    const u = usage({
      activeThemeId: "usual-suspects",
      themeHistory: ["usual-suspects"],
      activeCountByTheme: { "usual-suspects": us.characters.length },
    });
    // The exhausted active theme is not chosen; the next never-used one is.
    const next = selectTheme(u);
    expect(next.id).not.toBe("usual-suspects");
    expect(next.id).toBe(THEMES[1]!.id);
  });

  test("is least-recently-used: never-used ensembles come before used ones", () => {
    const u = usage({ themeHistory: ["oceans-eleven", "usual-suspects"] });
    const order = themeSelectionOrder(u);
    const usedRank = order.findIndex((t) => t.id === "oceans-eleven");
    const neverUsed = order.findIndex((t) => t.id === THEMES[2]!.id);
    expect(neverUsed).toBeLessThan(usedRank);
    // Among used, the less-recently-used (oceans, earlier in history) precedes the
    // most-recent (usual-suspects).
    const oceans = order.findIndex((t) => t.id === "oceans-eleven");
    const usual = order.findIndex((t) => t.id === "usual-suspects");
    expect(oceans).toBeLessThan(usual);
  });

  test("the same usage always yields the same choice (no randomness)", () => {
    const u = usage({ themeHistory: ["firefly"] });
    expect(selectTheme(u).id).toBe(selectTheme(u).id);
    expect(themeSelectionOrder(u).map((t) => t.id)).toEqual(
      themeSelectionOrder(u).map((t) => t.id),
    );
  });
});
