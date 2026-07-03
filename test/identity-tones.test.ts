import { describe, expect, test } from "bun:test";
import type { Member } from "../src/types.ts";
import { identitySlotForIndex, identityToneForSlot, identityTonesByMember } from "../src/types.ts";

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

  test("slot assignment clamps the cast index into the slot range", () => {
    expect(identityToneForSlot(identitySlotForIndex(7))).toBe("id-olive");
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
