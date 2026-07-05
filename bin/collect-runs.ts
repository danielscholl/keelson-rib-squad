#!/usr/bin/env bun
/**
 * Runs collector — the producer behind the `squad-runs` workflow. Reads the
 * archived coordinator run ledgers under the selected scope and prints a canvas
 * board-view JSON object (one row per run, newest first), and nothing else, to
 * stdout. Degrades to a valid empty board: a missing runs/ dir (nothing archived
 * yet) or any read error yields an idle board, never a throw.
 */
import { buildRunsBoard } from "../src/boards/runs.ts";
import { scopeDataHome, squadDataHome } from "../src/paths.ts";
import { listRuns } from "../src/runs-store.ts";
import { readSelectedProject, selectedScopeId } from "../src/scope.ts";

async function main() {
  // The squad-runs bash node bakes the resolved data home in as argv[2], like the
  // roster collector; fall back to squadDataHome() for a manual/standalone run.
  const home = process.argv[2]?.trim() || squadDataHome();
  const scopeId = selectedScopeId(await readSelectedProject(home).catch(() => undefined));
  let runs: Awaited<ReturnType<typeof listRuns>> = [];
  try {
    runs = await listRuns(scopeDataHome(home, scopeId));
  } catch {
    runs = [];
  }
  process.stdout.write(JSON.stringify(buildRunsBoard(runs, scopeId)));
}

await main();
