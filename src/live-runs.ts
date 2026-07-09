import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { LEDGER_STATUS_ACTIVE, loadLedger } from "./coordinator.ts";
import { DEFAULT_SCOPE_ID, scopeDataHome } from "./paths.ts";
import { readProjectsSnapshot } from "./scope.ts";

export interface LiveRunElsewhere {
  scopeId: string;
  name?: string;
  task: string;
  round: number;
}

interface ScopeRoot {
  root: string;
  scopeId: string;
}

export async function listLiveRunsElsewhere(
  home: string,
  selectedScope: string,
): Promise<LiveRunElsewhere[]> {
  try {
    const projectNames = new Map((await readProjectsSnapshot(home)).map((p) => [p.id, p.name]));
    const runs: LiveRunElsewhere[] = [];

    for (const candidate of await listScopeRoots(home)) {
      const ledger = await loadLedger(candidate.root).catch(() => undefined);
      if (!ledger || ledger.status !== LEDGER_STATUS_ACTIVE) continue;

      const scopeId = ledger.scopeId ?? candidate.scopeId;
      if (!scopeId || scopeId === selectedScope) continue;

      const name = projectNames.get(scopeId) ?? maybeProjectName(projectNames, ledger.projectId);
      runs.push({
        scopeId,
        ...(name ? { name } : {}),
        task: ledger.task,
        round: ledger.round,
      });
    }

    return runs.sort((a, b) => a.scopeId.localeCompare(b.scopeId));
  } catch {
    return [];
  }
}

async function listScopeRoots(home: string): Promise<ScopeRoot[]> {
  const roots: ScopeRoot[] = [
    { root: scopeDataHome(home, DEFAULT_SCOPE_ID), scopeId: DEFAULT_SCOPE_ID },
  ];

  try {
    const segments = (await readdir(join(home, "projects"), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const seg of segments) roots.push({ root: join(home, "projects", seg), scopeId: seg });
  } catch {
    // no projects/ tree yet -- just the default scope
  }

  return roots;
}

function maybeProjectName(
  projectNames: ReadonlyMap<string, string>,
  projectId: string | undefined,
): string | undefined {
  return projectId ? projectNames.get(projectId) : undefined;
}
