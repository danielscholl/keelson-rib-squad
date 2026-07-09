#!/usr/bin/env bun
/**
 * Roster collector — the producer behind the `squad-roster` workflow. Reads the
 * authored members under the data home and prints a canvas board-view JSON object
 * (one card per member), and nothing else, to stdout. Degrades to a valid roster:
 * a missing members/ dir (nothing authored yet) or any read error yields an empty
 * board, never a throw.
 */
import { buildRosterBoard } from "../src/boards/roster.ts";
import { readProposal } from "../src/cast.ts";
import { listLiveRunsElsewhere } from "../src/live-runs.ts";
import { readMembers } from "../src/member-store.ts";
import { scopeDataHome, scopeMembersDir, squadDataHome } from "../src/paths.ts";
import { readPendingGenesis } from "../src/pending-genesis.ts";
import { readSelectedProject, selectedScopeId } from "../src/scope.ts";

async function main() {
  // The squad-roster bash node bakes the resolved data home in as argv[2] (the
  // keelson-home-rooted path the in-process rib captured), so this out-of-process
  // collector derives the members dir from it without resolving the home itself.
  // Fall back to squadDataHome() for a manual/standalone run.
  const home = process.argv[2]?.trim() || squadDataHome();
  const scopeId = selectedScopeId(await readSelectedProject(home).catch(() => undefined));
  const liveRunsElsewhere = await listLiveRunsElsewhere(home, scopeId).catch(() => []);
  let members: Awaited<ReturnType<typeof readMembers>> = [];
  try {
    members = await readMembers(scopeMembersDir(home, scopeId));
  } catch {
    members = [];
  }
  // A genesis in flight (a scope-local marker) seats a boot card until the member lands
  // or the operator dismisses a stall; absent/unreadable degrades to no boot card. A
  // pending cast proposal hands the moment to the Proposed-squad panel (no launchpad).
  const scopedHome = scopeDataHome(home, scopeId);
  const pending = await readPendingGenesis(scopedHome).catch(() => null);
  const proposal = await readProposal(scopedHome).catch(() => undefined);
  process.stdout.write(
    JSON.stringify(buildRosterBoard(members, pending, Date.now(), proposal, liveRunsElsewhere)),
  );
}

await main();
