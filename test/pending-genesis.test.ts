import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearPendingGenesis,
  pendingGenesisFile,
  readPendingGenesis,
  writePendingGenesis,
} from "../src/pending-genesis.ts";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "squad-pending-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("pending-genesis store", () => {
  test("write → read round-trips startedAt and role", async () => {
    await writePendingGenesis({ startedAt: "2026-07-08T00:00:00.000Z", role: "Engineer" }, home);
    expect(await readPendingGenesis(home)).toEqual({
      startedAt: "2026-07-08T00:00:00.000Z",
      role: "Engineer",
    });
  });

  test("role is optional — a freeform brief carries none", async () => {
    await writePendingGenesis({ startedAt: "2026-07-08T00:00:00.000Z" }, home);
    expect(await readPendingGenesis(home)).toEqual({ startedAt: "2026-07-08T00:00:00.000Z" });
  });

  test("a missing marker reads as null", async () => {
    expect(await readPendingGenesis(home)).toBeNull();
  });

  test("a torn / non-object / startedAt-less marker degrades to null", async () => {
    await writeFile(pendingGenesisFile(home), "{ not json");
    expect(await readPendingGenesis(home)).toBeNull();
    await writeFile(pendingGenesisFile(home), JSON.stringify({ role: "Engineer" }));
    expect(await readPendingGenesis(home)).toBeNull();
    await writeFile(pendingGenesisFile(home), JSON.stringify({ startedAt: "" }));
    expect(await readPendingGenesis(home)).toBeNull();
  });

  test("clear removes the marker and is safe to double-call", async () => {
    await writePendingGenesis({ startedAt: "2026-07-08T00:00:00.000Z" }, home);
    await clearPendingGenesis(home);
    expect(await readPendingGenesis(home)).toBeNull();
    await clearPendingGenesis(home); // no throw on a missing file
    expect(await readPendingGenesis(home)).toBeNull();
  });

  test("write persists valid JSON at the scope-local path", async () => {
    await writePendingGenesis({ startedAt: "2026-07-08T00:00:00.000Z", role: "Lead" }, home);
    const parsed = JSON.parse(await readFile(pendingGenesisFile(home), "utf8"));
    expect(parsed).toEqual({ startedAt: "2026-07-08T00:00:00.000Z", role: "Lead" });
  });
});
