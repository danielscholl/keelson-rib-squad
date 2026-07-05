import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RibContext, RibExec, ToolDefinition } from "@keelson/shared";
import type { CoordinatorLedger } from "../src/coordinator.ts";
import rib from "../src/index.ts";
import { scopeDataHome, setSquadDataHome } from "../src/paths.ts";
import { computeRollbackPlan, type RollbackGitExec } from "../src/rollback.ts";
import { appendRollbackRow, readRollbackRows } from "../src/rollback-store.ts";
import { archiveRun, loadRun } from "../src/runs-store.ts";
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

const runId = "2026-07-05T00-00-00-000Z";
const rollbackRef = `refs/keelson/rollback/${runId}`;

function gitCalls(calls: readonly RunTextCall[]): string[] {
  return calls.filter((call) => call.cmd === "git").map((call) => call.args.join(" "));
}

function mutatingGitCalls(calls: readonly RunTextCall[]): string[] {
  return gitCalls(calls).filter((key) =>
    ["commit-tree", "update-ref", "reset", "read-tree", "checkout-index", "clean"].some((prefix) =>
      key.startsWith(prefix),
    ),
  );
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
    [`rev-parse --verify ${rollbackRef}`]: "",
    "rev-parse HEAD": "head-after\n",
    "write-tree": "index-tree-after\n",
    "rev-parse -q --verify MERGE_HEAD": "",
    "rev-parse --git-path rebase-merge": ".git/rebase-merge\n",
    "rev-parse --git-path rebase-apply": ".git/rebase-apply\n",
    "rev-list --reverse base-head..HEAD": "commit-a\n",
    "log -n 1 --format=%h%x00%s commit-a": "aaaa111\u0000ship rollback target\n",
    "diff-tree -r -z --diff-filter=DMRT --name-only base-tree index-tree-after":
      "src/changed.ts\u0000",
    "diff-tree -r -z --diff-filter=A --name-only base-tree index-tree-after":
      "generated.txt\u0000nested/new.txt\u0000",
    [`commit-tree index-tree-after -p head-after -m keelson rollback forensic capture ${runId}`]:
      "rollback-commit\n",
    [`update-ref ${rollbackRef} rollback-commit`]: "",
    "reset --soft base-head": "",
    "read-tree base-tree": "",
    "checkout-index -a -f": "",
  };
  if (key === `rev-parse --verify ${rollbackRef}`) return fail("missing ref");
  if (key === "merge-base --is-ancestor base-head HEAD") return ok("");
  return key in outputs ? ok(outputs[key]) : fail(`unexpected git command: ${key}`);
}

function statefulRollbackExec(
  opts: {
    deletedPaths?: string[];
    crashAfter?: string;
    mergeHead?: string;
    failAncestor?: boolean;
  } = {},
): {
  exec: RibExec;
  calls: RunTextCall[];
  state: { head: string; indexTree: string; worktreeTree: string; rollbackRef?: string };
} {
  const deletedPaths = opts.deletedPaths ?? ["generated.txt", "nested/new.txt"];
  const state = {
    head: "head-after",
    indexTree: "index-tree-after",
    worktreeTree: "index-tree-after",
    rollbackRef: undefined as string | undefined,
  };
  let refTree = "";
  let refParent = "";
  let pendingTree = "";
  let pendingParent = "";
  let crashed = false;
  const { exec, calls } = makeRibExec((cmd, args) => {
    if (cmd !== "git") return fail(`unexpected command: ${cmd}`);
    const key = args.join(" ");
    const crash = () => {
      if (!crashed && opts.crashAfter === key) {
        crashed = true;
        throw new Error(`crash after ${key}`);
      }
    };
    if (key === `rev-parse --verify ${rollbackRef}`) {
      return state.rollbackRef ? ok(`${state.rollbackRef}\n`) : fail("missing ref");
    }
    if (key === `rev-parse ${rollbackRef}^{tree}`) return ok(`${refTree}\n`);
    if (key === `rev-parse ${rollbackRef}^`) return ok(`${refParent}\n`);
    if (key === "rev-parse HEAD") return ok(`${state.head}\n`);
    if (key === "merge-base --is-ancestor base-head HEAD") {
      return opts.failAncestor ? fail("not ancestor") : ok("");
    }
    if (key === "rev-parse -q --verify MERGE_HEAD") return ok(opts.mergeHead ?? "");
    if (key === "rev-parse --git-path rebase-merge") return ok(".git/rebase-merge\n");
    if (key === "rev-parse --git-path rebase-apply") return ok(".git/rebase-apply\n");
    if (key === "rev-list --reverse base-head..HEAD") {
      return ok(state.head === "base-head" ? "" : "commit-a\n");
    }
    if (key === "rev-list --reverse base-head..head-after") return ok("commit-a\n");
    if (key === "log -n 1 --format=%h%x00%s commit-a") {
      return ok("aaaa111\u0000ship rollback target\n");
    }
    if (key === "diff-tree -r -z --diff-filter=DMRT --name-only base-tree index-tree-after") {
      return ok("src/changed.ts\u0000src/deleted.ts\u0000");
    }
    if (key === "diff-tree -r -z --diff-filter=A --name-only base-tree index-tree-after") {
      return ok(`${deletedPaths.join("\0")}\0`);
    }
    if (key === "diff-tree -r -z --diff-filter=DMRT --name-only base-tree base-tree") return ok("");
    if (key === "diff-tree -r -z --diff-filter=A --name-only base-tree base-tree") return ok("");
    if (key === "write-tree") {
      crash();
      return ok(`${state.indexTree}\n`);
    }
    if (
      key ===
      `commit-tree ${state.indexTree} -p ${state.head} -m keelson rollback forensic capture ${runId}`
    ) {
      pendingTree = state.indexTree;
      pendingParent = state.head;
      crash();
      return ok("rollback-commit\n");
    }
    if (key === `update-ref ${rollbackRef} rollback-commit`) {
      state.rollbackRef = "rollback-commit";
      refTree = pendingTree;
      refParent = pendingParent;
      crash();
      return ok("");
    }
    if (key === "reset --soft base-head") {
      state.head = "base-head";
      crash();
      return ok("");
    }
    if (key === "read-tree base-tree") {
      state.indexTree = "base-tree";
      crash();
      return ok("");
    }
    if (key === "checkout-index -a -f") {
      state.worktreeTree = state.indexTree;
      crash();
      return ok("");
    }
    return fail(`unexpected git command: ${key}`);
  });
  return { exec, calls, state };
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
        "write-tree": "index-tree-after\n",
        "rev-parse -q --verify MERGE_HEAD": "",
        "rev-parse --git-path rebase-merge": ".git/rebase-merge\n",
        "rev-parse --git-path rebase-apply": ".git/rebase-apply\n",
        "rev-list --reverse base-head..HEAD": "commit-a\ncommit-b\n",
        "log -n 1 --format=%h%x00%s commit-a": "aaaa111\u0000first change\n",
        "log -n 1 --format=%h%x00%s commit-b": "bbbb222\u0000second change\n",
        "diff-tree -r -z --diff-filter=DMRT --name-only base-tree index-tree-after":
          "src/changed.ts\u0000src/deleted.ts\u0000",
        "diff-tree -r -z --diff-filter=A --name-only base-tree index-tree-after":
          "src/new.ts\u0000",
      },
    });

    const plan = await computeRollbackPlan(ledger(), exec, rollbackRef);

    expect(plan).toEqual({
      type: "performed",
      manifest: {
        preRollbackTree: "index-tree-after",
        preRollbackHead: "head-after",
        rollbackRef,
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
      "git:write-tree",
      "git:merge-base --is-ancestor base-head HEAD",
      "git:rev-parse -q --verify MERGE_HEAD",
      "git:rev-parse --git-path rebase-merge",
      "exists:.git/rebase-merge",
      "git:rev-parse --git-path rebase-apply",
      "exists:.git/rebase-apply",
      "git:rev-list --reverse base-head..HEAD",
      "git:log -n 1 --format=%h%x00%s commit-a",
      "git:log -n 1 --format=%h%x00%s commit-b",
      "git:diff-tree -r -z --diff-filter=DMRT --name-only base-tree index-tree-after",
      "git:diff-tree -r -z --diff-filter=A --name-only base-tree index-tree-after",
    ]);
  });

  test("refuses when baseline head is not an ancestor of HEAD", async () => {
    const { exec } = fakeExec({
      outputs: {
        "rev-parse HEAD": "observed\n",
        "write-tree": "tree\n",
      },
      failures: new Set(["merge-base --is-ancestor base-head HEAD"]),
    });

    await expect(computeRollbackPlan(ledger(), exec, rollbackRef)).resolves.toEqual({
      type: "refused",
      reason: "head-rewritten",
      observedHead: "observed",
    });
  });

  test("refuses during an in-progress merge or rebase", async () => {
    const { exec } = fakeExec({
      outputs: {
        "rev-parse HEAD": "observed\n",
        "write-tree": "tree\n",
        "rev-parse -q --verify MERGE_HEAD": "merge-head\n",
      },
    });

    await expect(computeRollbackPlan(ledger(), exec, rollbackRef)).resolves.toEqual({
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
      const before = await loadRun(scopeDataHome(home, "alpha"), runId);

      const res = await invoke(tool, { project: "alpha" });

      expect(tool.state_changing).toBe(true);
      expect(tool.requires_confirmation).toBe(true);
      expect(res.isError).toBeUndefined();
      const payload = JSON.parse(res.content ?? "");
      expect(payload).toEqual({
        tool: "squad_rollback",
        project: "alpha",
        scopeId: "alpha",
        runId,
        confirmRequired: true,
        manifest: {
          status: "performed",
          preRollbackHead: "head-after",
          preRollbackTree: "index-tree-after",
          rollbackRef,
          baselineTree: "base-tree",
          C: [{ sha: "aaaa111", subject: "ship rollback target" }],
          M: ["src/changed.ts"],
          D: ["generated.txt", "nested/new.txt"],
        },
      });
      expect(mutatingGitCalls(calls)).toEqual([]);
      expect(await readRollbackRows(scopeDataHome(home, "alpha"), runId)).toEqual([]);
      expect(await loadRun(scopeDataHome(home, "alpha"), runId)).toEqual(before);
    });

    test("confirm performs the ordered rollback sequence and appends the event last", async () => {
      await archiveRun(scopeDataHome(home, "alpha"), ledger());
      await mkdir(join(root, "nested"), { recursive: true });
      await writeFile(join(root, "generated.txt"), "delete me");
      await writeFile(join(root, "nested", "new.txt"), "delete me");
      const before = await loadRun(scopeDataHome(home, "alpha"), runId);
      const { exec, calls } = makeRibExec(async (cmd, args) => {
        if (cmd === "git" && args.join(" ") === "checkout-index -a -f") {
          expect(await readFile(join(root, "generated.txt"), "utf8")).toBe("delete me");
        }
        return rollbackGitHandler(cmd, args);
      });

      const res = await invoke(rollbackTool(exec), { project: "alpha", run: runId, confirm: true });

      expect(res.isError).toBeUndefined();
      expect(res.content).toContain('"event": "performed"');
      const keys = gitCalls(calls);
      expect(keys).not.toContain("clean -fd");
      expect(keys).not.toContain("rev-parse HEAD^{tree}");
      expect(keys.indexOf("write-tree")).toBeLessThan(
        keys.findIndex((key) => key.startsWith("commit-tree")),
      );
      expect(keys.slice(-5)).toEqual([
        `commit-tree index-tree-after -p head-after -m keelson rollback forensic capture ${runId}`,
        `update-ref ${rollbackRef} rollback-commit`,
        "reset --soft base-head",
        "read-tree base-tree",
        "checkout-index -a -f",
      ]);
      expect(keys.indexOf("reset --soft base-head")).toBeLessThan(
        keys.indexOf("read-tree base-tree"),
      );
      expect(keys.indexOf("reset --soft base-head")).toBeLessThan(
        keys.indexOf("checkout-index -a -f"),
      );
      const rows = await readRollbackRows(scopeDataHome(home, "alpha"), "2026-07-05T00-00-00-000Z");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.type).toBe("performed");
      expect(rows[0]).toMatchObject({ rollbackRef, preRollbackTree: "index-tree-after" });
      await expect(readFile(join(root, "generated.txt"), "utf8")).rejects.toThrow();
      await expect(readFile(join(root, "nested", "new.txt"), "utf8")).rejects.toThrow();
      expect(await loadRun(scopeDataHome(home, "alpha"), runId)).toEqual(before);
    });

    test("delete set includes only run-added paths absent from the baseline tree", async () => {
      await archiveRun(scopeDataHome(home, "alpha"), ledger());
      const { exec } = statefulRollbackExec({
        deletedPaths: ["run-added.txt", "nested/run-added.txt"],
      });

      const res = await invoke(rollbackTool(exec), { project: "alpha" });

      const payload = JSON.parse(res.content ?? "");
      expect(payload.manifest.D).toEqual(["nested/run-added.txt", "run-added.txt"]);
      expect(payload.manifest.D).not.toContain("pre-existing-untracked.txt");
    });

    test.each([
      {
        name: "non-ancestor HEAD",
        ledger: ledger(),
        execOpts: { failAncestor: true },
        reason: "head-rewritten",
      },
      {
        name: "merge in progress",
        ledger: ledger(),
        execOpts: { mergeHead: "merge-head\n" },
        reason: "merge-in-progress",
      },
      {
        name: "done run",
        ledger: ledger({ status: "done" }),
        execOpts: {},
        reason: "run-not-rollbackable",
      },
      {
        name: "live run",
        ledger: ledger({ status: "active" }),
        execOpts: {},
        reason: "run-not-rollbackable",
      },
    ])("confirms a refused event without mutation for $name", async ({
      ledger,
      execOpts,
      reason,
    }) => {
      await archiveRun(scopeDataHome(home, "alpha"), ledger);
      const before = await loadRun(scopeDataHome(home, "alpha"), runId);
      const { exec, calls } = statefulRollbackExec(execOpts);

      const res = await invoke(rollbackTool(exec), { project: "alpha", run: runId, confirm: true });

      expect(res.isError).toBe(true);
      expect(mutatingGitCalls(calls)).toEqual([]);
      const rows = await readRollbackRows(scopeDataHome(home, "alpha"), runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({
        type: "refused",
        runId,
        at: expect.any(String),
        reason,
        observedHead: "head-after",
      });
      expect("rollbackRef" in (rows[0] ?? {})).toBe(false);
      expect(await loadRun(scopeDataHome(home, "alpha"), runId)).toEqual(before);
    });

    test("fast-paths an existing performed row without commands or a new event", async () => {
      await archiveRun(scopeDataHome(home, "alpha"), ledger());
      await appendRollbackRow(scopeDataHome(home, "alpha"), {
        type: "performed",
        runId,
        at: "2026-07-05T00:01:00.000Z",
        preRollbackTree: "index-tree-after",
        preRollbackHead: "head-after",
        rollbackRef,
        baselineTree: "base-tree",
        baselineHeadSha: "base-head",
        revertedCommits: [{ sha: "aaaa111", subject: "ship rollback target" }],
        revertedPaths: ["src/changed.ts"],
        deletedPaths: ["generated.txt"],
      });
      const { exec, calls } = statefulRollbackExec();

      const res = await invoke(rollbackTool(exec), { project: "alpha", confirm: true });

      expect(res.isError).toBeUndefined();
      expect(calls).toEqual([]);
      expect(await readRollbackRows(scopeDataHome(home, "alpha"), runId)).toHaveLength(1);
    });

    test("confirm records noop without creating a rollback ref when nothing changed", async () => {
      await archiveRun(scopeDataHome(home, "alpha"), ledger());
      const { exec, calls } = makeRibExec((cmd, args) => {
        if (cmd !== "git") return fail(`unexpected command: ${cmd}`);
        const outputs: Record<string, string> = {
          [`rev-parse --verify ${rollbackRef}`]: "",
          "rev-parse HEAD": "base-head\n",
          "write-tree": "base-tree\n",
          "rev-parse -q --verify MERGE_HEAD": "",
          "rev-parse --git-path rebase-merge": ".git/rebase-merge\n",
          "rev-parse --git-path rebase-apply": ".git/rebase-apply\n",
          "rev-list --reverse base-head..HEAD": "",
          "diff-tree -r -z --diff-filter=DMRT --name-only base-tree base-tree": "",
          "diff-tree -r -z --diff-filter=A --name-only base-tree base-tree": "",
        };
        if (args.join(" ") === "merge-base --is-ancestor base-head HEAD") return ok("");
        return args.join(" ") in outputs ? ok(outputs[args.join(" ")]) : fail(args.join(" "));
      });

      const res = await invoke(rollbackTool(exec), { project: "alpha", confirm: true });

      expect(res.isError).toBeUndefined();
      expect(mutatingGitCalls(calls)).toEqual([]);
      expect(await readRollbackRows(scopeDataHome(home, "alpha"), runId)).toEqual([
        { type: "noop", runId, at: expect.any(String) },
      ]);
    });

    test("declined preview path performs no mutation and records no event", async () => {
      await archiveRun(scopeDataHome(home, "alpha"), ledger());
      const { exec, calls } = statefulRollbackExec();

      const res = await invoke(rollbackTool(exec), { project: "alpha", confirm: false });

      expect(res.isError).toBeUndefined();
      expect(mutatingGitCalls(calls)).toEqual([]);
      expect(await readRollbackRows(scopeDataHome(home, "alpha"), runId)).toEqual([]);
    });

    test.each([
      `update-ref ${rollbackRef} rollback-commit`,
      "reset --soft base-head",
      "read-tree base-tree",
      "checkout-index -a -f",
    ])("recovers after a crash following %s", async (crashAfter) => {
      await archiveRun(scopeDataHome(home, "alpha"), ledger());
      await mkdir(join(root, "nested"), { recursive: true });
      await writeFile(join(root, "generated.txt"), "delete me");
      await writeFile(join(root, "nested", "new.txt"), "delete me");
      const fake = statefulRollbackExec({ crashAfter });

      const first = await invoke(rollbackTool(fake.exec), { project: "alpha", confirm: true });
      expect(first.isError).toBe(true);
      const second = await invoke(rollbackTool(fake.exec), { project: "alpha", confirm: true });

      expect(second.isError).toBeUndefined();
      expect(fake.state.head).toBe("base-head");
      expect(fake.state.indexTree).toBe("base-tree");
      expect(fake.state.worktreeTree).toBe("base-tree");
      expect(await readRollbackRows(scopeDataHome(home, "alpha"), runId)).toHaveLength(1);
      expect(await readRollbackRows(scopeDataHome(home, "alpha"), runId)).toEqual([
        expect.objectContaining({ type: "performed" }),
      ]);
    });

    test("tolerates ENOENT while unlinking run-added paths during the final prune step", async () => {
      await archiveRun(scopeDataHome(home, "alpha"), ledger());
      await mkdir(join(root, "nested"), { recursive: true });
      await writeFile(join(root, "nested", "new.txt"), "delete me");
      const { exec, calls } = statefulRollbackExec();

      const res = await invoke(rollbackTool(exec), { project: "alpha", confirm: true });

      expect(res.isError).toBeUndefined();
      expect(gitCalls(calls)).not.toContain("clean -fd");
      expect(await readRollbackRows(scopeDataHome(home, "alpha"), runId)).toEqual([
        expect.objectContaining({ type: "performed" }),
      ]);
    });
  });

  test("refuses non-aborted and non-failed run states", async () => {
    const { exec, calls } = fakeExec({
      outputs: {
        "rev-parse HEAD": "observed\n",
        "write-tree": "tree\n",
      },
    });

    await expect(
      computeRollbackPlan(ledger({ status: "done" }), exec, rollbackRef),
    ).resolves.toEqual({
      type: "refused",
      reason: "run-not-rollbackable",
      observedHead: "observed",
    });
    expect(calls.map((call) => `${call.kind}:${call.value}`)).toEqual([
      "git:rev-parse HEAD",
      "git:write-tree",
    ]);
  });

  test("returns noop when there are no commits or path deltas", async () => {
    const { exec } = fakeExec({
      outputs: {
        "rev-parse HEAD": "base-head\n",
        "write-tree": "base-tree\n",
        "rev-parse -q --verify MERGE_HEAD": "",
        "rev-parse --git-path rebase-merge": ".git/rebase-merge\n",
        "rev-parse --git-path rebase-apply": ".git/rebase-apply\n",
        "rev-list --reverse base-head..HEAD": "",
        "diff-tree -r -z --diff-filter=DMRT --name-only base-tree base-tree": "",
        "diff-tree -r -z --diff-filter=A --name-only base-tree base-tree": "",
      },
    });

    await expect(computeRollbackPlan(ledger(), exec, rollbackRef)).resolves.toEqual({
      type: "noop",
      preRollbackHead: "base-head",
      preRollbackTree: "base-tree",
    });
  });
});
