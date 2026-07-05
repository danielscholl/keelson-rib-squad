import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export type RollbackRefusalReason = "head-rewritten" | "merge-in-progress" | "run-not-rollbackable";

export interface RollbackCommit {
  sha: string;
  subject: string;
}

export interface RollbackPerformedRow {
  type: "performed";
  runId: string;
  at: string;
  preRollbackTree: string;
  preRollbackHead: string;
  rollbackRef: string;
  baselineTree: string;
  baselineHeadSha: string;
  revertedCommits: RollbackCommit[];
  revertedPaths: string[];
  deletedPaths: string[];
}

export interface RollbackRefusedRow {
  type: "refused";
  runId: string;
  at: string;
  reason: RollbackRefusalReason;
  observedHead: string;
}

export interface RollbackNoopRow {
  type: "noop";
  runId: string;
  at: string;
}

export type RollbackRow = RollbackPerformedRow | RollbackRefusedRow | RollbackNoopRow;

function rollbacksDir(scopeDataHome: string): string {
  return join(scopeDataHome, "rollbacks");
}

function rollbackPath(scopeDataHome: string, runId: string): string {
  return join(rollbacksDir(scopeDataHome), `${runId}.jsonl`);
}

function safeRunId(runId: string): boolean {
  return /^[A-Za-z0-9-]+$/.test(runId);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRollbackCommitArray(value: unknown): value is RollbackCommit[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        item &&
        typeof item === "object" &&
        typeof (item as Partial<RollbackCommit>).sha === "string" &&
        typeof (item as Partial<RollbackCommit>).subject === "string",
    )
  );
}

function asRollbackRow(value: unknown): RollbackRow | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Partial<RollbackRow>;
  if (typeof row.runId !== "string" || typeof row.at !== "string") return undefined;
  if (row.type === "noop") return row as RollbackNoopRow;
  if (row.type === "refused") {
    if (
      (row.reason === "head-rewritten" ||
        row.reason === "merge-in-progress" ||
        row.reason === "run-not-rollbackable") &&
      typeof row.observedHead === "string"
    ) {
      return row as RollbackRefusedRow;
    }
    return undefined;
  }
  if (row.type === "performed") {
    if (
      typeof row.preRollbackTree === "string" &&
      typeof row.preRollbackHead === "string" &&
      typeof row.rollbackRef === "string" &&
      typeof row.baselineTree === "string" &&
      typeof row.baselineHeadSha === "string" &&
      isRollbackCommitArray(row.revertedCommits) &&
      isStringArray(row.revertedPaths) &&
      isStringArray(row.deletedPaths)
    ) {
      return row as RollbackPerformedRow;
    }
  }
  return undefined;
}

export async function appendRollbackRow(scopeDataHome: string, row: RollbackRow): Promise<void> {
  if (!safeRunId(row.runId)) throw new Error(`unsafe rollback run id: ${row.runId}`);
  await mkdir(rollbacksDir(scopeDataHome), { recursive: true });
  await appendFile(rollbackPath(scopeDataHome, row.runId), `${JSON.stringify(row)}\n`);
}

export async function readRollbackRows(
  scopeDataHome: string,
  runId: string,
): Promise<RollbackRow[]> {
  if (!safeRunId(runId)) return [];
  try {
    const raw = await readFile(rollbackPath(scopeDataHome, runId), "utf8");
    const rows: RollbackRow[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = asRollbackRow(JSON.parse(line));
        if (row?.runId === runId) rows.push(row);
      } catch (e) {
        if (e instanceof SyntaxError) continue;
        throw e;
      }
    }
    return rows;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw e;
  }
}

export async function listRollbackRows(scopeDataHome: string): Promise<RollbackRow[]> {
  let entries: string[];
  try {
    entries = await readdir(rollbacksDir(scopeDataHome));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw e;
  }
  const rows: RollbackRow[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue;
    rows.push(...(await readRollbackRows(scopeDataHome, entry.slice(0, -".jsonl".length))));
  }
  rows.sort((a, b) => b.at.localeCompare(a.at));
  return rows;
}

export async function latestPerformedRollbackRow(
  scopeDataHome: string,
  runId: string,
): Promise<RollbackPerformedRow | undefined> {
  const rows = await readRollbackRows(scopeDataHome, runId);
  return rows
    .filter((row): row is RollbackPerformedRow => row.type === "performed")
    .sort((a, b) => b.at.localeCompare(a.at))[0];
}
