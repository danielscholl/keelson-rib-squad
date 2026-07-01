import { describe, expect, test } from "bun:test";
import type { RibExec } from "@keelson/shared";
import { openChangeRequest } from "../src/open-change-request.ts";

type RunTextResult = Awaited<ReturnType<RibExec["runText"]>>;
type RunTextOptions = Parameters<RibExec["runText"]>[2];

interface RunTextCall {
  cmd: string;
  args: string[];
  opts: RunTextOptions;
}

function ok(data = ""): RunTextResult {
  return { ok: true, data, exitCode: 0 };
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

function expectNoMerge(calls: readonly RunTextCall[]) {
  expect(calls.some((call) => call.args.includes("merge"))).toBe(false);
}

function expectNonForcePush(calls: readonly RunTextCall[], remote: string, branch: string) {
  const pushes = commandCalls(calls, "git", "push");
  expect(pushes).toHaveLength(1);
  expect(pushes[0]?.args).toEqual(["push", "--set-upstream", remote, branch]);
  expect(pushes[0]?.args).not.toContain("--force");
  expect(pushes[0]?.args).not.toContain("--force-with-lease");
  expect(pushes[0]?.args.some((arg) => arg.startsWith("+"))).toBe(false);
}

function expectHappyPathSequence(calls: readonly RunTextCall[], createCmd: "gh" | "glab") {
  const checkoutIndex = calls.findIndex(
    (call) => call.cmd === "git" && argsEqual(call.args, ["checkout", "-b", "ship-the-feature"]),
  );
  const pushIndex = calls.findIndex(
    (call) =>
      call.cmd === "git" &&
      argsEqual(call.args, ["push", "--set-upstream", "origin", "ship-the-feature"]),
  );
  const createIndex = calls.findIndex(
    (call) =>
      call.cmd === createCmd &&
      argsEqual(call.args.slice(0, 3), [createCmd === "gh" ? "pr" : "mr", "create", "--draft"]),
  );

  expect(checkoutIndex).toBeGreaterThanOrEqual(0);
  expect(pushIndex).toBeGreaterThanOrEqual(0);
  expect(createIndex).toBeGreaterThanOrEqual(0);
  expect(checkoutIndex).toBeLessThan(pushIndex);
  expect(pushIndex).toBeLessThan(createIndex);
}

function happyForgeExec(opts: {
  remoteUrl: string;
  createCmd: "gh" | "glab";
  createOutput: string;
}) {
  return makeExec((cmd, args) => {
    if (cmd === "git" && argsEqual(args, ["remote"])) return ok("origin\n");
    if (cmd === "git" && argsEqual(args, ["remote", "get-url", "--push", "origin"])) {
      return ok(opts.remoteUrl);
    }
    if (cmd === "git" && argsEqual(args, ["branch", "--show-current"])) return ok("main\n");
    if (cmd === "git" && argsEqual(args, ["config", "--get", "branch.main.remote"])) {
      return ok("origin\n");
    }
    if (cmd === "git" && argsEqual(args, ["rev-parse", "--verify", "HEAD"])) return ok("abc123\n");
    if (
      cmd === "git" &&
      argsEqual(args, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])
    ) {
      return ok("origin/main\n");
    }
    if (cmd === "git" && argsEqual(args, ["rev-list", "--count", "origin/main..HEAD"])) {
      return ok("2\n");
    }
    if (cmd === "git" && argsEqual(args, ["checkout", "-b", "ship-the-feature"])) return ok();
    if (
      cmd === "git" &&
      argsEqual(args, ["push", "--set-upstream", "origin", "ship-the-feature"])
    ) {
      return ok();
    }
    if (cmd === opts.createCmd) return ok(opts.createOutput);
    return fail(`unexpected command: ${cmd} ${args.join(" ")}`);
  });
}

const request = {
  cwd: "/repo",
  title: "Ship the feature",
  body: "Drafted by squad.",
};

describe("openChangeRequest", () => {
  const githubCases = [
    {
      name: "github.com",
      remoteUrl: "git@github.com:org/repo.git",
      url: "https://github.com/org/repo/pull/12",
    },
    {
      name: "GitHub Enterprise",
      remoteUrl: "git@code.ghe.acme.test:org/repo.git",
      url: "https://code.ghe.acme.test/org/repo/pull/12",
    },
  ];

  for (const c of githubCases) {
    test(`opens a draft GitHub pull request from a ${c.name} remote`, async () => {
      const { exec, calls } = happyForgeExec({
        remoteUrl: c.remoteUrl,
        createCmd: "gh",
        createOutput: `Created ${c.url}\n`,
      });

      const result = await openChangeRequest({ ...request, exec });

      expect(result).toEqual({ ok: true, url: c.url });
      expect(commandCalls(calls, "git", "checkout")[0]?.args).toEqual([
        "checkout",
        "-b",
        "ship-the-feature",
      ]);
      expectNonForcePush(calls, "origin", "ship-the-feature");
      expect(commandCalls(calls, "gh")[0]?.args).toEqual([
        "pr",
        "create",
        "--draft",
        "--title",
        request.title,
        "--body",
        request.body,
        "--head",
        "ship-the-feature",
      ]);
      expectHappyPathSequence(calls, "gh");
      expectNoMerge(calls);
    });
  }

  const gitlabCases = [
    {
      name: "gitlab.com",
      remoteUrl: "git@gitlab.com:org/repo.git",
      url: "https://gitlab.com/org/repo/-/merge_requests/12",
    },
    {
      name: "self-hosted GitLab",
      remoteUrl: "ssh://git@gitlab.acme.test/org/repo.git",
      url: "https://gitlab.acme.test/org/repo/-/merge_requests/12",
    },
  ];

  for (const c of gitlabCases) {
    test(`opens a draft GitLab merge request from a ${c.name} remote`, async () => {
      const { exec, calls } = happyForgeExec({
        remoteUrl: c.remoteUrl,
        createCmd: "glab",
        createOutput: `View merge request: ${c.url}\n`,
      });

      const result = await openChangeRequest({ ...request, exec });

      expect(result).toEqual({ ok: true, url: c.url });
      expect(commandCalls(calls, "git", "checkout")[0]?.args).toEqual([
        "checkout",
        "-b",
        "ship-the-feature",
      ]);
      expectNonForcePush(calls, "origin", "ship-the-feature");
      expect(commandCalls(calls, "glab")[0]?.args).toEqual([
        "mr",
        "create",
        "--draft",
        "--title",
        request.title,
        "--description",
        request.body,
        "--source-branch",
        "ship-the-feature",
      ]);
      expectHappyPathSequence(calls, "glab");
      expectNoMerge(calls);
    });
  }

  test("returns a clear error and does not proceed when no remote is configured", async () => {
    const { exec, calls } = makeExec((cmd, args) => {
      if (cmd === "git" && argsEqual(args, ["remote"])) return ok("");
      return fail(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    const result = await openChangeRequest({ ...request, exec });

    expect(result).toEqual({
      ok: false,
      error:
        "no git remote is configured; add a remote or set an upstream before opening a draft change request",
    });
    expect(commandCalls(calls, "git", "checkout")).toHaveLength(0);
    expect(commandCalls(calls, "git", "push")).toHaveLength(0);
    expect(commandCalls(calls, "gh")).toHaveLength(0);
    expect(commandCalls(calls, "glab")).toHaveLength(0);
    expectNoMerge(calls);
  });

  test("returns a clear error and does not proceed for an unsupported forge host", async () => {
    const { exec, calls } = makeExec((cmd, args) => {
      if (cmd === "git" && argsEqual(args, ["remote"])) return ok("origin\n");
      if (cmd === "git" && argsEqual(args, ["remote", "get-url", "--push", "origin"])) {
        return ok("git@example.com:org/repo.git\n");
      }
      if (cmd === "git" && argsEqual(args, ["branch", "--show-current"])) return ok("main\n");
      if (cmd === "git" && argsEqual(args, ["config", "--get", "branch.main.remote"])) {
        return ok("origin\n");
      }
      return fail(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    const result = await openChangeRequest({ ...request, exec });

    expect(result).toEqual({
      ok: false,
      error:
        'unsupported forge host "example.com" for remote "origin"; use a GitHub/GitHub Enterprise or GitLab remote',
    });
    expect(commandCalls(calls, "git", "checkout")).toHaveLength(0);
    expect(commandCalls(calls, "git", "push")).toHaveLength(0);
    expect(commandCalls(calls, "gh")).toHaveLength(0);
    expect(commandCalls(calls, "glab")).toHaveLength(0);
    expectNoMerge(calls);
  });

  test("does not misdetect a look-alike host (notgithub.com) as a supported forge", async () => {
    const { exec, calls } = makeExec((cmd, args) => {
      if (cmd === "git" && argsEqual(args, ["remote"])) return ok("origin\n");
      if (cmd === "git" && argsEqual(args, ["remote", "get-url", "--push", "origin"])) {
        return ok("git@notgithub.com:org/repo.git\n");
      }
      if (cmd === "git" && argsEqual(args, ["branch", "--show-current"])) return ok("main\n");
      if (cmd === "git" && argsEqual(args, ["config", "--get", "branch.main.remote"])) {
        return ok("origin\n");
      }
      return fail(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    const result = await openChangeRequest({ ...request, exec });

    expect(result).toEqual({
      ok: false,
      error:
        'unsupported forge host "notgithub.com" for remote "origin"; use a GitHub/GitHub Enterprise or GitLab remote',
    });
    expect(commandCalls(calls, "gh")).toHaveLength(0);
    expect(commandCalls(calls, "glab")).toHaveLength(0);
    expectNoMerge(calls);
  });

  test("falls back to a forge remote when the branch upstream is a non-forge remote", async () => {
    const { exec, calls } = makeExec((cmd, args) => {
      if (cmd === "git" && argsEqual(args, ["remote"])) return ok("origin\nupstream\n");
      if (cmd === "git" && argsEqual(args, ["remote", "get-url", "--push", "origin"])) {
        return ok("git@github.com:org/repo.git\n");
      }
      if (cmd === "git" && argsEqual(args, ["remote", "get-url", "--push", "upstream"])) {
        return ok("git@example.com:org/repo.git\n");
      }
      if (cmd === "git" && argsEqual(args, ["branch", "--show-current"])) return ok("main\n");
      if (cmd === "git" && argsEqual(args, ["config", "--get", "branch.main.remote"])) {
        return ok("upstream\n");
      }
      if (cmd === "git" && argsEqual(args, ["rev-parse", "--verify", "HEAD"])) return ok("abc\n");
      if (
        cmd === "git" &&
        argsEqual(args, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])
      ) {
        return ok("origin/main\n");
      }
      if (cmd === "git" && argsEqual(args, ["rev-list", "--count", "origin/main..HEAD"])) {
        return ok("1\n");
      }
      if (cmd === "git" && argsEqual(args, ["checkout", "-b", "ship-the-feature"])) return ok();
      if (
        cmd === "git" &&
        argsEqual(args, ["push", "--set-upstream", "origin", "ship-the-feature"])
      ) {
        return ok();
      }
      if (cmd === "gh") return ok("https://github.com/org/repo/pull/7\n");
      return fail(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    const result = await openChangeRequest({ ...request, exec });

    expect(result).toEqual({ ok: true, url: "https://github.com/org/repo/pull/7" });
    expectNonForcePush(calls, "origin", "ship-the-feature");
    expect(commandCalls(calls, "glab")).toHaveLength(0);
    expectNoMerge(calls);
  });

  const cliFailureCases = [
    {
      cli: "gh" as const,
      remoteUrl: "git@github.com:org/repo.git",
      error: "gh: authentication required",
      expected:
        "gh failed while opening the draft pull request; install/authenticate gh and retry: gh: authentication required",
    },
    {
      cli: "glab" as const,
      remoteUrl: "git@gitlab.com:org/repo.git",
      error: "glab: command not found",
      expected:
        "glab failed while opening the draft merge request; install/authenticate glab and retry: glab: command not found",
    },
  ];

  for (const c of cliFailureCases) {
    test(`returns a clear error when ${c.cli} cannot create the draft`, async () => {
      const { exec, calls } = happyForgeExec({
        remoteUrl: c.remoteUrl,
        createCmd: c.cli,
        createOutput: "",
      });
      const originalRunText = exec.runText;
      exec.runText = async (cmd, args, opts) => {
        if (cmd === c.cli) {
          calls.push({ cmd, args: [...args], opts });
          return fail(c.error, 127);
        }
        return originalRunText(cmd, args, opts);
      };

      const result = await openChangeRequest({ ...request, exec });

      expect(result).toEqual({ ok: false, error: c.expected });
      expectNonForcePush(calls, "origin", "ship-the-feature");
      expectNoMerge(calls);
    });
  }

  test("returns a clear error and does not proceed when there are no commits to submit", async () => {
    const { exec, calls } = makeExec((cmd, args) => {
      if (cmd === "git" && argsEqual(args, ["remote"])) return ok("origin\n");
      if (cmd === "git" && argsEqual(args, ["remote", "get-url", "--push", "origin"])) {
        return ok("git@github.com:org/repo.git\n");
      }
      if (cmd === "git" && argsEqual(args, ["branch", "--show-current"])) return ok("main\n");
      if (cmd === "git" && argsEqual(args, ["config", "--get", "branch.main.remote"])) {
        return ok("origin\n");
      }
      if (cmd === "git" && argsEqual(args, ["rev-parse", "--verify", "HEAD"]))
        return ok("abc123\n");
      if (
        cmd === "git" &&
        argsEqual(args, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])
      ) {
        return ok("origin/main\n");
      }
      if (cmd === "git" && argsEqual(args, ["rev-list", "--count", "origin/main..HEAD"])) {
        return ok("0\n");
      }
      return fail(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    const result = await openChangeRequest({ ...request, exec });

    expect(result).toEqual({
      ok: false,
      error: "no commits to submit; HEAD has no commits beyond the base branch",
    });
    expect(commandCalls(calls, "git", "checkout")).toHaveLength(0);
    expect(commandCalls(calls, "git", "push")).toHaveLength(0);
    expect(commandCalls(calls, "gh")).toHaveLength(0);
    expect(commandCalls(calls, "glab")).toHaveLength(0);
    expectNoMerge(calls);
  });
});
