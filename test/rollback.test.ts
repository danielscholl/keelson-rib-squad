import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RibContext, RibExec, ToolDefinition } from "@keelson/shared";
import type { CoordinatorLedger } from "../src/coordinator.ts";
import rib from "../src/index.ts";
import { scopeDataHome, setSquadDataHome } from "../src/paths.ts";
import { computeRollbackPlan, type RollbackGitExec } from "../src/rollback.ts";
import { readRollbackRows } from "../src/rollback-store.ts";
import { archiveRun } from "../src/runs-store.ts";
import { writeSelectedProject } from "../src/scope.ts";

interface Call {
  kind: "git" | "exists";
  value: string;
}

type RunTextResult = Awaited<ReturnType<RibExec["runText"]>>;

interface RunTextCall {
  cmd: string;
  args: string[];
}

let home: string;
let root: string;

function ledger(overrides: Partial<CoordinatorLedger> = {}): CoordinatorLedger {
  return {
    task: "rollback me",
    facts: [],
    plan: [],
    round: 1,
    stallCount: 0,
    resetCount: 0,
    status: "aborted",
    transcript: [],
    createdAt: "2026-07-05T00:00:00.000Z",
    updatedAt: "2026-07-05T00:00:00.000Z",
    baselineTree: "base-tree",
    baselineHeadSha: "base-head",
    ...overrides,
  };
}

function project(id: string, name: string, rootPath: string) {
  return { id, name, rootPath, createdAt: "2026-07-05T00:00:00.000Z" };
}

function ok(data = ""): RunTextResult {
  return { ok: true, data, exitCode: 0 };
}

function fail(error: string): RunTextResult {
  return { ok: false, error, code: 1 };
}

function fakeExec(
  opts: {
    outputs?: Record<string, string>;
    failures?: Set<string>;
    existingPaths?: Set<string>;
  } = {},
): { exec: RollbackGitExec; calls: Call[] } {
  const outputs = opts.outputs ?? {};
  const failures = opts.failures ?? new Set<string>();
  const existingPaths = opts.existingPaths ?? new Set<string>();
  const calls: Call[] = [];
  return {
    calls,
    exec: {
      runGit: async (args) => {
        const key = args.join(" ");
        calls.push({ kind: "git", value: key });
        if (failures.has(key)) return { ok: false, error: `failed ${key}` };
        return { ok: true, data: outputs[key] ?? "" };
      },
      pathExists: async (path) => {
        calls.push({ kind: "exists", value: path });
        return existingPaths.has(path);
      },
    },
  };
}

function makeRibExec(
  handler: (cmd: string, args: readonly string[]) => RunTextResult | Promise<RunTextResult>,
): { exec: RibExec; calls: RunTextCall[] } {
  const calls: RunTextCall[] = [];
  return {
    calls,
    exec: {
      runJSON: async () => ({ ok: false as const, error: "unused", code: null }),
      runText: async (cmd, args) => {
        calls.push({ cmd, args: [...args] });
        return handler(cmd, args);
      },
    },
  };
}

function bootTools(exec: RibExec): readonly ToolDefinition[] {
  const ctx = {
    getDataDir: () => home,
    getExec: () => exec,
    getProjects: () => [project("alpha", "alpha", root)],
  } as unknown as RibContext;
  return rib.registerTools?.(ctx) ?? [];
}

function rollbackTool(exec: RibExec): ToolDefinition {
  const tool = bootTools(exec).find((t) => t.name === "squad_rollback");
  if (!tool) throw new Error("squad_rollback was not registered");
  return tool;
}

async function invoke(
  tool: ToolDefinition,
  input: unknown,
): Promise<{ content?: string; isError?: boolean }> {
  const chunks: { content?: string; isError?: boolean }[] = [];
  await tool.execute(input, {
    emit: (chunk: { content?: string; isError?: boolean }) => chunks.push(chunk),
  } as never);
  return chunks[0] ?? {};
}

function rollbackGitHandler(cmd: string, args: readonly string[]): RunTextResult {
  if (cmd !== "git") return fail(`unexpected command: ${cmd}`);
  const key = args.join(" ");
  const outputs: Record<string, string> = {
    "rev-parse HEAD": "head-after\n",
    "rev-parse HEAD^{tree}": "tree-after\n",
    "rev-parse -q --verify MERGE_HEAD": "",
    "rev-parse --git-path rebase-merge": ".git/rebase-merge\n",
    "rev-parse --git-path rebase-apply": ".git/rebase-apply\n",
    "rev-list --reverse base-head..HEAD": "commit-a\n",
    "log -n 1 --format=%h%x00%s commit-a": "aaaa111\u0000ship rollback target\n",
    "diff-tree -r -z --diff-filter=DMRT --name-only base-tree tree-after": "src/changed.ts\u0000",
    "diff-tree -r -z --diff-filter=A --name-only base-tree tree-after":
      "generated.txt\u0000nested/new.txt\u0000",
    "diff --binary --full-index HEAD": "diff --git a/src/changed.ts b/src/changed.ts\n",
    "reset --soft base-head": "",
    "read-tree base-tree": "",
    "checkout-index -a -f": "",
  };
  if (key === "merge-base --is-ancestor base-head HEAD") return ok("");
  return key in outputs ? ok(outputs[key]) : fail(`unexpected git command: ${key}`);
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "squad-rollback-home-"));
  root = await mkdtemp(join(tmpdir(), "squad-rollback-root-"));
  await writeSelectedProject(home, {
    scopeId: "alpha",
    projectId: "alpha",
    name: "alpha",
    rootPath: root,
    at: "2026-07-05T00:00:00.000Z",
  });
});

afterEach(async () => {
  rib.dispose?.();
  setSquadDataHome(undefined);
  await rm(home, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
});

describe("computeRollbackPlan", () => {
  test("computes a performed manifest without mutating git state", async () => {
    const { exec, calls } = fakeExec({
      outputs: {
        "rev-parse HEAD": "head-after\n",
        "rev-parse HEAD^{tree}": "tree-after\n",
        "rev-parse -q --verify MERGE_HEAD": "",
        "rev-parse --git-path rebase-merge": ".git/rebase-merge\n",
        "rev-parse --git-path rebase-apply": ".git/rebase-apply\n",
        "rev-list --reverse base-head..HEAD": "commit-a\ncommit-b\n",
        "log -n 1 --format=%h%x00%s commit-a": "aaaa111\u0000first change\n",
        "log -n 1 --format=%h%x00%s commit-b": "bbbb222\u0000second change\n",
        "diff-tree -r -z --diff-filter=DMRT --name-only base-tree tree-after":
          "src/changed.ts\u0000src/deleted.ts\u0000",
        "diff-tree -r -z --diff-filter=A --name-only base-tree tree-after": "src/new.ts\u0000",
      },
    });

    const plan = await computeRollbackPlan(ledger(), exec);

    expect(plan).toEqual({
      type: "performed",
      manifest: {
        preRollbackTree: "tree-after",
        preRollbackHead: "head-after",
        rollbackRef: "base-head",
        baselineTree: "base-tree",
        baselineHeadSha: "base-head",
        revertedCommits: [
          { sha: "aaaa111", subject: "first change" },
          { sha: "bbbb222", subject: "second change" },
        ],
        revertedPaths: ["src/changed.ts", "src/deleted.ts"],
        deletedPaths: ["src/new.ts"],
      },
    });
    expect(calls.map((call) => `${call.kind}:${call.value}`)).toEqual([
      "git:rev-parse HEAD",
      "git:rev-parse HEAD^{tree}",
      "git:merge-base --is-ancestor base-head HEAD",
      "git:rev-parse -q --verify MERGE_HEAD",
      "git:rev-parse --git-path rebase-merge",
      "exists:.git/rebase-merge",
      "git:rev-parse --git-path rebase-apply",
      "exists:.git/rebase-apply",
      "git:rev-list --reverse base-head..HEAD",
      "git:log -n 1 --format=%h%x00%s commit-a",
      "git:log -n 1 --format=%h%x00%s commit-b",
      "git:diff-tree -r -z --diff-filter=DMRT --name-only base-tree tree-after",
      "git:diff-tree -r -z --diff-filter=A --name-only base-tree tree-after",
    ]);
  });

  test("refuses when baseline head is not an ancestor of HEAD", async () => {
    const { exec } = fakeExec({
      outputs: {
        "rev-parse HEAD": "observed\n",
        "rev-parse HEAD^{tree}": "tree\n",
      },
      failures: new Set(["merge-base --is-ancestor base-head HEAD"]),
    });

    await expect(computeRollbackPlan(ledger(), exec)).resolves.toEqual({
      type: "refused",
      reason: "head-rewritten",
      observedHead: "observed",
    });
  });

  test("refuses during an in-progress merge or rebase", async () => {
    const { exec } = fakeExec({
      outputs: {
        "rev-parse HEAD": "observed\n",
        "rev-parse HEAD^{tree}": "tree\n",
        "rev-parse -q --verify MERGE_HEAD": "merge-head\n",
      },
    });

    await expect(computeRollbackPlan(ledger(), exec)).resolves.toEqual({
      type: "refused",
      reason: "merge-in-progress",
      observedHead: "observed",
    });
  });

  describe("squad_rollback tool", () => {
    test("registers as a confirmed state-changing tool and previews without mutation", async () => {
      await archiveRun(scopeDataHome(home, "alpha"), ledger());
      const { exec, calls } = makeRibExec(rollbackGitHandler);
      const tool = rollbackTool(exec);

      const res = await invoke(tool, { project: "alpha" });

      expect(tool.state_changing).toBe(true);
      expect(tool.requires_confirmation).toBe(true);
      expect(res.isError).toBeUndefined();
      expect(res.content).toContain('"runId": "2026-07-05T00-00-00-000Z"');
      expect(res.content).toContain('"C"');
      expect(res.content).toContain('"M"');
      expect(res.content).toContain('"D"');
      expect(calls.map((call) => call.args.join(" "))).not.toContain("reset --soft base-head");
      expect(
        await readRollbackRows(scopeDataHome(home, "alpha"), "2026-07-05T00-00-00-000Z"),
      ).toEqual([]);
    });

    test("confirm performs the ordered rollback sequence and appends the event last", async () => {
      await archiveRun(scopeDataHome(home, "alpha"), ledger());
      await mkdir(join(root, "nested"), { recursive: true });
      await writeFile(join(root, "generated.txt"), "delete me");
      await writeFile(join(root, "nested", "new.txt"), "delete me");
      const { exec, calls } = makeRibExec(rollbackGitHandler);

      const res = await invoke(rollbackTool(exec), { project: "alpha", confirm: true });

      expect(res.isError).toBeUndefined();
      expect(res.content).toContain('"event": "performed"');
      expect(calls.map((call) => call.args.join(" ")).slice(-5)).toEqual([
        "diff --binary --full-index HEAD",
        "reset --soft base-head",
        "diff-tree -r -z --diff-filter=A --name-only base-tree tree-after",
        "read-tree base-tree",
        "checkout-index -a -f",
      ]);
      const rows = await readRollbackRows(scopeDataHome(home, "alpha"), "2026-07-05T00-00-00-000Z");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.type).toBe("performed");
    });
  });

  test("refuses non-aborted and non-failed run states", async () => {
    const { exec, calls } = fakeExec({
      outputs: {
        "rev-parse HEAD": "observed\n",
        "rev-parse HEAD^{tree}": "tree\n",
      },
    });

    await expect(computeRollbackPlan(ledger({ status: "done" }), exec)).resolves.toEqual({
      type: "refused",
      reason: "run-not-rollbackable",
      observedHead: "observed",
    });
    expect(calls.map((call) => `${call.kind}:${call.value}`)).toEqual([
      "git:rev-parse HEAD",
      "git:rev-parse HEAD^{tree}",
    ]);
  });

  test("returns noop when there are no commits or path deltas", async () => {
    const { exec } = fakeExec({
      outputs: {
        "rev-parse HEAD": "base-head\n",
        "rev-parse HEAD^{tree}": "base-tree\n",
        "rev-parse -q --verify MERGE_HEAD": "",
        "rev-parse --git-path rebase-merge": ".git/rebase-merge\n",
        "rev-parse --git-path rebase-apply": ".git/rebase-apply\n",
        "rev-list --reverse base-head..HEAD": "",
        "diff-tree -r -z --diff-filter=DMRT --name-only base-tree base-tree": "",
        "diff-tree -r -z --diff-filter=A --name-only base-tree base-tree": "",
      },
    });

    await expect(computeRollbackPlan(ledger(), exec)).resolves.toEqual({
      type: "noop",
      preRollbackHead: "base-head",
      preRollbackTree: "base-tree",
    });
  });
});
