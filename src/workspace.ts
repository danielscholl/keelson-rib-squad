// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RibContext, WorkspaceLease } from "@keelson/shared";

// Per-scope working tree. Squad's mutation tools (code, coordinate, open_pr,
// resolve_review, view_diff, rollback) are independent MCP calls that share one
// working tree across the run — so the isolation unit is the SCOPE, not a single
// call. A work PRODUCER (`acquireScopeWorktree`: squad_code / squad_coordinate)
// leases an isolated worktree on first use; every CONSUMER of that work
// (`reuseScopeWorktree`: open_pr / resolve_review / view_diff / rollback) follows
// the established worktree but never leases its own — a consumer that leased a
// fresh main-based checkout would act on the wrong branch. A concurrent squad run
// in another scope, or an external edit on the operator's main checkout, no longer
// collide (keelson #524). Without the seam the whole rib degrades to
// `project.rootPath` — the legacy behavior, unchanged.
//
// The seam is acquire-only (no list / release-by-id), so reuse holds the lease
// object in memory. The `{ projectId, leaseId, worktreePath }` record persists so a
// restart rebinds to the same checkout by PATH (the open_pr → resolve_review chain
// stays on one branch across a restart); a rebound lease has no release closure, so
// releasing it only clears the record and leaves the worktree for host cleanup
// (keelson #555). The record's projectId guards against reusing a worktree after a
// scope's bound project changed.

const WORKSPACE_FILE = "workspace.json";

interface HeldLease {
  lease: WorkspaceLease;
  projectId: string;
}

const heldLeases = new Map<string, HeldLease>();

// Every state-mutating op for a scope (acquire, release) runs under a per-scope
// chain, so they never interleave — a second acquire for the same scope sees the
// first's settled lease and reuses it, and a rebind or release can't race a
// half-finished acquisition. Reads (reuseScopeWorktree) stay lock-free.
const scopeChains = new Map<string, Promise<unknown>>();

function serializeByScope<T>(scopeId: string, fn: () => Promise<T>): Promise<T> {
  const prev = scopeChains.get(scopeId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  const guard = next.catch(() => {});
  scopeChains.set(scopeId, guard);
  void guard.then(() => {
    if (scopeChains.get(scopeId) === guard) scopeChains.delete(scopeId);
  });
  return next;
}

interface WorkspaceRecord {
  projectId: string;
  leaseId: string;
  worktreePath: string;
}

export interface ResolvedWorkspace {
  /** The directory every git-mutating operation of the run should target. */
  path: string;
  /** True when `path` is a leased worktree; false when it fell back to root. */
  leased: boolean;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function readWorkspaceRecord(scopeDataHome: string): Promise<WorkspaceRecord | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(scopeDataHome, WORKSPACE_FILE), "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<WorkspaceRecord>;
    if (typeof parsed?.projectId !== "string" || !parsed.projectId) return undefined;
    if (typeof parsed.leaseId !== "string" || !parsed.leaseId) return undefined;
    if (typeof parsed.worktreePath !== "string" || !parsed.worktreePath) return undefined;
    return {
      projectId: parsed.projectId,
      leaseId: parsed.leaseId,
      worktreePath: parsed.worktreePath,
    };
  } catch {
    return undefined;
  }
}

async function writeWorkspaceRecord(scopeDataHome: string, record: WorkspaceRecord): Promise<void> {
  await mkdir(scopeDataHome, { recursive: true });
  await writeFile(join(scopeDataHome, WORKSPACE_FILE), `${JSON.stringify(record, null, 2)}\n`);
}

async function clearWorkspaceRecord(scopeDataHome: string): Promise<void> {
  await rm(join(scopeDataHome, WORKSPACE_FILE), { force: true });
}

// The scope's existing worktree, if one is live for THIS project (in-memory handle,
// then persisted path). A projectId mismatch — the scope rebound to a different
// project — is ignored, never mis-routed to the old project's checkout. Returns
// undefined when nothing is established; the caller decides whether to acquire (a
// work producer) or fall back to the project root (a consumer).
async function existingScopeWorktree(
  scopeId: string,
  projectId: string,
  scopeDataHome: string,
): Promise<string | undefined> {
  const held = heldLeases.get(scopeId);
  if (held?.projectId === projectId) {
    if (existsSync(held.lease.path)) return held.lease.path;
    // The checkout vanished under us (manual removal); drop the stale handle.
    heldLeases.delete(scopeId);
  }
  const persisted = await readWorkspaceRecord(scopeDataHome);
  if (persisted && persisted.projectId === projectId && existsSync(persisted.worktreePath)) {
    return persisted.worktreePath;
  }
  return undefined;
}

// For a work PRODUCER (squad_code / squad_coordinate): reuse the scope's worktree
// if one is live, else lease a fresh one. Serialized per scope, so concurrent
// first-mutations of one scope share the same worktree (the second sees the first's
// lease) instead of racing two into being. Falls back to the project root when the
// seam is absent or acquisition fails.
export function acquireScopeWorktree(opts: {
  scopeId: string;
  project: { id: string; rootPath: string };
  scopeDataHome: string;
  acquire: RibContext["acquireWorkspace"];
}): Promise<ResolvedWorkspace> {
  const { scopeId, project, scopeDataHome, acquire } = opts;
  return serializeByScope(scopeId, async () => {
    const existing = await existingScopeWorktree(scopeId, project.id, scopeDataHome);
    if (existing) return { path: existing, leased: true };

    if (!acquire) return { path: project.rootPath, leased: false };

    // The scope rebound to a different project: release the old project's lease
    // before acquiring the new one, or overwriting the in-memory handle would strand
    // it. (A rebound-only stale lease — persisted, no closure — is the keelson #555 gap.)
    const stale = heldLeases.get(scopeId);
    if (stale && stale.projectId !== project.id) {
      heldLeases.delete(scopeId);
      await stale.lease.release().catch((err) => {
        console.warn(
          `[rib-squad] failed to release stale-project workspace lease for scope "${scopeId}": ${errText(err)}`,
        );
      });
    }

    let lease: WorkspaceLease;
    try {
      lease = await acquire({ projectId: project.id, purpose: `squad:${scopeId}` });
    } catch (err) {
      console.warn(
        `[rib-squad] workspace lease acquisition failed for scope "${scopeId}"; using project root: ${errText(err)}`,
      );
      return { path: project.rootPath, leased: false };
    }
    heldLeases.set(scopeId, { lease, projectId: project.id });
    // Persist is only a rebind convenience — a write failure must NOT defeat the
    // isolation we just acquired, so swallow it (restart-rebind is degraded).
    try {
      await writeWorkspaceRecord(scopeDataHome, {
        projectId: project.id,
        leaseId: lease.id,
        worktreePath: lease.path,
      });
    } catch (err) {
      console.warn(
        `[rib-squad] leased a workspace for scope "${scopeId}" but persisting its record failed (rebind won't survive a restart): ${errText(err)}`,
      );
    }
    return { path: lease.path, leased: true };
  });
}

// For a CONSUMER of the scope's work (open_pr / resolve_review / view_diff /
// rollback): follow the producer's established worktree when one is live, else the
// project root. It must NEVER acquire — a consumer that leased a fresh main-based
// worktree would act on the wrong branch (e.g. resolve_review would push the empty
// lease branch, not the PR branch its threads live on).
export async function reuseScopeWorktree(opts: {
  scopeId: string;
  projectId: string;
  rootPath: string;
  scopeDataHome: string;
}): Promise<ResolvedWorkspace> {
  const existing = await existingScopeWorktree(opts.scopeId, opts.projectId, opts.scopeDataHome);
  return existing ? { path: existing, leased: true } : { path: opts.rootPath, leased: false };
}

// Release the scope's worktree — call on scope close (last member retired, squad
// reset), NOT on a failed run: keep-on-failure leaves the persistent worktree in
// place for the next run and inspection. A held lease releases through its own
// closure (removes the worktree + drops the host row). A rebound lease (post-
// restart, closure lost) only clears the record; its worktree is left for host
// reconcile / `keelson workspace` cleanup — a release-by-id seam would close that
// gap (keelson #555).
export function releaseScopeWorktree(opts: {
  scopeId: string;
  scopeDataHome: string;
}): Promise<void> {
  const { scopeId, scopeDataHome } = opts;
  // Serialized behind any in-flight acquisition, so its writes (heldLeases + record)
  // have already landed and can't reappear after we clear them and leak the lease.
  return serializeByScope(scopeId, async () => {
    const held = heldLeases.get(scopeId);
    heldLeases.delete(scopeId);
    await clearWorkspaceRecord(scopeDataHome);
    if (held) {
      await held.lease.release().catch((err) => {
        console.warn(
          `[rib-squad] failed to release workspace lease for scope "${scopeId}": ${errText(err)}`,
        );
      });
    }
  });
}

// Test-only: clear the in-memory lease + per-scope chain maps between cases so the
// module-global state does not leak across tests.
export function __resetWorkspaceStateForTest(): void {
  heldLeases.clear();
  scopeChains.clear();
}
