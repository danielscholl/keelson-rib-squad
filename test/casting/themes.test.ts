import { describe, expect, test } from "bun:test";
import {
  type CanonicalRole,
  canonicalRole,
  DEFAULT_THEME_ID,
  findTheme,
  THEMES,
  themeById,
  themeLabel,
} from "../../src/casting/themes.ts";
import { slugify } from "../../src/genesis.ts";

describe("theme catalog integrity", () => {
  test("ships a reasonable number of ensembles", () => {
    expect(THEMES.length).toBeGreaterThanOrEqual(6);
    expect(THEMES.length).toBeLessThanOrEqual(12);
  });

  test("theme ids are unique", () => {
    expect(new Set(THEMES.map((t) => t.id)).size).toBe(THEMES.length);
  });

  test("the default theme id resolves to a real ensemble (catalog head)", () => {
    expect(themeById(DEFAULT_THEME_ID)).toBeDefined();
    expect(DEFAULT_THEME_ID).toBe(THEMES[0]!.id);
  });

  for (const theme of THEMES) {
    describe(theme.label, () => {
      test("has a roster of 6-12 named characters", () => {
        expect(theme.characters.length).toBeGreaterThanOrEqual(6);
        expect(theme.characters.length).toBeLessThanOrEqual(12);
      });

      test("character names are unique and slug-safe", () => {
        const names = theme.characters.map((c) => c.name);
        expect(new Set(names).size).toBe(names.length);
        const slugs = theme.characters.map((c) => slugify(c.name));
        // Distinct names must not collide on slug (they become member dir names).
        expect(new Set(slugs).size).toBe(slugs.length);
      });

      test("every character carries personality, backstory, and at least one role", () => {
        for (const c of theme.characters) {
          expect(c.personality.length).toBeGreaterThan(0);
          expect(c.backstory.length).toBeGreaterThan(0);
          expect(c.preferredRoles.length).toBeGreaterThan(0);
        }
      });

      test("covers the core squad seats (lead, engineer, reviewer, tester)", () => {
        // Best-fit reaches a role via either a primary or a secondary preferredRole,
        // so each core seat need only be LISTED somewhere in the ensemble.
        for (const seat of ["lead", "engineer", "reviewer", "tester"] as CanonicalRole[]) {
          expect(theme.characters.some((c) => c.preferredRoles.includes(seat))).toBe(true);
        }
      });
    });
  }
});

describe("canonicalRole", () => {
  test("maps free-form titles onto the canonical vocabulary", () => {
    expect(canonicalRole("Tech Lead")).toBe("lead");
    expect(canonicalRole("Backend Engineer")).toBe("engineer");
    expect(canonicalRole("DevOps Engineer")).toBe("devops");
    expect(canonicalRole("QA Tester")).toBe("tester");
    expect(canonicalRole("Code Reviewer")).toBe("reviewer");
    expect(canonicalRole("Technical Writer")).toBe("docs");
    expect(canonicalRole("Security Auditor")).toBe("security");
    expect(canonicalRole("UX Designer")).toBe("designer");
    expect(canonicalRole("Product Manager")).toBe("pm");
    expect(canonicalRole("Software Architect")).toBe("architect");
  });

  test("defaults an unrecognized role to engineer", () => {
    expect(canonicalRole("")).toBe("engineer");
    expect(canonicalRole("Wizard")).toBe("engineer");
  });

  test("is identity on the canonical vocabulary itself", () => {
    for (const r of [
      "lead",
      "architect",
      "engineer",
      "reviewer",
      "tester",
      "docs",
      "devops",
      "security",
      "designer",
      "pm",
    ] as CanonicalRole[]) {
      expect(canonicalRole(r)).toBe(r);
    }
  });
});

describe("theme lookup helpers", () => {
  test("themeLabel returns the human label or undefined", () => {
    expect(themeLabel("usual-suspects")).toBe("The Usual Suspects");
    expect(themeLabel("nope")).toBeUndefined();
  });

  test("findTheme matches an id or a label, case-insensitively", () => {
    expect(findTheme("firefly")?.id).toBe("firefly");
    expect(findTheme("The Usual Suspects")?.id).toBe("usual-suspects");
    expect(findTheme("OCEAN'S ELEVEN")?.id).toBe("oceans-eleven");
    expect(findTheme("not-a-theme")).toBeUndefined();
  });
});
