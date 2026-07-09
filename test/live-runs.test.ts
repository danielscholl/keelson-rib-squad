import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CoordinatorLedger,
  LEDGER_STATUS_ACTIVE,
  RUN_STATUS_DONE,
  saveLedger,
} from "../src/coordinator.ts";
import { listLiveRunsElsewhere } from "../src/live-runs.ts";
import { DEFAULT_SCOPE_ID, scopeDataHome } from "../src/paths.ts";
import { writeProjectsSnapshot } from "../src/scope.ts";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "squad-live-runs-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("listLiveRunsElsewhere", () => {
  test("returns an active run in another scope with resolved details", async () => {
    await writeProjectsSnapshot(home, [{ id: "beta", name: "Beta Project" }]);
    await saveLedger(
      scopeDataHome(home, "beta"),
      ledger({ scopeId: "beta", task: "Ship the cue", round: 3 }),
    );

    expect(await listLiveRunsElsewhere(home, "alpha")).toEqual([
      { scopeId: "beta", name: "Beta Project", task: "Ship the cue", round: 3 },
    ]);
  });

  test("excludes an active run in the selected scope", async () => {
    await saveLedger(scopeDataHome(home, "alpha"), ledger({ scopeId: "alpha" }));

    expect(await listLiveRunsElsewhere(home, "alpha")).toEqual([]);
  });

  test("excludes terminal ledgers in other scopes", async () => {
    await saveLedger(scopeDataHome(home, "beta"), ledger({ scopeId: "beta", status: RUN_STATUS_DONE }));

    expect(await listLiveRunsElsewhere(home, "alpha")).toEqual([]);
  });

  test("returns no runs when no project tree or default ledger exists", async () => {
    expect(await listLiveRunsElsewhere(home, DEFAULT_SCOPE_ID)).toEqual([]);
  });

  test("skips a corrupt ledger without throwing", async () => {
    const betaHome = scopeDataHome(home, "beta");
    await mkdir(betaHome, { recursive: true });
    await writeFile(join(betaHome, "coordinator-ledger.json"), "{ torn");

    expect(await listLiveRunsElsewhere(home, "alpha")).toEqual([]);
  });

  test("resolves names by scope id, then project id, then falls back to the scope id", async () => {
    await writeProjectsSnapshot(home, [
      { id: "beta", name: "Beta Scope" },
      { id: "project-beta", name: "Beta Project" },
      { id: "project-gamma", name: "Gamma Project" },
    ]);
    await saveLedger(
      scopeDataHome(home, "beta"),
      ledger({ scopeId: "beta", projectId: "project-beta", task: "Beta task", round: 2 }),
    );
    await saveLedger(
      scopeDataHome(home, "gamma"),
      ledger({ scopeId: "gamma", projectId: "project-gamma", task: "Gamma task", round: 4 }),
    );
    await saveLedger(
      scopeDataHome(home, "delta"),
      ledger({ scopeId: "delta", task: "Delta task", round: 1 }),
    );

    expect(await listLiveRunsElsewhere(home, "alpha")).toEqual([
      { scopeId: "beta", name: "Beta Scope", task: "Beta task", round: 2 },
      { scopeId: "delta", task: "Delta task", round: 1 },
      { scopeId: "gamma", name: "Gamma Project", task: "Gamma task", round: 4 },
    ]);
  });
});

function ledger(overrides: Partial<CoordinatorLedger> = {}): CoordinatorLedger {
  return {
    task: "Coordinate a change",
    facts: [],
    plan: [],
    round: 1,
    stallCount: 0,
    resetCount: 0,
    status: LEDGER_STATUS_ACTIVE,
    transcript: [],
    createdAt: "2026-07-08T00:00:00.000Z",
    updatedAt: "2026-07-08T00:00:00.000Z",
    ...overrides,
  };
}
