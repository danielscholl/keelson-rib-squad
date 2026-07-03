import { describe, expect, test } from "bun:test";
import { validateProviderPin } from "../src/provider-pins.ts";

describe("validateProviderPin", () => {
  test("drops a reserved provider id even when no registry is available", () => {
    for (const provider of ["workflow", "stub"]) {
      const { pin, note } = validateProviderPin(
        "member 'atlas'",
        { provider, model: "m1" },
        undefined,
      );
      expect(pin).toEqual({});
      expect(note).toContain(`"${provider}"`);
      expect(note).toContain("not assignable");
    }
  });

  test("keeps a non-reserved pin when no registry is available (older harness)", () => {
    const { pin, note } = validateProviderPin(
      "member 'atlas'",
      { provider: "copilot", model: "gpt-5.5" },
      undefined,
    );
    expect(pin).toEqual({ provider: "copilot", model: "gpt-5.5" });
    expect(note).toBeUndefined();
  });
});
