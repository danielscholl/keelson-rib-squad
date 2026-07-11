import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceLease } from "@keelson/shared";
import {
  __resetWorkspaceStateForTest,
  acquireScopeWorktree,
  releaseScopeWorktree,
  reuseScopeWorktree,
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

describe("acquireScopeWorktree", () => {
  test("without the seam, falls back to the project root and persists nothing", async () => {
    const res = await acquireScopeWorktree({
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
    const res = await acquireScopeWorktree({
      scopeId: "s1",
      project: project(),
      scopeDataHome: scopeHome,
      acquire: s.acquire,
    });
    expect(res.leased).toBe(true);
    expect(res.path).not.toBe(root);
    expect(s.calls()).toBe(1);
    const rec = JSON.parse(await readFile(recordPath(), "utf8"));
    expect(rec).toEqual({ projectId: "p1", leaseId: "lease-1", worktreePath: res.path });
  });

  test("reuses the in-memory lease across calls (acquires once)", async () => {
    const s = stubAcquire();
    const a = await acquireScopeWorktree({
      scopeId: "s1",
      project: project(),
      scopeDataHome: scopeHome,
      acquire: s.acquire,
    });
    const b = await acquireScopeWorktree({
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
    const a = await acquireScopeWorktree({
      scopeId: "s1",
      project: project(),
      scopeDataHome: scopeHome,
      acquire: s.acquire,
    });
    const otherHome = await mkdtemp(join(tmpdir(), "squad-scope2-"));
    tempDirs.push(otherHome);
    const b = await acquireScopeWorktree({
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
    const a = await acquireScopeWorktree({
      scopeId: "s1",
      project: project(),
      scopeDataHome: scopeHome,
      acquire: s.acquire,
    });
    // Simulate a server restart: the in-memory handle is gone, but the persisted
    // record and its worktree survive.
    __resetWorkspaceStateForTest();
    const s2 = stubAcquire();
    const b = await acquireScopeWorktree({
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
    const a = await acquireScopeWorktree({
      scopeId: "s1",
      project: project(),
      scopeDataHome: scopeHome,
      acquire: s.acquire,
    });
    await rm(a.path, { recursive: true, force: true });
    __resetWorkspaceStateForTest();
    const s2 = stubAcquire();
    const b = await acquireScopeWorktree({
      scopeId: "s1",
      project: project(),
      scopeDataHome: scopeHome,
      acquire: s2.acquire,
    });
    expect(b.path).not.toBe(a.path);
    expect(s2.calls()).toBe(1);
  });

  test("re-acquires when the persisted worktree is bound to a different project", async () => {
    const s = stubAcquire();
    const a = await acquireScopeWorktree({
      scopeId: "s1",
      project: { id: "p1", rootPath: root },
      scopeDataHome: scopeHome,
      acquire: s.acquire,
    });
    // The scope rebound to a different project; the p1 worktree must not be reused.
    __resetWorkspaceStateForTest();
    const s2 = stubAcquire();
    const b = await acquireScopeWorktree({
      scopeId: "s1",
      project: { id: "p2", rootPath: root },
      scopeDataHome: scopeHome,
      acquire: s2.acquire,
    });
    expect(b.path).not.toBe(a.path);
    expect(s2.calls()).toBe(1);
  });

  test("concurrent acquisitions for different projects don't mis-route to one worktree", async () => {
    const s = stubAcquire();
    const [a, b] = await Promise.all([
      acquireScopeWorktree({
        scopeId: "s1",
        project: { id: "p1", rootPath: root },
        scopeDataHome: scopeHome,
        acquire: s.acquire,
      }),
      acquireScopeWorktree({
        scopeId: "s1",
        project: { id: "p2", rootPath: root },
        scopeDataHome: scopeHome,
        acquire: s.acquire,
      }),
    ]);
    // Serialized, so the second re-evaluates instead of awaiting the first's promise:
    // each project gets its own worktree rather than p2 mis-routing onto p1's.
    expect(a.path).not.toBe(b.path);
    expect(s.calls()).toBe(2);
  });

  test("releases the old in-memory lease when the scope rebinds to a different project", async () => {
    const s = stubAcquire();
    const a = await acquireScopeWorktree({
      scopeId: "s1",
      project: { id: "p1", rootPath: root },
      scopeDataHome: scopeHome,
      acquire: s.acquire,
    });
    const b = await acquireScopeWorktree({
      scopeId: "s1",
      project: { id: "p2", rootPath: root },
      scopeDataHome: scopeHome,
      acquire: s.acquire,
    });
    expect(b.path).not.toBe(a.path);
    expect(s.calls()).toBe(2);
    expect(s.released.has("lease-1")).toBe(true); // the old project's lease was released
  });

  test("keeps isolation when persisting the record fails", async () => {
    const s = stubAcquire();
    // A scopeDataHome nested under a regular file makes writeWorkspaceRecord's mkdir
    // fail — the acquired lease must still be used, not discarded for the root.
    const fileDir = await mkdtemp(join(tmpdir(), "squad-file-"));
    tempDirs.push(fileDir);
    const filePath = join(fileDir, "not-a-dir");
    await writeFile(filePath, "x");
    const res = await acquireScopeWorktree({
      scopeId: "s1",
      project: project(),
      scopeDataHome: join(filePath, "nested"),
      acquire: s.acquire,
    });
    expect(res.leased).toBe(true);
    expect(res.path).not.toBe(root);
    expect(s.calls()).toBe(1);
  });

  test("falls back to the project root when acquisition throws", async () => {
    const acquire = async () => {
      throw new Error("project is not a git repository");
    };
    const res = await acquireScopeWorktree({
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
      acquireScopeWorktree({
        scopeId: "s1",
        project: project(),
        scopeDataHome: scopeHome,
        acquire: s.acquire,
      }),
      acquireScopeWorktree({
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
    const a = await acquireScopeWorktree({
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
    const a = await acquireScopeWorktree({
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

  test("releases the lease even when clearing the record fails", async () => {
    const s = stubAcquire();
    await acquireScopeWorktree({
      scopeId: "s1",
      project: project(),
      scopeDataHome: scopeHome,
      acquire: s.acquire,
    });
    // Replace the record file with a directory so rm({ force }) throws (EISDIR).
    await rm(recordPath());
    await mkdir(recordPath());
    await releaseScopeWorktree({ scopeId: "s1", scopeDataHome: scopeHome });
    expect(s.released.has("lease-1")).toBe(true); // released despite the record-clear failure
  });

  test("release is a no-op when no lease is held", async () => {
    await releaseScopeWorktree({ scopeId: "never", scopeDataHome: scopeHome });
    expect(existsSync(recordPath())).toBe(false);
  });

  test("waits for an in-flight acquisition and releases the resulting lease", async () => {
    const dir = await mkdtemp(join(tmpdir(), "squad-lease-race-"));
    tempDirs.push(dir);
    let acquireCalled = false;
    let releaseCalled = false;
    let settle!: () => void;
    const acquire = async (): Promise<WorkspaceLease> => {
      acquireCalled = true;
      await new Promise<void>((r) => {
        settle = r;
      });
      return {
        id: "lrace",
        path: dir,
        branch: "b",
        release: async () => {
          releaseCalled = true;
        },
      };
    };
    const acquiringP = acquireScopeWorktree({
      scopeId: "s1",
      project: project(),
      scopeDataHome: scopeHome,
      acquire,
    });
    while (!acquireCalled) await new Promise((r) => setTimeout(r, 1));
    const releasingP = releaseScopeWorktree({ scopeId: "s1", scopeDataHome: scopeHome });
    settle(); // let the acquisition settle only after release is already awaiting it
    await acquiringP;
    await releasingP;
    expect(releaseCalled).toBe(true);
    // No leaked state: the post-settle writes were cleared by the release.
    const after = await reuseScopeWorktree({
      scopeId: "s1",
      projectId: "p1",
      rootPath: root,
      scopeDataHome: scopeHome,
    });
    expect(after.leased).toBe(false);
  });
});

describe("reuseScopeWorktree", () => {
  test("follows a producer's established worktree without acquiring", async () => {
    const s = stubAcquire();
    const a = await acquireScopeWorktree({
      scopeId: "s1",
      project: project(),
      scopeDataHome: scopeHome,
      acquire: s.acquire,
    });
    const res = await reuseScopeWorktree({
      scopeId: "s1",
      projectId: "p1",
      rootPath: root,
      scopeDataHome: scopeHome,
    });
    expect(res).toEqual({ path: a.path, leased: true });
    expect(s.calls()).toBe(1); // reuse never acquires
  });

  test("falls back to the project root when no worktree is established", async () => {
    const res = await reuseScopeWorktree({
      scopeId: "s1",
      projectId: "p1",
      rootPath: root,
      scopeDataHome: scopeHome,
    });
    expect(res).toEqual({ path: root, leased: false });
  });

  test("ignores a persisted worktree bound to a different project", async () => {
    const s = stubAcquire();
    await acquireScopeWorktree({
      scopeId: "s1",
      project: project(),
      scopeDataHome: scopeHome,
      acquire: s.acquire,
    });
    __resetWorkspaceStateForTest();
    // Same scope id, different bound project — must not route to p1's worktree.
    const res = await reuseScopeWorktree({
      scopeId: "s1",
      projectId: "p2",
      rootPath: "/other/repo",
      scopeDataHome: scopeHome,
    });
    expect(res).toEqual({ path: "/other/repo", leased: false });
  });

  test("rebinds to the persisted worktree after in-memory state is lost", async () => {
    const s = stubAcquire();
    const a = await acquireScopeWorktree({
      scopeId: "s1",
      project: project(),
      scopeDataHome: scopeHome,
      acquire: s.acquire,
    });
    __resetWorkspaceStateForTest();
    const res = await reuseScopeWorktree({
      scopeId: "s1",
      projectId: "p1",
      rootPath: root,
      scopeDataHome: scopeHome,
    });
    expect(res).toEqual({ path: a.path, leased: true });
  });
});
