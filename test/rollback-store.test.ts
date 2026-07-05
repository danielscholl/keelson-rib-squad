import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendRollbackRow,
  latestPerformedRollbackRow,
  listRollbackRows,
  type RollbackRow,
  readRollbackRows,
} from "../src/rollback-store.ts";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "squad-rollbacks-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function performed(overrides: Partial<RollbackRow> = {}): RollbackRow {
  return {
    type: "performed",
    runId: "run-1",
    at: "2026-07-05T00:00:00.000Z",
    preRollbackTree: "tree-after",
    preRollbackHead: "head-after",
    rollbackRef: "refs/keelson/rollback/run-1",
    baselineTree: "tree-before",
    baselineHeadSha: "head-before",
    revertedCommits: [{ sha: "abc1234", subject: "ship change" }],
    revertedPaths: ["src/a.ts"],
    deletedPaths: ["src/new.ts"],
    ...overrides,
  } as RollbackRow;
}

describe("rollback store", () => {
  test("appends and reads rows keyed by runId", async () => {
    await appendRollbackRow(home, performed());
    await appendRollbackRow(home, {
      type: "refused",
      runId: "run-1",
      at: "2026-07-05T00:01:00.000Z",
      reason: "head-rewritten",
      observedHead: "later-head",
    });
    await appendRollbackRow(home, { type: "noop", runId: "run-2", at: "2026-07-05T00:02:00.000Z" });

    const rows = await readRollbackRows(home, "run-1");
    expect(rows.map((row) => row.type)).toEqual(["performed", "refused"]);
    expect(await readRollbackRows(home, "../run-1")).toEqual([]);
  });

  test("lists rows newest first and skips malformed lines", async () => {
    await appendRollbackRow(home, performed({ runId: "run-1", at: "2026-07-05T00:00:00.000Z" }));
    await appendRollbackRow(home, { type: "noop", runId: "run-2", at: "2026-07-05T00:02:00.000Z" });
    await writeFile(join(home, "rollbacks", "bad.jsonl"), "{not json\n");

    const rows = await listRollbackRows(home);
    expect(rows.map((row) => row.runId)).toEqual(["run-2", "run-1"]);
  });

  test("finds latest performed row for a run", async () => {
    await appendRollbackRow(
      home,
      performed({ at: "2026-07-05T00:00:00.000Z", preRollbackHead: "old" }),
    );
    await appendRollbackRow(home, { type: "noop", runId: "run-1", at: "2026-07-05T00:01:00.000Z" });
    await appendRollbackRow(
      home,
      performed({ at: "2026-07-05T00:02:00.000Z", preRollbackHead: "new" }),
    );

    expect((await latestPerformedRollbackRow(home, "run-1"))?.preRollbackHead).toBe("new");
  });

  test("throws on appending an unsafe run id", async () => {
    await expect(appendRollbackRow(home, performed({ runId: "../run" }))).rejects.toThrow(
      "unsafe rollback run id",
    );
  });
});
