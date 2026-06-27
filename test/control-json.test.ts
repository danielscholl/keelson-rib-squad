import { describe, expect, test } from "bun:test";
import { extractTrailingJsonObject, parseTrailingDirective } from "../src/control-json.ts";

describe("extractTrailingJsonObject", () => {
  test("keeps the LAST balanced top-level object", () => {
    expect(extractTrailingJsonObject('a {"x":1} b {"y":2}')).toBe('{"y":2}');
  });

  test("ignores braces inside strings", () => {
    expect(extractTrailingJsonObject('{"s":"a } b {"}')).toBe('{"s":"a } b {"}');
  });

  test("handles nested objects", () => {
    expect(extractTrailingJsonObject('pre {"a":{"b":2}}')).toBe('{"a":{"b":2}}');
  });

  test("handles escaped quotes inside strings", () => {
    expect(extractTrailingJsonObject('{"s":"he said \\"hi\\""}')).toBe('{"s":"he said \\"hi\\""}');
  });

  test("returns null when there is no object", () => {
    expect(extractTrailingJsonObject("no braces here")).toBeNull();
  });

  test("skips an unbalanced candidate and finds a later balanced one", () => {
    expect(extractTrailingJsonObject('{ unbalanced ... {"good":1}')).toBe('{"good":1}');
  });
});

describe("parseTrailingDirective", () => {
  const actions = new Set(["x"]);

  test("parses a trailing directive and returns the prose head", () => {
    const r = parseTrailingDirective('thinking out loud\n{"action":"x","v":1}', actions);
    expect(r?.parsed.v).toBe(1);
    expect(r?.head).toBe("thinking out loud");
  });

  test("rejects a non-trailing object (text after it)", () => {
    expect(parseTrailingDirective('{"action":"x"} and then more', actions)).toBeNull();
  });

  test("rejects an unknown action", () => {
    expect(parseTrailingDirective('{"action":"y"}', actions)).toBeNull();
  });

  test("rejects a missing action", () => {
    expect(parseTrailingDirective('{"v":1}', actions)).toBeNull();
  });

  test("returns null on malformed JSON", () => {
    expect(parseTrailingDirective('{"action":"x", bad}', actions)).toBeNull();
  });

  test("returns null when there is no object at all", () => {
    expect(parseTrailingDirective("just prose", actions)).toBeNull();
  });
});
