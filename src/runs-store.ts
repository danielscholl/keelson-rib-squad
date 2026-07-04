import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CoordinatorLedger } from "./coordinator.ts";

export type RunSummary = {
  id: string;
  task: string;
  scopeId?: string;
  status: string;
  round: number;
  createdAt: string;
  updatedAt: string;
};

function runsDir(scopeDataHome: string): string {
  return join(scopeDataHome, "runs");
}

function runId(createdAt: string): string {
  return createdAt.replaceAll(/[:.]/g, "-");
}

function runPath(scopeDataHome: string, id: string): string {
  return join(runsDir(scopeDataHome), `${id}.json`);
}

function asRunSummary(value: unknown): RunSummary | undefined {
  if (!value || typeof value !== "object") return undefined;
  const ledger = value as Partial<CoordinatorLedger>;
  if (
    typeof ledger.task !== "string" ||
    typeof ledger.status !== "string" ||
    typeof ledger.round !== "number" ||
    typeof ledger.createdAt !== "string" ||
    typeof ledger.updatedAt !== "string"
  ) {
    return undefined;
  }
  return {
    id: runId(ledger.createdAt),
    task: ledger.task,
    ...(ledger.scopeId ? { scopeId: ledger.scopeId } : {}),
    status: ledger.status,
    round: ledger.round,
    createdAt: ledger.createdAt,
    updatedAt: ledger.updatedAt,
  };
}

export async function archiveRun(scopeDataHome: string, ledger: CoordinatorLedger): Promise<void> {
  const dir = runsDir(scopeDataHome);
  await mkdir(dir, { recursive: true });
  const path = runPath(scopeDataHome, runId(ledger.createdAt));
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(ledger, null, 2)}\n`);
  await rename(tmp, path);
}

// Load one archived run by its id (the timestamp-derived file basename listRuns
// reports). Returns undefined for an unknown id, a torn file, or a shape that isn't
// a ledger — the caller renders "not found", never a throw. The guard covers every
// field the board builders dereference, so a hand-edited file can't crash a compose.
export async function loadRun(
  scopeDataHome: string,
  id: string,
): Promise<CoordinatorLedger | undefined> {
  // The id is a path segment; refuse anything that could escape the runs dir.
  if (!/^[A-Za-z0-9-]+$/.test(id)) return undefined;
  try {
    const raw = await readFile(runPath(scopeDataHome, id), "utf8");
    const parsed = JSON.parse(raw) as Partial<CoordinatorLedger>;
    if (
      typeof parsed.task !== "string" ||
      typeof parsed.status !== "string" ||
      typeof parsed.round !== "number" ||
      typeof parsed.stallCount !== "number" ||
      typeof parsed.resetCount !== "number" ||
      typeof parsed.createdAt !== "string" ||
      typeof parsed.updatedAt !== "string" ||
      !Array.isArray(parsed.transcript) ||
      !Array.isArray(parsed.facts) ||
      !Array.isArray(parsed.plan)
    ) {
      return undefined;
    }
    return parsed as CoordinatorLedger;
  } catch {
    return undefined;
  }
}

export async function listRuns(scopeDataHome: string): Promise<RunSummary[]> {
  let entries: string[];
  try {
    entries = await readdir(runsDir(scopeDataHome));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw e;
  }

  const runs: RunSummary[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const raw = await readFile(join(runsDir(scopeDataHome), entry), "utf8");
      const parsed = asRunSummary(JSON.parse(raw));
      if (!parsed) continue;
      runs.push(parsed);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || e instanceof SyntaxError) continue;
      throw e;
    }
  }

  runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return runs;
}
