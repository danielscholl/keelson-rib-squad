import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RibContext, RibExec, ToolDefinition } from "@keelson/shared";
import rib from "../src/index.ts";
import { setSquadDataHome } from "../src/paths.ts";
import { writeSelectedProject } from "../src/scope.ts";

type RunTextResult = Awaited<ReturnType<RibExec["runText"]>>;
type RunTextOptions = Parameters<RibExec["runText"]>[2];

interface RunTextCall {
  cmd: string;
  args: string[];
  opts: RunTextOptions;
}

let home: string;
let root: string;

function project(id: string, name: string, rootPath: string) {
  return { id, name, rootPath, createdAt: "2026-07-01T00:00:00.000Z" };
}

function ok(data = "", exitCode = 0): RunTextResult {
  return { ok: true, data, exitCode };
}

function fail(error: string, code = 1): RunTextResult {
  return { ok: false, error, code };
}

function makeExec(
  handler: (cmd: string, args: readonly string[]) => RunTextResult | Promise<RunTextResult>,
): { exec: RibExec; calls: RunTextCall[] } {
  const calls: RunTextCall[] = [];
  return {
    calls,
    exec: {
      runJSON: async () => ({ ok: false as const, error: "unused", code: null }),
      runText: async (cmd, args, opts) => {
        calls.push({ cmd, args: [...args], opts });
        return handler(cmd, args);
      },
    },
  };
}

function bootTools(
  projects: ReturnType<typeof project>[],
  exec: RibExec = makeExec(() => ok()).exec,
): readonly ToolDefinition[] {
  const ctx = {
    getDataDir: () => home,
    getExec: () => exec,
    getProjects: () => projects,
  } as unknown as RibContext;
  return rib.registerTools?.(ctx) ?? [];
}

function viewDiffTool(
  projects: ReturnType<typeof project>[],
  exec?: RibExec,
): ToolDefinition | undefined {
  return bootTools(projects, exec).find((t) => t.name === "squad_view_diff");
}

async function invoke(
  tool: ToolDefinition | undefined,
  input: unknown,
): Promise<{ content?: string; isError?: boolean }> {
  const chunks: { content?: string; isError?: boolean }[] = [];
  await tool?.execute(input, {
    emit: (c: { content?: string; isError?: boolean }) => chunks.push(c),
  } as never);
  return chunks[0] ?? {};
}

async function selectProject(repo: string) {
  await writeSelectedProject(home, {
    scopeId: "p1",
    projectId: "p1",
    name: "alpha",
    rootPath: repo,
    at: "2026-07-01T00:00:00.000Z",
  });
}

function expectReadOnlyGit(calls: readonly RunTextCall[], repo: string) {
  const forbidden = new Set(["add", "checkout", "commit", "merge", "push", "rebase", "reset"]);
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    const op = call.args[0];
    expect(op).toBeDefined();
    expect(call.cmd).toBe("git");
    expect(call.opts?.cwd).toBe(repo);
    expect(forbidden.has(op ?? "")).toBe(false);
    const isUnstagedDiff = call.args.join(" ") === "diff --no-color";
    const isStagedDiff = call.args.join(" ") === "diff --no-color --staged";
    const isUnstagedNumstat = call.args.join(" ") === "diff --no-color --numstat";
    const isStagedNumstat = call.args.join(" ") === "diff --no-color --staged --numstat";
    const isLsFiles = call.args.join(" ") === "ls-files --others --exclude-standard -z";
    const isNoIndexDiff =
      call.args.length === 6 &&
      call.args[0] === "diff" &&
      call.args[1] === "--no-color" &&
      call.args[2] === "--no-index" &&
      call.args[3] === "--" &&
      call.args[4] === "/dev/null";
    expect(
      isUnstagedDiff ||
        isStagedDiff ||
        isUnstagedNumstat ||
        isStagedNumstat ||
        isLsFiles ||
        isNoIndexDiff,
    ).toBe(true);
  }
  expect(calls.some((call) => call.args[0] === "diff" && call.args.includes("--no-index"))).toBe(
    true,
  );
  expect(calls.some((call) => call.args[0] === "ls-files")).toBe(true);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "squad-view-diff-root-"));
  home = await mkdtemp(join(tmpdir(), "squad-view-diff-home-"));
});

afterEach(async () => {
  rib.dispose?.();
  setSquadDataHome(undefined);
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe("squad_view_diff tool", () => {
  test("is read-only and does not require confirmation", () => {
    const tool = viewDiffTool([]);
    expect(tool?.state_changing).toBeUndefined();
    expect(tool?.requires_confirmation).toBeUndefined();
  });

  test("fails softly when no project is bound", async () => {
    const res = await invoke(viewDiffTool([]), {});
    expect(res.isError).toBe(true);
    expect(res.content).toContain("squad_view_diff: no project bound");
  });

  test("reports no changes for a clean selected repo", async () => {
    const repo = join(root, "clean");
    await selectProject(repo);
    const { exec } = makeExec((_cmd, args) => {
      if (args[0] === "diff" || args[0] === "ls-files") return ok("");
      return fail(`unexpected command: ${args.join(" ")}`);
    });

    const res = await invoke(viewDiffTool([project("p1", "alpha", repo)], exec), {});
    expect(res.isError).toBeUndefined();
    expect(res.content).toBe("no changes in alpha");
  });

  test("shows tracked and untracked changes from the mocked shared capture", async () => {
    const repo = join(root, "dirty");
    await selectProject(repo);
    const trackedDiff = [
      "diff --git a/tracked.ts b/tracked.ts",
      "--- a/tracked.ts",
      "+++ b/tracked.ts",
      "@@ -1 +1 @@",
      "-export const VALUE = 1;",
      "+export const VALUE = 2;",
      "",
    ].join("\n");
    const untrackedDiff = [
      "diff --git a/new-file.ts b/new-file.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new-file.ts",
      "@@ -0,0 +1 @@",
      "+export const NEW_FILE = true;",
      "",
    ].join("\n");
    const { exec } = makeExec((_cmd, args) => {
      if (args[0] === "diff" && args.includes("--no-index")) return ok(untrackedDiff, 1);
      if (args[0] === "diff" && args.includes("--staged")) return ok("");
      if (args[0] === "diff") return ok(trackedDiff);
      if (args[0] === "ls-files") return ok("new-file.ts\0");
      return fail(`unexpected command: ${args.join(" ")}`);
    });

    const res = await invoke(viewDiffTool([project("p1", "alpha", repo)], exec), {});
    expect(res.isError).toBeUndefined();
    expect(res.content).toContain("Diff — alpha");
    expect(res.content).toContain("### Working tree");
    expect(res.content).toContain(trackedDiff.trimEnd());
    expect(res.content).toContain("### Untracked (new) files");
    expect(res.content).toContain("new-file.ts");
    expect(res.content).toContain(untrackedDiff.trimEnd());
  });

  test("uses only read-only git diff and ls-files commands", async () => {
    const repo = join(root, "readonly");
    await selectProject(repo);
    const { exec, calls } = makeExec((_cmd, args) => {
      if (args[0] === "diff" && args.includes("--no-index")) {
        return ok("diff --git a/new-file.ts b/new-file.ts\n+new\n", 1);
      }
      if (args[0] === "diff") return ok("");
      if (args[0] === "ls-files") return ok("new-file.ts\0");
      return fail(`unexpected command: ${args.join(" ")}`);
    });

    await invoke(viewDiffTool([project("p1", "alpha", repo)], exec), {});
    expectReadOnlyGit(calls, repo);
  });

  test("surfaces the shared capture error from the mocked exec seam", async () => {
    const repo = join(root, "not-git");
    await selectProject(repo);
    const { exec } = makeExec((_cmd, args) => {
      if (args[0] === "diff") return fail("not a git repository");
      if (args[0] === "ls-files") return fail("not a git repository");
      return fail(`unexpected command: ${args.join(" ")}`);
    });

    const res = await invoke(viewDiffTool([project("p1", "alpha", repo)], exec), {});
    expect(res.isError).toBe(true);
    expect(res.content).toContain("squad_view_diff: _Diff capture unavailable:");
  });
});
