import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ribDataDir } from "@keelson/shared/paths";
import { stableHash } from "./genesis.ts";

// The Squad data home — the rib's data directory under the keelson home,
// captured once at activation from ctx.getDataDir() (setSquadDataHome) so every
// in-process reader (genesis write, charter reads, auth probe) and the baked-in
// roster bash node resolve the identical path, cwd-independently. The fallback,
// ribDataDir("squad"), is the same per-rib path the host's getDataDir seam
// returns, covering a harness predating the seam or an out-of-process caller
// with no captured value.
let dataHome: string | undefined;

export function setSquadDataHome(dir: string | undefined): void {
  dataHome = dir;
}

export function squadDataHome(): string {
  return dataHome ?? ribDataDir("squad");
}

export function membersDir(): string {
  return join(squadDataHome(), "members");
}

// The sentinel scope that maps to the legacy flat paths, so existing data stays
// where it is and an unscoped harness is byte-for-byte unchanged.
export const DEFAULT_SCOPE_ID = "default";

// A scope id becomes one path segment under <home>/projects/, so it must be a bare
// token. An already-safe, non-empty id passes through verbatim; anything else (a
// separator, traversal token, or odd char) collapses to a stable hash of the
// ORIGINAL so two distinct ids can never sanitize onto the same segment.
export function safeScopeSegment(id: string): string {
  const sanitized = id.replace(/[^A-Za-z0-9_-]+/g, "-");
  if (sanitized.length > 0 && sanitized === id) return sanitized;
  return `s-${stableHash(id)}`;
}

export function scopeDataHome(home: string, scopeId: string): string {
  return scopeId === DEFAULT_SCOPE_ID ? home : join(home, "projects", safeScopeSegment(scopeId));
}

export function scopeMembersDir(home: string, scopeId: string): string {
  return join(scopeDataHome(home, scopeId), "members");
}

// Recursive mkdir doubles as a writability probe — idempotent if the dir exists
// (genesis creates it anyway), and fails only when the path isn't writable.
export async function isSquadDataHomeWritable(): Promise<boolean> {
  try {
    await mkdir(squadDataHome(), { recursive: true });
    return true;
  } catch {
    return false;
  }
}
