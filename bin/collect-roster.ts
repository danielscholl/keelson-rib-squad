#!/usr/bin/env bun
/**
 * Roster collector — the producer behind the `squad-roster` workflow. Reads the
 * authored members under the data home and prints a canvas board-view JSON object
 * (one card per member, led by the squad pulse stats), and nothing else, to
 * stdout. Degrades to a valid roster: a missing members/ dir (nothing authored
 * yet) or any read error yields an empty board with no pulse, never a throw.
 */
import { buildRosterBoard, type RosterPulse } from "../src/boards/roster.ts";
import { readMembers } from "../src/member-store.ts";
import { scopeMembersDir, squadDataHome } from "../src/paths.ts";
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
  // A simple pulse computed inline from the members list — omitted on an empty
  // roster so the cold-start board stays calm.
  const pulse: RosterPulse | undefined =
    members.length > 0
      ? {
          members: members.length,
          active: members.filter((m) => m.status === "active").length,
          inactive: members.filter((m) => m.status === "inactive").length,
        }
      : undefined;
  process.stdout.write(JSON.stringify(buildRosterBoard(members, pulse)));
}

await main();
