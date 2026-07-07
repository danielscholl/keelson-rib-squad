#!/usr/bin/env bun
import { buildCoordinatorBoard } from "../src/boards/coordinator.ts";
/**
 * Coordinator collector — the producer behind the `squad-coordinator` workflow. Reads the
 * persisted coordinator-ledger.json under the data home and prints a canvas board-view JSON
 * object (the Run-loop board: goal, plan, findings, abandoned steps, recent activity), and
 * nothing else, to stdout. Degrades to the calm idle board: a missing/unreadable/invalid ledger
 * yields the "idle" board, never a throw.
 */
import { loadLedger } from "../src/coordinator.ts";
import { readMembers } from "../src/member-store.ts";
import { scopeDataHome, scopeMembersDir, squadDataHome } from "../src/paths.ts";
import { readSelectedProject, selectedScopeId } from "../src/scope.ts";
import { identityTonesByMember } from "../src/types.ts";

async function main() {
  // The squad-coordinator bash node bakes the resolved data home in as argv[2] (the same path
  // the in-process rib captured), so this out-of-process collector reads the ledger from it
  // without resolving the home itself. Fall back to squadDataHome() for a manual/standalone run.
  const home = process.argv[2]?.trim() || squadDataHome();
  const scopeId = selectedScopeId(await readSelectedProject(home).catch(() => undefined));
  const ledger = await loadLedger(scopeDataHome(home, scopeId)).catch(() => undefined);
  const members = await readMembers(scopeMembersDir(home, scopeId)).catch(() => []);
  process.stdout.write(
    JSON.stringify(
      buildCoordinatorBoard(ledger, identityTonesByMember(members), scopeId, members.length > 0),
    ),
  );
}

await main();
