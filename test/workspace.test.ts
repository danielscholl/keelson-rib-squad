import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceLease } from "@keelson/shared";
import {
  __resetWorkspaceStateForTest,
  releaseScopeWorktree,
  resolveScopeWorktree,
} from "../src/workspace.ts";

let root: string; // fake project root
let scopeHome: string; // scope data home
const tempDirs: string[] = [];

// A stub acquireWorkspace seam: each call mints a real temp dir as the leased
// worktree (so the existsSync reuse checks see a live path) and records releases.
function stubAcquire() {
  let calls = 0;
  const released = new Set<string>();
  const acquire = async (req: {
    projectId: string;
    purpose: string;
    branch?: string;
  }): Promise<WorkspaceLease> => {
    calls += 1;
    const dir = await mkdtemp(join(tmpdir(), "squad-lease-"));
    tempDirs.push(dir);
    const id = `lease-${calls}`;
    return {
      id,
      path: dir,
      branch: `keelson/lease/${req.purpose}`,
      release: async () => {
        released.add(id);
        await rm(dir, { recursive: true, force: true });
      },
    };
  };
  return { acquire, calls: () => calls, released };
}

beforeEach(async () => {
  __resetWorkspaceStateForTest();
  root = await mkdtemp(join(tmpdir(), "squad-root-"));
  scopeHome = await mkdtemp(join(tmpdir(), "squad-scope-"));
  tempDirs.push(root, scopeHome);
});

afterEach(async () => {
  __resetWorkspaceStateForTest();
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const project = () => ({ id: "p1", rootPath: root });
const recordPath = () => join(scopeHome, "workspace.json");

describe("resolveScopeWorktree", () => {
  test("without the seam, falls back to the project root and persists nothing", async () => {
    const res = await resolveScopeWorktree({
      scopeId: "s1",
      project: project(),
      scopeDataHome: scopeHome,
      acquire: undefined,
    });
    expect(res).toEqual({ path: root, leased: false });
    expect(existsSync(recordPath())).toBe(false);
  });

  test("acquires a leased worktree and persists the record", async () => {
    const s = stubAcquire();
    const res = await resolveScopeWorktree({
      scopeId: "s1",
      project: project(),
      scopeDataHome: scopeHome,
      acquire: s.acquire,
    });
    expect(res.leased).toBe(true);
    expect(res.path).not.toBe(root);
    expect(s.calls()).toBe(1);
    const rec = JSON.parse(await readFile(recordPath(), "utf8"));
    expect(rec).toEqual({ leaseId: "lease-1", worktreePath: res.path });
  });

  test("reuses the in-memory lease across calls (acquires once)", async () => {
    const s = stubAcquire();
    const a = await resolveScopeWorktree({
      scopeId: "s1",
      project: project(),
      scopeDataHome: scopeHome,
      acquire: s.acquire,
    });
    const b = await resolveScopeWorktree({
      scopeId: "s1",
      project: project(),
      scopeDataHome: scopeHome,
      acquire: s.acquire,
    });
    expect(b.path).toBe(a.path);
    expect(s.calls()).toBe(1);
  });

  test("different scopes get different worktrees", async () => {
    const s = stubAcquire();
    const a = await resolveScopeWorktree({
      scopeId: "s1",
      project: project(),
      scopeDataHome: scopeHome,
      acquire: s.acquire,
    });
    const otherHome = await mkdtemp(join(tmpdir(), "squad-scope2-"));
    tempDirs.push(otherHome);
    const b = await resolveScopeWorktree({
      scopeId: "s2",
      project: project(),
      scopeDataHome: otherHome,
      acquire: s.acquire,
    });
    expect(b.path).not.toBe(a.path);
    expect(s.calls()).toBe(2);
  });

  test("rebinds to the persisted worktree path after in-memory state is lost", async () => {
    const s = stubAcquire();
    const a = await resolveScopeWorktree({
      scopeId: "s1",
      project: project(),
      scopeDataHome: scopeHome,
      acquire: s.acquire,
    });
    // Simulate a server restart: the in-memory handle is gone, but the persisted
    // record and its worktree survive.
    __resetWorkspaceStateForTest();
    const s2 = stubAcquire();
    const b = await resolveScopeWorktree({
      scopeId: "s1",
      project: project(),
      scopeDataHome: scopeHome,
      acquire: s2.acquire,
    });
    expect(b).toEqual({ path: a.path, leased: true });
    expect(s2.calls()).toBe(0);
  });

  test("re-acquires when the persisted worktree has vanished", async () => {
    const s = stubAcquire();
    const a = await resolveScopeWorktree({
      scopeId: "s1",
      project: project(),
      scopeDataHome: scopeHome,
      acquire: s.acquire,
    });
    await rm(a.path, { recursive: true, force: true });
    __resetWorkspaceStateForTest();
    const s2 = stubAcquire();
    const b = await resolveScopeWorktree({
      scopeId: "s1",
      project: project(),
      scopeDataHome: scopeHome,
      acquire: s2.acquire,
    });
    expect(b.path).not.toBe(a.path);
    expect(s2.calls()).toBe(1);
  });

  test("falls back to the project root when acquisition throws", async () => {
    const acquire = async () => {
      throw new Error("project is not a git repository");
    };
    const res = await resolveScopeWorktree({
      scopeId: "s1",
      project: project(),
      scopeDataHome: scopeHome,
      acquire,
    });
    expect(res).toEqual({ path: root, leased: false });
    expect(existsSync(recordPath())).toBe(false);
  });

  test("concurrent first-acquisitions of one scope share a single worktree", async () => {
    const s = stubAcquire();
    const [a, b] = await Promise.all([
      resolveScopeWorktree({
        scopeId: "s1",
        project: project(),
        scopeDataHome: scopeHome,
        acquire: s.acquire,
      }),
      resolveScopeWorktree({
        scopeId: "s1",
        project: project(),
        scopeDataHome: scopeHome,
        acquire: s.acquire,
      }),
    ]);
    expect(a.path).toBe(b.path);
    expect(s.calls()).toBe(1);
  });
});

describe("releaseScopeWorktree", () => {
  test("runs the held lease closure and clears the record", async () => {
    const s = stubAcquire();
    const a = await resolveScopeWorktree({
      scopeId: "s1",
      project: project(),
      scopeDataHome: scopeHome,
      acquire: s.acquire,
    });
    expect(existsSync(recordPath())).toBe(true);
    await releaseScopeWorktree({ scopeId: "s1", scopeDataHome: scopeHome });
    expect(s.released.has("lease-1")).toBe(true);
    expect(existsSync(recordPath())).toBe(false);
    expect(existsSync(a.path)).toBe(false);
  });

  test("releasing a rebound lease clears the record without a closure", async () => {
    const s = stubAcquire();
    const a = await resolveScopeWorktree({
      scopeId: "s1",
      project: project(),
      scopeDataHome: scopeHome,
      acquire: s.acquire,
    });
    // Rebound (post-restart): the closure is gone, only the record + dir remain.
    __resetWorkspaceStateForTest();
    await releaseScopeWorktree({ scopeId: "s1", scopeDataHome: scopeHome });
    expect(existsSync(recordPath())).toBe(false);
    // The orphaned worktree is left for host cleanup — the documented limitation.
    expect(existsSync(a.path)).toBe(true);
  });

  test("release is a no-op when no lease is held", async () => {
    await releaseScopeWorktree({ scopeId: "never", scopeDataHome: scopeHome });
    expect(existsSync(recordPath())).toBe(false);
  });
});
