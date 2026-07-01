import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CoordinatorLedger } from "./coordinator.ts";

export type RunSummary = {
  id: string;
  task: string;
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
