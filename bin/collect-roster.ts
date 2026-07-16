#!/usr/bin/env bun
/**
 * Roster collector — the producer behind the `squad-roster` workflow. Reads the
 * authored members under the data home and prints a canvas board-view JSON object
 * (one card per member), and nothing else, to stdout. Degrades to a valid roster:
 * a missing members/ dir (nothing authored yet) or any read error yields an empty
 * board, never a throw.
 */
import { buildRosterBoard, type RosterProject } from "../src/boards/roster.ts";
import { readProposal } from "../src/cast.ts";
import { listLiveRunsElsewhere } from "../src/live-runs.ts";
import { readMembers } from "../src/member-store.ts";
import { scopeDataHome, scopeMembersDir, squadDataHome } from "../src/paths.ts";
import { readPendingGenesis } from "../src/pending-genesis.ts";
import {
  readProjectsSnapshot,
  readSelectedProject,
  type SelectedProject,
  selectedScopeId,
} from "../src/scope.ts";

// The selected project as the cold-start board renders it. The collector resolves it and
// the builder stays pure — the split the coordinator/runs collectors already use for the
// scopeId they rendered.
//
// Keyed on projectId, NEVER scopeId: DEFAULT_SCOPE_ID and DEFAULT_PROJECT_NAME are the
// same literal ("default") with different meanings, so a scopeId lookup could match a
// project whose id happens to be "default" and chip the sentinel as if it were a repo.
// projectId is present in every state where a project is genuinely selected; where it
// isn't, we honestly don't know, and the board says "this repo".
//
// Snapshot first, frozen name second: projects.json is rewritten on boot and on every
// action, while selection.name froze at select time — so after a rename the snapshot is
// right and the selection is stale. The frozen name covers a missing/unreadable snapshot.
//
// rootPath has no fallback at all — the snapshot carries only { id, name } — so a
// selection without one yields silence rather than a guess. Degrades, never throws.
async function resolveProject(
  home: string,
  selection: SelectedProject | undefined,
): Promise<RosterProject> {
  const snapshot = await readProjectsSnapshot(home).catch(() => []);
  const names = new Map(snapshot.map((p) => [p.id, p.name]));
  const name =
    (selection?.projectId ? names.get(selection.projectId) : undefined) ?? selection?.name;
  return {
    ...(name ? { name } : {}),
    ...(selection?.rootPath ? { rootPath: selection.rootPath } : {}),
  };
}

async function main() {
  // The squad-roster bash node bakes the resolved data home in as argv[2] (the
  // keelson-home-rooted path the in-process rib captured), so this out-of-process
  // collector derives the members dir from it without resolving the home itself.
  // Fall back to squadDataHome() for a manual/standalone run.
  const home = process.argv[2]?.trim() || squadDataHome();
  const selection = await readSelectedProject(home).catch(() => undefined);
  const scopeId = selectedScopeId(selection);
  const project = await resolveProject(home, selection);
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
    JSON.stringify(
      buildRosterBoard(members, pending, Date.now(), proposal, liveRunsElsewhere, project),
    ),
  );
}

await main();
