import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SCOPE_ID } from "../src/paths.ts";
import {
  clearSelectedProject,
  readProjectsSnapshot,
  readSelectedProject,
  type SelectedProject,
  selectedScopeId,
  writeProjectsSnapshot,
  writeSelectedProject,
} from "../src/scope.ts";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "squad-scope-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("selected project", () => {
  test("write then read round-trips", async () => {
    const sel: SelectedProject = {
      scopeId: "alpha",
      projectId: "alpha",
      name: "Alpha",
      rootPath: "/repos/alpha",
      at: "2026-06-30T00:00:00.000Z",
    };
    await writeSelectedProject(home, sel);
    expect(await readSelectedProject(home)).toEqual(sel);
  });

  test("missing file reads as undefined", async () => {
    expect(await readSelectedProject(home)).toBeUndefined();
  });

  test("corrupt file reads as undefined (no throw)", async () => {
    await writeFile(join(home, "selected-project.json"), "{ torn json");
    expect(await readSelectedProject(home)).toBeUndefined();
  });

  test("a selection missing scopeId reads as undefined", async () => {
    await writeFile(join(home, "selected-project.json"), JSON.stringify({ name: "x" }));
    expect(await readSelectedProject(home)).toBeUndefined();
  });

  test("clear removes the selection", async () => {
    await writeSelectedProject(home, { scopeId: "alpha", at: "" });
    await clearSelectedProject(home);
    expect(await readSelectedProject(home)).toBeUndefined();
  });

  test("clear on a missing file is a no-op (no throw)", async () => {
    await clearSelectedProject(home);
    expect(await readSelectedProject(home)).toBeUndefined();
  });
});

describe("selectedScopeId", () => {
  test("an undefined selection resolves to the default sentinel", () => {
    expect(selectedScopeId(undefined)).toBe(DEFAULT_SCOPE_ID);
    expect(selectedScopeId(undefined)).toBe("default");
  });

  test("a selection's scopeId wins", () => {
    expect(selectedScopeId({ scopeId: "alpha", at: "" })).toBe("alpha");
  });
});

describe("projects snapshot", () => {
  test("write then read round-trips the id/name pairs", async () => {
    await writeProjectsSnapshot(home, [
      { id: "a", name: "Alpha" },
      { id: "b", name: "Beta" },
    ]);
    expect(await readProjectsSnapshot(home)).toEqual([
      { id: "a", name: "Alpha" },
      { id: "b", name: "Beta" },
    ]);
  });

  test("missing snapshot reads as an empty list", async () => {
    expect(await readProjectsSnapshot(home)).toEqual([]);
  });

  test("corrupt snapshot reads as an empty list (no throw)", async () => {
    await writeFile(join(home, "projects.json"), "{ torn");
    expect(await readProjectsSnapshot(home)).toEqual([]);
  });
});
