import { describe, expect, test } from "bun:test";
import type { CoordinatorLedger } from "../src/coordinator.ts";
import { computeRollbackPlan, type RollbackGitExec } from "../src/rollback.ts";

interface Call {
  kind: "git" | "exists";
  value: string;
}

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
