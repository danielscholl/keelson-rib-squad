import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CoordinatorLedger, loadLedger, saveLedger } from "../src/coordinator.ts";
import { reconcileOrphanedLedger } from "../src/index.ts";
import { listRuns } from "../src/runs-store.ts";

// reconcileOrphanedLedger is what squad_stop falls back to when the in-memory live-run
// tracker has lost a run whose persisted ledger still reads "active" — the orphaned-run
// case where the two sources of truth disagree and the board shows a phantom live run.

const NOW = "2026-01-01T00:00:00.000Z";

function activeLedger(overrides: Partial<CoordinatorLedger> = {}): CoordinatorLedger {
  return {
    task: "ship it",
    facts: [],
    plan: [],
    round: 3,
    stallCount: 0,
    resetCount: 0,
    status: "active",
    transcript: [{ round: 0, kind: "coordinator", text: "planning" }],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("reconcileOrphanedLedger", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "squad-reconcile-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  test("flips a stuck-active ledger to aborted, clears inFlight, and archives it", async () => {
    await saveLedger(
      home,
      activeLedger({
        inFlight: { round: 3, speaker: "coordinator", action: "planning", startedAt: NOW },
      }),
    );

    expect(await reconcileOrphanedLedger(home)).toBe(true);

    const after = await loadLedger(home);
    expect(after?.status).toBe("aborted");
    expect(after?.inFlight).toBeUndefined();
    const last = after?.transcript.at(-1);
    expect(last?.kind).toBe("failed");
    expect(last?.outcome).toBe("aborted");

    const runs = await listRuns(home);
    expect(runs.length).toBe(1);
    expect(runs[0]?.status).toBe("aborted");
  });

  test("returns false when there is no ledger (nothing to reconcile)", async () => {
    expect(await reconcileOrphanedLedger(home)).toBe(false);
    expect(await listRuns(home)).toEqual([]);
  });

  test("returns false for an already-terminal ledger and leaves it untouched", async () => {
    const done = activeLedger({ status: "done", round: 5, transcript: [] });
    await saveLedger(home, done);

    expect(await reconcileOrphanedLedger(home)).toBe(false);
    expect(await loadLedger(home)).toEqual(done);
    expect(await listRuns(home)).toEqual([]);
  });

  test("reconciles an older ledger whose transcript is missing without throwing", async () => {
    // loadLedger validates only `task`, so a pre-transcript / malformed ledger loads with no
    // transcript array; reconciliation must guard the spread instead of throwing out of squad_stop.
    await saveLedger(
      home,
      activeLedger({ transcript: undefined as unknown as CoordinatorLedger["transcript"] }),
    );

    expect(await reconcileOrphanedLedger(home)).toBe(true);
    const after = await loadLedger(home);
    expect(after?.status).toBe("aborted");
    expect(after?.transcript.at(-1)?.outcome).toBe("aborted");
  });
});
