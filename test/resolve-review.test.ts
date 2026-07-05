import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  MessageChunk,
  RibAgentTurn,
  RibContext,
  RibExec,
  ToolDefinition,
} from "@keelson/shared";
import rib, { parseReviewDispositions } from "../src/index.ts";
import { scaffoldMember } from "../src/member-store.ts";
import { scopeMembersDir, setSquadDataHome } from "../src/paths.ts";
import {
  fetchUnresolvedThreads,
  type ReviewThread,
  replyToThread,
  resolveThread,
} from "../src/resolve-review.ts";

type RunTextResult = Awaited<ReturnType<RibExec["runText"]>>;
type RunTextOptions = Parameters<RibExec["runText"]>[2];

interface RunTextCall {
  cmd: string;
  args: string[];
  opts: RunTextOptions;
}

const DONE = { type: "done" } as const satisfies MessageChunk;

function ok(data = ""): RunTextResult {
  return { ok: true, data, exitCode: 0 };
}

function fail(error: string, code = 1): RunTextResult {
  return { ok: false, error, code };
}

async function* oneShot(): AsyncGenerator<MessageChunk> {
  yield DONE;
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

function argsEqual(args: readonly string[], expected: readonly string[]): boolean {
  return args.length === expected.length && args.every((arg, i) => arg === expected[i]);
}

function commandCalls(
  calls: readonly RunTextCall[],
  cmd: string,
  firstArg?: string,
): RunTextCall[] {
  return calls.filter(
    (call) => call.cmd === cmd && (firstArg === undefined || call.args[0] === firstArg),
  );
}

function project(rootPath: string) {
  return { id: "alpha", name: "alpha", rootPath, createdAt: "2026-07-05T00:00:00.000Z" };
}

function tool(tools: readonly ToolDefinition[], name: string): ToolDefinition {
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`${name} not registered`);
  return found;
}

function invoke(t: ToolDefinition, input: unknown): Promise<{ content: string; isError: boolean }> {
  let content = "";
  let isError = false;
  return t
    .execute(input, {
      emit: (e: { content?: string; isError?: boolean }) => {
        content = e.content ?? "";
        isError = Boolean(e.isError);
      },
    } as never)
    .then(() => ({ content, isError }));
}

function managerDoneWithDisposition(threadRef = "gh:thread-1"): string {
  return `done\n${JSON.stringify({
    action: "done",
    summary: `handled review\n\n\`\`\`json\n${JSON.stringify([
      { threadRef, disposition: "fixed", note: "Adjusted the code." },
    ])}\n\`\`\``,
  })}`;
}

function queuedRun(replies: string[]): NonNullable<RibContext["runAgentTurn"]> {
  let i = 0;
  return (): RibAgentTurn => {
    const text = replies[Math.min(i, replies.length - 1)] ?? "";
    i += 1;
    return { stream: oneShot(), result: Promise.resolve({ status: "ok", text }) };
  };
}

function slowRun(): {
  run: NonNullable<RibContext["runAgentTurn"]>;
  release: (text: string) => void;
} {
  let release: (text: string) => void = () => {};
  return {
    run: (): RibAgentTurn => ({
      stream: oneShot(),
      result: new Promise((resolve) => {
        release = (text) => resolve({ status: "ok", text });
      }),
    }),
    release: (text) => release(text),
  };
}

async function scaffoldActiveMember(home: string): Promise<void> {
  await scaffoldMember(scopeMembersDir(home, "alpha"), {
    slug: "atlas",
    name: "Atlas",
    role: "Engineer",
    charter: "# Atlas",
    status: "active",
    tools: ["code"],
    createdAt: "2026-07-05T00:00:00.000Z",
  });
}

function githubFetchExec(remoteUrl = "git@github.com:org/repo.git") {
  return makeExec((cmd, args) => {
    if (cmd === "git" && argsEqual(args, ["remote"])) return ok("origin\n");
    if (cmd === "git" && argsEqual(args, ["remote", "get-url", "--push", "origin"])) {
      return ok(remoteUrl);
    }
    if (cmd === "git" && argsEqual(args, ["branch", "--show-current"])) return ok("review-fix\n");
    if (cmd === "git" && argsEqual(args, ["config", "--get", "branch.review-fix.remote"])) {
      return ok("origin\n");
    }
    if (cmd === "gh" && argsEqual(args, ["pr", "view", "--json", "number"])) {
      return ok(JSON.stringify({ number: 12 }));
    }
    if (cmd === "gh" && argsEqual(args.slice(0, 2), ["api", "graphql"])) {
      return ok(
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      id: "thread-1",
                      isResolved: false,
                      path: "src/a.ts",
                      line: 7,
                      comments: {
                        nodes: [
                          { databaseId: 101, body: "Please fix this", author: { login: "octo" } },
                        ],
                      },
                    },
                    {
                      id: "thread-2",
                      isResolved: true,
                      path: "src/b.ts",
                      line: 9,
                      comments: {
                        nodes: [{ databaseId: 102, body: "Done", author: { login: "octo" } }],
                      },
                    },
                  ],
                },
              },
            },
          },
        }),
      );
    }
    return fail(`unexpected command: ${cmd} ${args.join(" ")}`);
  });
}

describe("resolve-review forge mechanics", () => {
  test("detects GitHub/GHE remotes and fetches unresolved review threads", async () => {
    const { exec, calls } = githubFetchExec("git@code.ghe.acme.test:org/repo.git");

    const result = await fetchUnresolvedThreads(exec, "/repo");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual([
        expect.objectContaining({
          forge: "github",
          threadRef: "gh:thread-1",
          owner: "org",
          repo: "repo",
          pullNumber: 12,
          firstCommentDatabaseId: 101,
          path: "src/a.ts",
          line: 7,
          author: "octo",
          body: "Please fix this",
        }),
      ]);
    }
    expect(commandCalls(calls, "gh", "api")[0]?.args).toContain("owner=org");
    expect(calls.every((call) => call.opts?.timeoutMs === 120_000)).toBe(true);
  });

  test("detects GitLab remotes and fetches unresolved discussions", async () => {
    const { exec } = makeExec((cmd, args) => {
      if (cmd === "git" && argsEqual(args, ["remote"])) return ok("origin\n");
      if (cmd === "git" && argsEqual(args, ["remote", "get-url", "--push", "origin"])) {
        return ok("git@gitlab.com:group/project.git\n");
      }
      if (cmd === "git" && argsEqual(args, ["branch", "--show-current"])) return ok("review-fix\n");
      if (cmd === "git" && argsEqual(args, ["config", "--get", "branch.review-fix.remote"])) {
        return ok("origin\n");
      }
      if (
        cmd === "glab" &&
        argsEqual(args, ["mr", "view", "--output", "json", "--fields", "iid"])
      ) {
        return ok(JSON.stringify({ iid: 34 }));
      }
      if (
        cmd === "glab" &&
        argsEqual(args, ["api", "projects/group%2Fproject/merge_requests/34/discussions"])
      ) {
        return ok(
          JSON.stringify([
            {
              id: "disc-1",
              resolved: false,
              notes: [
                {
                  body: "Please fix this",
                  system: false,
                  author: { username: "reviewer" },
                  position: { new_path: "src/a.ts", new_line: 11 },
                },
                { body: "system note", system: true, author: { username: "bot" } },
              ],
            },
            {
              id: "disc-2",
              resolved: true,
              notes: [
                {
                  body: "resolved",
                  system: false,
                  author: { username: "reviewer" },
                  position: { new_path: "src/b.ts", new_line: 2 },
                },
              ],
            },
          ]),
        );
      }
      return fail(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    const result = await fetchUnresolvedThreads(exec, "/repo");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual([
        expect.objectContaining({
          forge: "gitlab",
          threadRef: "gl:disc-1",
          projectPath: "group/project",
          mergeRequestIid: 34,
          path: "src/a.ts",
          line: 11,
          author: "reviewer",
        }),
      ]);
    }
  });
});

describe("resolve-review dispositions", () => {
  const threads = [
    {
      forge: "github",
      threadRef: "gh:one",
      threadId: "one",
      owner: "org",
      repo: "repo",
      pullNumber: 1,
      firstCommentDatabaseId: 10,
      path: "a.ts",
      line: 1,
      author: "a",
      body: "body",
      comments: [],
    },
    {
      forge: "github",
      threadRef: "gh:two",
      threadId: "two",
      owner: "org",
      repo: "repo",
      pullNumber: 1,
      firstCommentDatabaseId: 11,
      path: "b.ts",
      line: 2,
      author: "b",
      body: "body",
      comments: [],
    },
  ] satisfies ReviewThread[];

  test("maps valid fenced JSON by threadRef", () => {
    const result = parseReviewDispositions(
      `tail\n\`\`\`json\n${JSON.stringify([
        { threadRef: "gh:one", disposition: "fixed", note: "done" },
        { threadRef: "gh:two", disposition: "declined", note: "no" },
      ])}\n\`\`\``,
      threads,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.dispositions.get("gh:one")?.disposition).toBe("fixed");
      expect(result.dispositions.get("gh:two")?.disposition).toBe("declined");
    }
  });

  test.each([
    ["missing", "no block"],
    ["malformed", "```json\n{ nope\n```"],
    [
      "unknown threadRef",
      '```json\n[{"threadRef":"gh:missing","disposition":"fixed","note":"x"}]\n```',
    ],
    [
      "unknown disposition",
      '```json\n[{"threadRef":"gh:one","disposition":"maybe","note":"x"}]\n```',
    ],
  ])("%s returns an empty resolve set with a reason", (_name, text) => {
    const result = parseReviewDispositions(text, threads);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
  });

  test("replies to every thread and resolves only fixed dispositions", async () => {
    const { exec, calls } = makeExec((cmd, args) => {
      if (cmd === "gh" && args[0] === "api") return ok("{}");
      return fail(`unexpected command: ${cmd} ${args.join(" ")}`);
    });
    const parsed = parseReviewDispositions(
      `\`\`\`json\n${JSON.stringify([
        { threadRef: "gh:one", disposition: "fixed", note: "done" },
        { threadRef: "gh:two", disposition: "declined", note: "no" },
      ])}\n\`\`\``,
      threads,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    for (const thread of threads) {
      const disposition = parsed.dispositions.get(thread.threadRef);
      if (!disposition) continue;
      await replyToThread(exec, "/repo", thread, disposition.note);
      if (disposition.disposition === "fixed") await resolveThread(exec, "/repo", thread);
    }

    const replies = calls.filter((call) => call.args.some((arg) => arg.endsWith("/replies")));
    const resolves = calls.filter((call) =>
      call.args.some((arg) => arg.includes("resolveReviewThread")),
    );
    expect(replies).toHaveLength(2);
    expect(resolves).toHaveLength(1);
    expect(resolves[0]?.args).toContain("threadId=one");
  });
});

describe("squad_resolve_review tool flow", () => {
  let home: string;
  let root: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "squad-resolve-review-home-"));
    root = await mkdtemp(join(tmpdir(), "squad-resolve-review-root-"));
    await scaffoldActiveMember(home);
  });

  afterEach(async () => {
    rib.dispose?.();
    setSquadDataHome(undefined);
    await rm(home, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });

  test("reports honestly and does not push or reply when the run creates no commit", async () => {
    const { exec, calls } = githubFetchExec();
    const original = exec.runText;
    exec.runText = async (cmd, args, opts) => {
      if (cmd === "git" && argsEqual(args, ["rev-parse", "HEAD"])) return ok("abc123\n");
      if (cmd === "git" && argsEqual(args, ["add", "-A", "--", "."])) return ok();
      if (cmd === "git" && argsEqual(args, ["write-tree"])) return ok("tree123\n");
      return original(cmd, args, opts);
    };
    const tools =
      rib.registerTools?.({
        getDataDir: () => home,
        getProjects: () => [project(root)],
        getExec: () => exec,
        runAgentTurn: queuedRun([managerDoneWithDisposition()]),
      } as unknown as RibContext) ?? [];

    const result = await invoke(tool(tools, "squad_resolve_review"), { project: "alpha" });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("created no new commit");
    expect(commandCalls(calls, "git", "push")).toHaveLength(0);
    expect(calls.some((call) => call.args.some((arg) => arg.endsWith("/replies")))).toBe(false);
  });

  test("active-run guard returns before any second-run forge calls", async () => {
    const firstExec = githubFetchExec().exec;
    firstExec.runText = async (cmd, args, opts) => {
      if (cmd === "git" && argsEqual(args, ["rev-parse", "HEAD"])) return ok("abc123\n");
      if (cmd === "git" && argsEqual(args, ["add", "-A", "--", "."])) return ok();
      if (cmd === "git" && argsEqual(args, ["write-tree"])) return ok("tree123\n");
      return githubFetchExec().exec.runText(cmd, args as string[], opts);
    };
    const second = githubFetchExec();
    const slow = slowRun();
    const tools =
      rib.registerTools?.({
        getDataDir: () => home,
        getProjects: () => [project(root)],
        getExec: () => firstExec,
        runAgentTurn: slow.run,
      } as unknown as RibContext) ?? [];
    const resolveTool = tool(tools, "squad_resolve_review");
    const first = invoke(resolveTool, { project: "alpha" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const secondTools =
      rib.registerTools?.({
        getDataDir: () => home,
        getProjects: () => [project(root)],
        getExec: () => second.exec,
        runAgentTurn: queuedRun([managerDoneWithDisposition()]),
      } as unknown as RibContext) ?? [];

    const guarded = await invoke(tool(secondTools, "squad_resolve_review"), { project: "alpha" });

    expect(guarded.isError).toBe(true);
    expect(guarded.content).toContain("already has a live coordinator run");
    expect(commandCalls(second.calls, "gh")).toHaveLength(0);
    slow.release(managerDoneWithDisposition());
    await first;
  });
});
