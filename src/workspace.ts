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
// object in memory. The `{ leaseId, worktreePath }` record persists so a restart
// rebinds to the same checkout by PATH (the open_pr → resolve_review chain stays
// on one branch across a restart); a rebound lease has no release closure, so it
// falls back to `git worktree remove` and lets host reconcile drop the row.

const WORKSPACE_FILE = "workspace.json";

const heldLeases = new Map<string, WorkspaceLease>();
const acquiring = new Map<string, Promise<WorkspaceLease>>();

interface WorkspaceRecord {
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
    if (typeof parsed?.leaseId !== "string" || !parsed.leaseId) return undefined;
    if (typeof parsed.worktreePath !== "string" || !parsed.worktreePath) return undefined;
    return { leaseId: parsed.leaseId, worktreePath: parsed.worktreePath };
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

// The scope's existing worktree, if one is live (in-memory handle, then persisted
// path). Returns undefined when nothing is established — the caller decides whether
// to acquire (a work producer) or fall back to the project root (a consumer).
async function existingScopeWorktree(
  scopeId: string,
  scopeDataHome: string,
): Promise<string | undefined> {
  const held = heldLeases.get(scopeId);
  if (held) {
    if (existsSync(held.path)) return held.path;
    // The checkout vanished under us (manual removal); drop the stale handle.
    heldLeases.delete(scopeId);
  }
  const persisted = await readWorkspaceRecord(scopeDataHome);
  if (persisted && existsSync(persisted.worktreePath)) return persisted.worktreePath;
  return undefined;
}

// For a work PRODUCER (squad_code / squad_coordinate): reuse the scope's worktree
// if one is live, else lease a fresh one. Concurrent first-mutations of one scope
// share a single in-flight acquisition rather than racing two worktrees into being.
// Falls back to the project root when the seam is absent or acquisition fails.
export async function acquireScopeWorktree(opts: {
  scopeId: string;
  project: { id: string; rootPath: string };
  scopeDataHome: string;
  acquire: RibContext["acquireWorkspace"];
}): Promise<ResolvedWorkspace> {
  const { scopeId, project, scopeDataHome, acquire } = opts;

  const existing = await existingScopeWorktree(scopeId, scopeDataHome);
  if (existing) return { path: existing, leased: true };

  if (!acquire) return { path: project.rootPath, leased: false };

  let inflight = acquiring.get(scopeId);
  if (!inflight) {
    inflight = acquire({ projectId: project.id, purpose: `squad:${scopeId}` })
      .then(async (lease) => {
        heldLeases.set(scopeId, lease);
        await writeWorkspaceRecord(scopeDataHome, {
          leaseId: lease.id,
          worktreePath: lease.path,
        });
        return lease;
      })
      .finally(() => acquiring.delete(scopeId));
    acquiring.set(scopeId, inflight);
  }
  try {
    const lease = await inflight;
    return { path: lease.path, leased: true };
  } catch (err) {
    console.warn(
      `[squad] workspace lease acquisition failed for scope "${scopeId}"; using project root: ${errText(err)}`,
    );
    return { path: project.rootPath, leased: false };
  }
}

// For a CONSUMER of the scope's work (open_pr / resolve_review / view_diff /
// rollback): follow the producer's established worktree when one is live, else the
// project root. It must NEVER acquire — a consumer that leased a fresh main-based
// worktree would act on the wrong branch (e.g. resolve_review would push the empty
// lease branch, not the PR branch its threads live on).
export async function reuseScopeWorktree(opts: {
  scopeId: string;
  rootPath: string;
  scopeDataHome: string;
}): Promise<ResolvedWorkspace> {
  const existing = await existingScopeWorktree(opts.scopeId, opts.scopeDataHome);
  return existing ? { path: existing, leased: true } : { path: opts.rootPath, leased: false };
}

// Release the scope's worktree — call on scope close (last member retired, squad
// reset), NOT on a failed run: keep-on-failure leaves the persistent worktree in
// place for the next run and inspection. A held lease releases through its own
// closure (removes the worktree + drops the host row). A rebound lease (post-
// restart, closure lost) only clears the record; its worktree is left for host
// reconcile / `keelson workspace` cleanup — a release-by-id seam would close that
// gap (tracked upstream).
export async function releaseScopeWorktree(opts: {
  scopeId: string;
  scopeDataHome: string;
}): Promise<void> {
  const { scopeId, scopeDataHome } = opts;
  const held = heldLeases.get(scopeId);
  heldLeases.delete(scopeId);
  await clearWorkspaceRecord(scopeDataHome);
  if (held) {
    await held.release().catch((err) => {
      console.warn(
        `[squad] failed to release workspace lease for scope "${scopeId}": ${errText(err)}`,
      );
    });
  }
}

// Test-only: clear the in-memory lease/acquisition maps between cases so the
// module-global state does not leak across tests.
export function __resetWorkspaceStateForTest(): void {
  heldLeases.clear();
  acquiring.clear();
}
