import { describe, expect, test } from "bun:test";
import type { Member } from "../src/types.ts";
import {
  IDENTITY_SLOT_COUNT,
  identitySlotForIndex,
  identityToneForSlot,
  identityTonesByMember,
  normalizeIdentitySlot,
} from "../src/types.ts";

const member = (over: Partial<Member> = {}): Member => ({
  slug: "lead",
  name: "Lead",
  role: "Tech Lead",
  charter: "You are the Lead.",
  status: "active",
  ...over,
});

describe("identityToneForSlot", () => {
  test("maps the five slots to the reserved id tones in cast order", () => {
    expect([0, 1, 2, 3, 4].map(identityToneForSlot)).toEqual([
      "id-blue",
      "id-amber",
      "id-teal",
      "id-rose",
      "id-olive",
    ]);
  });

  test("anything without a valid slot folds to neutral — never a hash", () => {
    expect(identityToneForSlot(undefined)).toBe("neutral");
    expect(identityToneForSlot(-1)).toBe("neutral");
    expect(identityToneForSlot(5)).toBe("neutral");
    expect(identityToneForSlot(2.5)).toBe("neutral");
  });

  test("a cast index past the ramp folds to neutral rather than repeating a hue", () => {
    expect([0, 1, 2, 3, 4, 5].map((i) => identityToneForSlot(identitySlotForIndex(i)))).toEqual([
      "id-blue",
      "id-amber",
      "id-teal",
      "id-rose",
      "id-olive",
      "neutral",
    ]);
    expect(identityToneForSlot(identitySlotForIndex(7))).toBe("neutral");
  });
});

describe("normalizeIdentitySlot", () => {
  test("the out-of-ramp sentinel round-trips instead of folding onto slot 0", () => {
    // readMembers passes no fallback index, so bounding the domain below the
    // sentinel would reload a 6th member as slot 0 — the first member's hue.
    expect(normalizeIdentitySlot(IDENTITY_SLOT_COUNT)).toBe(IDENTITY_SLOT_COUNT);
    expect(identityToneForSlot(normalizeIdentitySlot(IDENTITY_SLOT_COUNT))).toBe("neutral");
  });

  test("the five seated slots survive a round-trip", () => {
    expect([0, 1, 2, 3, 4].map((s) => normalizeIdentitySlot(s))).toEqual([0, 1, 2, 3, 4]);
  });

  test("a slot outside the domain is drift — repaired from cast order", () => {
    expect(normalizeIdentitySlot(99, 2)).toBe(2);
    expect(normalizeIdentitySlot(undefined, 2)).toBe(2);
    expect(normalizeIdentitySlot(-1, 3)).toBe(3);
    expect(normalizeIdentitySlot(2.5, 1)).toBe(1);
    expect(normalizeIdentitySlot("nope", 0)).toBe(0);
  });
});

describe("identityTonesByMember", () => {
  test("keys the map by slug and by lowercased display name", () => {
    const map = identityTonesByMember([
      member({ slug: "keyser", name: "Keyser", identitySlot: 0 }),
      member({ slug: "edie-2", name: "Edie", identitySlot: 4 }),
      member({ slug: "slotless", name: "Slotless" }),
    ]);
    expect(map.get("keyser")).toBe("id-blue");
    expect(map.get("edie-2")).toBe("id-olive");
    expect(map.get("edie")).toBe("id-olive");
    expect(map.get("slotless")).toBe("neutral");
    expect(map.get("stranger")).toBeUndefined();
  });
});
