import { describe, expect, test } from "bun:test";
import { assertSafeSlug, slugify } from "../src/genesis.ts";

describe("slugify", () => {
  test("kebab-cases a name", () => {
    expect(slugify("Scout the Researcher")).toBe("scout-the-researcher");
  });

  test("strips punctuation and collapses separators", () => {
    expect(slugify("  Ada, Lovelace!! ")).toBe("ada-lovelace");
  });

  test("preserves accented letters instead of dropping them", () => {
    expect(slugify("Café")).toBe("cafe");
  });

  test("falls back to a deterministic safe slug for a non-sluggable name", () => {
    // all-punctuation and non-Latin scripts reduce to empty -> deterministic fallback
    for (const name of ["!!!", "研究员", "مرحبا"]) {
      const slug = slugify(name);
      expect(slug).toMatch(/^member-[a-z0-9]+$/);
      expect(() => assertSafeSlug(slug)).not.toThrow();
    }
    expect(slugify("研究员")).toBe(slugify("研究员")); // deterministic
  });

  test("the produced slug is always path-safe", () => {
    expect(() => assertSafeSlug(slugify("Lead / ../ Reviewer"))).not.toThrow();
  });
});

describe("assertSafeSlug", () => {
  test("rejects path traversal and separators", () => {
    expect(() => assertSafeSlug("../etc")).toThrow();
    expect(() => assertSafeSlug("a/b")).toThrow();
    expect(() => assertSafeSlug("")).toThrow();
    expect(() => assertSafeSlug("Caps")).toThrow();
  });
});
