import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CoordinatorLedger } from "../src/coordinator.ts";
import { archiveRun, listRuns, loadRun } from "../src/runs-store.ts";

let home: string;

function idFor(createdAt: string): string {
  return createdAt.replaceAll(/[:.]/g, "-");
}

function ledger(overrides: Partial<CoordinatorLedger> = {}): CoordinatorLedger {
  return {
    task: "ship feature",
    facts: [],
    plan: [],
    round: 0,
    stallCount: 0,
    resetCount: 0,
    status: "done",
    transcript: [],
    createdAt: "2026-06-30T00:00:00.000Z",
    updatedAt: "2026-06-30T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "squad-runs-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("archiveRun", () => {
  test("writes <home>/runs/<id>.json", async () => {
    const createdAt = "2026-06-30T01:02:03.456Z";
    await archiveRun(home, ledger({ createdAt }));
    const files = await readdir(join(home, "runs"));
    expect(files).toEqual([`${idFor(createdAt)}.json`]);
  });

  test("re-archiving the same ledger keeps exactly one run file/summary", async () => {
    const createdAt = "2026-06-30T01:02:03.456Z";
    const run = ledger({ createdAt, updatedAt: "2026-06-30T02:00:00.000Z" });
    await archiveRun(home, run);
    await archiveRun(home, run);

    const files = await readdir(join(home, "runs"));
    expect(files).toEqual([`${idFor(createdAt)}.json`]);

    const summaries = await listRuns(home);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.id).toBe(idFor(createdAt));
  });
});

describe("listRuns", () => {
  test("returns summaries sorted by updatedAt DESC", async () => {
    await archiveRun(
      home,
      ledger({
        task: "oldest",
        createdAt: "2026-06-30T00:00:00.000Z",
        updatedAt: "2026-06-30T00:01:00.000Z",
      }),
    );
    await archiveRun(
      home,
      ledger({
        task: "newest",
        createdAt: "2026-06-30T00:00:01.000Z",
        updatedAt: "2026-06-30T00:03:00.000Z",
      }),
    );
    await archiveRun(
      home,
      ledger({
        task: "middle",
        createdAt: "2026-06-30T00:00:02.000Z",
        updatedAt: "2026-06-30T00:02:00.000Z",
      }),
    );

    const runs = await listRuns(home);
    expect(runs.map((r) => r.task)).toEqual(["newest", "middle", "oldest"]);
  });

  test("returns [] when runs/ is missing", async () => {
    expect(await listRuns(home)).toEqual([]);
  });

  test("skips an unparseable run file", async () => {
    await archiveRun(
      home,
      ledger({
        createdAt: "2026-06-30T00:00:00.000Z",
        updatedAt: "2026-06-30T00:00:00.000Z",
      }),
    );
    await mkdir(join(home, "runs"), { recursive: true });
    await writeFile(join(home, "runs", "bad.json"), "{not json");

    const runs = await listRuns(home);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe(idFor("2026-06-30T00:00:00.000Z"));
  });
});

describe("loadRun", () => {
  test("round-trips an archived ledger by its listed id", async () => {
    const createdAt = "2026-06-30T01:02:03.456Z";
    await archiveRun(home, ledger({ createdAt, task: "the archived task", round: 7 }));
    const [summary] = await listRuns(home);
    const loaded = await loadRun(home, summary?.id ?? "");
    expect(loaded?.task).toBe("the archived task");
    expect(loaded?.round).toBe(7);
  });

  test("returns undefined for an unknown id", async () => {
    expect(await loadRun(home, idFor("2026-06-30T09:09:09.999Z"))).toBeUndefined();
  });

  test("refuses a path-escaping id", async () => {
    expect(await loadRun(home, "../coordinator-ledger")).toBeUndefined();
    expect(await loadRun(home, "a/b")).toBeUndefined();
  });

  test("returns undefined for a file that is not a ledger", async () => {
    await mkdir(join(home, "runs"), { recursive: true });
    await writeFile(join(home, "runs", "bogus.json"), JSON.stringify({ nope: 1 }));
    expect(await loadRun(home, "bogus")).toBeUndefined();
  });
});
