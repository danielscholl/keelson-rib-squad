import type { RibExec } from "@keelson/shared";

export type OpenChangeRequestResult = { ok: true; url: string } | { ok: false; error: string };

export interface OpenChangeRequestOptions {
  exec: RibExec;
  cwd: string;
  title: string;
  body: string;
}

type Forge = {
  kind: "github" | "gitlab";
  cli: "gh" | "glab";
  noun: "pull request" | "merge request";
};

type Remote = {
  name: string;
  url: string;
  host: string;
  forge: Forge | undefined;
};

const GITHUB_FORGE: Forge = { kind: "github", cli: "gh", noun: "pull request" };
const GITLAB_FORGE: Forge = { kind: "gitlab", cli: "glab", noun: "merge request" };

const EXEC_TIMEOUT_MS = 120_000;
const URL_RE = /\bhttps?:\/\/[^\s<>()\]]+/i;

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function runText(
  exec: RibExec,
  cwd: string,
  cmd: string,
  args: string[],
): Promise<{ ok: true; data: string } | { ok: false; error: string; code: number | null }> {
  try {
    const result = await exec.runText(cmd, args, { cwd, timeoutMs: EXEC_TIMEOUT_MS });
    if (result.ok) return { ok: true, data: result.data };
    return { ok: false, error: result.error, code: result.code };
  } catch (e) {
    return { ok: false, error: errText(e), code: null };
  }
}

function slugifyBranch(title: string): string {
  const slug = title
    .normalize("NFKD")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/[/.]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 80)
    .replace(/-+$/, "");
  return slug || "change-request";
}

function hostFromRemoteUrl(remoteUrl: string): string | undefined {
  const url = remoteUrl.trim();
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    const ssh = /^(?:[^@/\s]+@)?([^:/\s]+)(?::|\/)/.exec(url);
    return ssh?.[1]?.toLowerCase();
  }
}

function detectForge(host: string): Forge | undefined {
  const h = host.toLowerCase();
  if (h === "github.com" || h.includes("github") || h === "ghe.com" || h.includes(".ghe.")) {
    return GITHUB_FORGE;
  }
  if (h === "gitlab.com" || h.includes("gitlab")) return GITLAB_FORGE;
  return undefined;
}

function parseLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function configuredUpstreamRemote(exec: RibExec, cwd: string): Promise<string | undefined> {
  const branch = await runText(exec, cwd, "git", ["branch", "--show-current"]);
  if (!branch.ok) return undefined;
  const branchName = branch.data.trim();
  if (!branchName) return undefined;
  const remote = await runText(exec, cwd, "git", [
    "config",
    "--get",
    `branch.${branchName}.remote`,
  ]);
  if (!remote.ok) return undefined;
  const name = remote.data.trim();
  return name && name !== "." ? name : undefined;
}

async function remoteUrl(exec: RibExec, cwd: string, remote: string): Promise<string | undefined> {
  const push = await runText(exec, cwd, "git", ["remote", "get-url", "--push", remote]);
  if (push.ok && push.data.trim()) return push.data.trim();
  const fetch = await runText(exec, cwd, "git", ["remote", "get-url", remote]);
  return fetch.ok && fetch.data.trim() ? fetch.data.trim() : undefined;
}

async function remotes(exec: RibExec, cwd: string): Promise<Remote[] | OpenChangeRequestResult> {
  const listed = await runText(exec, cwd, "git", ["remote"]);
  if (!listed.ok) {
    return { ok: false, error: `could not read git remotes: ${listed.error}` };
  }
  const names = parseLines(listed.data);
  if (names.length === 0) {
    return {
      ok: false,
      error:
        "no git remote is configured; add a remote or set an upstream before opening a draft change request",
    };
  }

  const found: Remote[] = [];
  for (const name of names) {
    const url = await remoteUrl(exec, cwd, name);
    if (!url) continue;
    const host = hostFromRemoteUrl(url);
    if (!host) continue;
    found.push({ name, url, host, forge: detectForge(host) });
  }
  if (found.length === 0) {
    return {
      ok: false,
      error:
        "no git remote has a usable URL; set a fetch or push URL before opening a draft change request",
    };
  }
  return found;
}

async function selectRemote(exec: RibExec, cwd: string): Promise<Remote | OpenChangeRequestResult> {
  const all = await remotes(exec, cwd);
  if (!Array.isArray(all)) return all;

  const upstream = await configuredUpstreamRemote(exec, cwd);
  const upstreamRemote = upstream ? all.find((r) => r.name === upstream) : undefined;
  const selected =
    upstreamRemote ?? (all.length === 1 ? all[0] : (all.find((r) => r.forge) ?? all[0]));
  if (!selected) {
    return {
      ok: false,
      error:
        "no git remote is configured; add a remote or set an upstream before opening a draft change request",
    };
  }
  if (!selected.forge) {
    return {
      ok: false,
      error: `unsupported forge host "${selected.host}" for remote "${selected.name}"; use a GitHub/GitHub Enterprise or GitLab remote`,
    };
  }
  return selected;
}

function classifyCliFailure(forge: Forge, error: string): string {
  if (
    /no commits|nothing to compare|no changes|empty pull request|empty merge request/i.test(error)
  ) {
    return "no commits to submit; commit changes that differ from the target branch, then retry";
  }
  if (
    /already exists|existing pull request|existing merge request|merge request.*exists|pull request.*exists/i.test(
      error,
    )
  ) {
    return `a ${forge.noun} already exists for this branch; open the existing draft or use a different title/branch`;
  }
  return `${forge.cli} failed while opening the draft ${forge.noun}; install/authenticate ${forge.cli} and retry: ${error}`;
}

function extractUrl(stdout: string): string | undefined {
  return URL_RE.exec(stdout)?.[0]?.replace(/[.,;:]+$/, "");
}

async function hasHead(exec: RibExec, cwd: string): Promise<OpenChangeRequestResult | undefined> {
  const head = await runText(exec, cwd, "git", ["rev-parse", "--verify", "HEAD"]);
  if (head.ok) return undefined;
  return { ok: false, error: "no commits to submit; the repository has no HEAD commit yet" };
}

async function hasCommitsBeyondRemoteHead(
  exec: RibExec,
  cwd: string,
  remote: string,
): Promise<OpenChangeRequestResult | undefined> {
  const remoteHead = await runText(exec, cwd, "git", [
    "symbolic-ref",
    "--quiet",
    "--short",
    `refs/remotes/${remote}/HEAD`,
  ]);
  if (!remoteHead.ok) return undefined;
  const base = remoteHead.data.trim();
  if (!base) return undefined;
  const count = await runText(exec, cwd, "git", ["rev-list", "--count", `${base}..HEAD`]);
  if (!count.ok) return undefined;
  if (Number(count.data.trim()) === 0) {
    return {
      ok: false,
      error: "no commits to submit; HEAD has no commits beyond the remote default branch",
    };
  }
  return undefined;
}

export async function openChangeRequest(
  opts: OpenChangeRequestOptions,
): Promise<OpenChangeRequestResult> {
  try {
    const remote = await selectRemote(opts.exec, opts.cwd);
    if (!("name" in remote)) return remote;
    if (!remote.forge) {
      return {
        ok: false,
        error: `unsupported forge host "${remote.host}" for remote "${remote.name}"; use a GitHub/GitHub Enterprise or GitLab remote`,
      };
    }

    const noHead = await hasHead(opts.exec, opts.cwd);
    if (noHead) return noHead;
    const noCommits = await hasCommitsBeyondRemoteHead(opts.exec, opts.cwd, remote.name);
    if (noCommits) return noCommits;

    const branch = slugifyBranch(opts.title);
    const checkout = await runText(opts.exec, opts.cwd, "git", ["checkout", "-b", branch]);
    if (!checkout.ok) {
      return {
        ok: false,
        error: `could not create feature branch "${branch}" at HEAD: ${checkout.error}`,
      };
    }

    const push = await runText(opts.exec, opts.cwd, "git", [
      "push",
      "--set-upstream",
      remote.name,
      branch,
    ]);
    if (!push.ok) {
      return {
        ok: false,
        error: `could not push branch "${branch}" to "${remote.name}": ${push.error}`,
      };
    }

    const createArgs =
      remote.forge.kind === "github"
        ? ["pr", "create", "--draft", "--title", opts.title, "--body", opts.body, "--head", branch]
        : [
            "mr",
            "create",
            "--draft",
            "--title",
            opts.title,
            "--description",
            opts.body,
            "--source-branch",
            branch,
          ];
    const created = await runText(opts.exec, opts.cwd, remote.forge.cli, createArgs);
    if (!created.ok) {
      return { ok: false, error: classifyCliFailure(remote.forge, created.error) };
    }

    const url = extractUrl(created.data);
    if (!url) {
      return {
        ok: false,
        error: `${remote.forge.cli} opened the draft ${remote.forge.noun} but did not print a URL`,
      };
    }
    return { ok: true, url };
  } catch (e) {
    return { ok: false, error: `open change request failed: ${errText(e)}` };
  }
}
