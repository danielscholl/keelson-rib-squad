import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCastBoard } from "../src/boards/cast.ts";
import { buildCoordinatorBoard } from "../src/boards/coordinator.ts";
import { buildRosterBoard } from "../src/boards/roster.ts";
import { type CastProposalRecord, readProposal, writeProposal } from "../src/cast.ts";
import { type CoordinatorLedger, loadLedger, saveLedger } from "../src/coordinator.ts";
import { type MemberRecord, readMembers, scaffoldMember } from "../src/member-store.ts";
import { scopeMembersDir } from "../src/paths.ts";
import { readSelectedProject, writeSelectedProject } from "../src/scope.ts";

const ROSTER = fileURLToPath(new URL("../bin/collect-roster.ts", import.meta.url));
const CAST = fileURLToPath(new URL("../bin/collect-cast.ts", import.meta.url));
const COORDINATOR = fileURLToPath(new URL("../bin/collect-coordinator.ts", import.meta.url));

async function runCollector(path: string, home: string): Promise<unknown> {
  const proc = Bun.spawn(["bun", path, home], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`collector exited ${code}: ${await new Response(proc.stderr).text()}`);
  }
  return JSON.parse(out);
}

const memberRecord = (over: Partial<MemberRecord> = {}): MemberRecord => ({
  slug: "scout",
  name: "Scout",
  role: "Researcher",
  charter: "# Scout\n\nDigs up facts.",
  status: "active",
  createdAt: "2026-06-06T00:00:00.000Z",
  ...over,
});

const proposalRecord = (): CastProposalRecord => ({
  projectId: "p1",
  projectName: "Demo",
  rootPath: "/repo",
  members: [{ name: "Ana", role: "Engineer", charter: "# Ana\n\nBuilds." }],
  notes: [],
  createdAt: "2026-06-06T00:00:00.000Z",
});

const ledgerRecord = (): CoordinatorLedger => ({
  task: "ship it",
  facts: ["a"],
  plan: ["step one"],
  round: 2,
  stallCount: 0,
  resetCount: 0,
  status: "active",
  transcript: [{ round: 0, kind: "coordinator", text: "hi" }],
  createdAt: "2026-06-06T00:00:00.000Z",
  updatedAt: "2026-06-06T00:00:00.000Z",
});

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "squad-collectors-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("collector back-compat (no selected-project.json)", () => {
  test("roster collector reads the legacy tree and emits today's board", async () => {
    await scaffoldMember(join(home, "members"), memberRecord());
    const members = await readMembers(join(home, "members"));
    const expected = buildRosterBoard(members);

    expect(await readSelectedProject(home)).toBeUndefined();
    expect(await runCollector(ROSTER, home)).toEqual(JSON.parse(JSON.stringify(expected)));
  });

  test("cast collector reads the legacy proposal and emits today's board", async () => {
    await writeProposal(home, proposalRecord());
    const expected = buildCastBoard(await readProposal(home));

    expect(await readSelectedProject(home)).toBeUndefined();
    expect(await runCollector(CAST, home)).toEqual(JSON.parse(JSON.stringify(expected)));
  });

  test("coordinator collector reads the legacy ledger and emits today's board", async () => {
    await saveLedger(home, ledgerRecord());
    const expected = buildCoordinatorBoard(await loadLedger(home));

    expect(await readSelectedProject(home)).toBeUndefined();
    expect(await runCollector(COORDINATOR, home)).toEqual(JSON.parse(JSON.stringify(expected)));
  });
});

describe("collector follows the persisted selection", () => {
  test("roster collector reads the selected scope's tree, not the legacy one", async () => {
    // Legacy tree carries one member; the selected scope carries a different one.
    await scaffoldMember(join(home, "members"), memberRecord({ slug: "scout", name: "Scout" }));
    await scaffoldMember(
      scopeMembersDir(home, "alpha"),
      memberRecord({ slug: "ana", name: "Ana" }),
    );
    await writeSelectedProject(home, { scopeId: "alpha", at: "2026-06-06T00:00:00.000Z" });

    const scoped = await readMembers(scopeMembersDir(home, "alpha"));
    const expected = buildRosterBoard(scoped);
    expect(await runCollector(ROSTER, home)).toEqual(JSON.parse(JSON.stringify(expected)));
  });
});
