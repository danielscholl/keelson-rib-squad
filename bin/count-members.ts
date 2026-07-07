#!/usr/bin/env bun
/**
 * Member-count collector — the deterministic node ahead of the `squad-decisions`
 * render turn. Prints the selected scope's active-member count (a bare integer)
 * and nothing else to stdout, so the render prompt can apply the same
 * members-aware cold-start gating buildDecisionsBoard encodes. Degrades to "0":
 * a missing home, scope, or members dir never throws.
 */
import { readMembers } from "../src/member-store.ts";
import { scopeMembersDir, squadDataHome } from "../src/paths.ts";
import { readSelectedProject, selectedScopeId } from "../src/scope.ts";

async function main() {
  const home = process.argv[2]?.trim() || squadDataHome();
  const scopeId = selectedScopeId(await readSelectedProject(home).catch(() => undefined));
  const members = await readMembers(scopeMembersDir(home, scopeId)).catch(() => []);
  process.stdout.write(String(members.length));
}

await main();
