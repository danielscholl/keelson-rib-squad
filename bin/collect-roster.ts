#!/usr/bin/env bun
/**
 * Roster collector — the producer behind the `squad-roster` workflow. Reads the
 * authored members under the data home and prints a canvas board-view JSON object
 * (one card per member), and nothing else, to stdout. Degrades to a valid roster:
 * a missing members/ dir (nothing authored yet) or any read error yields an empty
 * board, never a throw.
 */
import { buildRosterBoard } from "../src/boards/roster.ts";
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
  let members: Awaited<ReturnType<typeof readMembers>> = [];
  try {
    members = await readMembers(scopeMembersDir(home, scopeId));
  } catch {
    members = [];
  }
  // A genesis in flight (a scope-local marker) seats a boot card until the member lands
  // or the operator dismisses a stall; absent/unreadable degrades to no boot card.
  const pending = await readPendingGenesis(scopeDataHome(home, scopeId)).catch(() => null);
  process.stdout.write(JSON.stringify(buildRosterBoard(members, pending)));
}

await main();
