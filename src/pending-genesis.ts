import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

// A genesis in flight: the marker the author action writes before the squad-genesis
// workflow runs, so the roster surface can show a boot card in the seat being taken.
// `startedAt` drives the elapsed counter + the stall timeout; `role` is known when a
// starter archetype was authored (Lead/Engineer/…) and absent for a freeform brief.
// The member's NAME is never carried here — squad assigns it from the cast theme during
// the genesis turn — so the boot card holds "calibrating…" until the real card lands.
// One marker per scope; a second author in the same scope overwrites it.
export interface PendingGenesis {
  startedAt: string;
  role?: string;
}

// Lives in the scope's own data home (next to members/), so the out-of-process roster
// collector resolves the same path from the baked home + selected scope, and a pending
// genesis in one project never bleeds a boot card into another's roster.
const PENDING_FILE = "pending-genesis.json";

export function pendingGenesisFile(scopeHome: string): string {
  return join(scopeHome, PENDING_FILE);
}

// Tolerant read: a missing/corrupt/torn file — or one without a string startedAt —
// degrades to null (no pending genesis), the same fail-soft contract the other
// scope-local reads keep.
export async function readPendingGenesis(scopeHome: string): Promise<PendingGenesis | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(pendingGenesisFile(scopeHome), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const p = parsed as Record<string, unknown>;
    if (typeof p.startedAt !== "string" || p.startedAt.length === 0) return null;
    return {
      startedAt: p.startedAt,
      ...(typeof p.role === "string" && p.role ? { role: p.role } : {}),
    };
  } catch {
    return null;
  }
}

// Monotonic per-write suffix so two overlapping writes never share a temp path — the
// rename stays atomic under a race.
let writeSeq = 0;

// Atomic write (temp + rename) so a crash mid-write can't leave a torn marker the next
// read would discard.
export async function writePendingGenesis(
  marker: PendingGenesis,
  scopeHome: string,
): Promise<void> {
  await mkdir(scopeHome, { recursive: true });
  const file = pendingGenesisFile(scopeHome);
  const tmp = `${file}.${process.pid}.${writeSeq++}.tmp`;
  await writeFile(tmp, `${JSON.stringify(marker, null, 2)}\n`);
  await rename(tmp, file);
}

// Clear the marker by removing the file (an absent file IS "no pending"). Fail-soft on a
// missing file so a double-clear (emit + dismiss racing) never throws.
export async function clearPendingGenesis(scopeHome: string): Promise<void> {
  await rm(pendingGenesisFile(scopeHome), { force: true });
}
