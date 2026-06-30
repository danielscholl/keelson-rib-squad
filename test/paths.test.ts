import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  DEFAULT_SCOPE_ID,
  safeScopeSegment,
  scopeDataHome,
  scopeMembersDir,
} from "../src/paths.ts";

const HOME = "/var/squad-home";

describe("scopeDataHome", () => {
  test("the default scope maps to the legacy flat home (no projects subtree)", () => {
    expect(scopeDataHome(HOME, DEFAULT_SCOPE_ID)).toBe(HOME);
  });

  test("a project id nests under projects/<segment>", () => {
    expect(scopeDataHome(HOME, "alpha")).toBe(join(HOME, "projects", "alpha"));
  });
});

describe("scopeMembersDir", () => {
  // The load-bearing no-op invariant: the default scope's members dir is byte-for-byte
  // the legacy <home>/members, so existing rosters are untouched.
  test("the default scope equals the legacy <home>/members", () => {
    expect(scopeMembersDir(HOME, DEFAULT_SCOPE_ID)).toBe(join(HOME, "members"));
  });

  test("a project id nests members under its scope subtree", () => {
    expect(scopeMembersDir(HOME, "alpha")).toBe(join(HOME, "projects", "alpha", "members"));
  });
});

describe("safeScopeSegment", () => {
  test("passes an already-safe id through verbatim", () => {
    expect(safeScopeSegment("alpha")).toBe("alpha");
    expect(safeScopeSegment("proj_1-2")).toBe("proj_1-2");
  });

  test("never emits a path separator or a traversal token", () => {
    for (const id of ["..", "../escape", "a/b/c", ".", "./x", "a\\b", "foo/../bar", "  "]) {
      const seg = safeScopeSegment(id);
      expect(seg).not.toContain("/");
      expect(seg).not.toContain("\\");
      expect(seg).not.toBe("..");
      expect(seg).not.toBe(".");
      // a scoped home stays strictly under the projects subtree — one segment, no climb.
      const root = join("/home", "projects");
      expect(join(root, seg).startsWith(`${root}/`)).toBe(true);
    }
  });

  test("two distinct ids never collide on the same segment", () => {
    const ids = ["a/b", "a-b", "a.b", "a b", "..", ".", "alpha", "alpha!", "alpha@", "x/y", "x\\y"];
    const segs = ids.map(safeScopeSegment);
    expect(new Set(segs).size).toBe(ids.length);
  });
});
