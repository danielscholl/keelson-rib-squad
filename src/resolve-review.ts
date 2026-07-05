import type { RibExec } from "@keelson/shared";

export type ResolveReviewResult<T> = { ok: true; data: T } | { ok: false; error: string };

export interface ReviewComment {
  author: string;
  body: string;
}

export type ReviewThread =
  | {
      forge: "github";
      threadRef: string;
      threadId: string;
      owner: string;
      repo: string;
      pullNumber: number;
      firstCommentDatabaseId: number;
      path: string;
      line: number;
      author: string;
      body: string;
      comments: ReviewComment[];
    }
  | {
      forge: "gitlab";
      threadRef: string;
      discussionId: string;
      projectPath: string;
      mergeRequestIid: number;
      path?: string;
      line: number;
      author: string;
      body: string;
      comments: ReviewComment[];
    };

type Forge = {
  kind: "github" | "gitlab";
  cli: "gh" | "glab";
  noun: "pull request" | "merge request";
};

type Remote = {
  name: string;
  url: string;
  host: string;
  path: string;
  forge: Forge | undefined;
};

const GITHUB_FORGE: Forge = { kind: "github", cli: "gh", noun: "pull request" };
const GITLAB_FORGE: Forge = { kind: "gitlab", cli: "glab", noun: "merge request" };
const EXEC_TIMEOUT_MS = 120_000;

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

function hostFromRemoteUrl(remoteUrl: string): string | undefined {
  const url = remoteUrl.trim();
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    const ssh = /^(?:[^@/\s]+@)?([^:/\s]+)(?::|\/)/.exec(url);
    return ssh?.[1]?.toLowerCase();
  }
}

function pathFromRemoteUrl(remoteUrl: string): string | undefined {
  const raw = remoteUrl.trim();
  try {
    const parsed = new URL(raw);
    const path = parsed.pathname.replace(/^\/+/, "").replace(/\.git$/, "");
    return path || undefined;
  } catch {
    const ssh = /^(?:[^@/\s]+@)?[^:/\s]+(?::|\/)(.+)$/.exec(raw);
    return ssh?.[1]?.replace(/^\/+/, "").replace(/\.git$/, "");
  }
}

function detectForge(host: string): Forge | undefined {
  const segments = host.toLowerCase().split(".");
  if (segments.includes("github") || segments.includes("ghe")) return GITHUB_FORGE;
  if (segments.includes("gitlab")) return GITLAB_FORGE;
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

async function remotes(exec: RibExec, cwd: string): Promise<Remote[] | ResolveReviewResult<never>> {
  const listed = await runText(exec, cwd, "git", ["remote"]);
  if (!listed.ok) {
    return { ok: false, error: `could not read git remotes: ${listed.error}` };
  }
  const names = parseLines(listed.data);
  if (names.length === 0) {
    return {
      ok: false,
      error:
        "no git remote is configured; add a remote or set an upstream before resolving review threads",
    };
  }

  const found: Remote[] = [];
  for (const name of names) {
    const url = await remoteUrl(exec, cwd, name);
    if (!url) continue;
    const host = hostFromRemoteUrl(url);
    const path = pathFromRemoteUrl(url);
    if (!host || !path) continue;
    found.push({ name, url, host, path, forge: detectForge(host) });
  }
  if (found.length === 0) {
    return {
      ok: false,
      error:
        "no git remote has a usable URL; set a fetch or push URL before resolving review threads",
    };
  }
  return found;
}

async function selectRemote(
  exec: RibExec,
  cwd: string,
): Promise<Remote | ResolveReviewResult<never>> {
  const all = await remotes(exec, cwd);
  if (!Array.isArray(all)) return all;

  const upstream = await configuredUpstreamRemote(exec, cwd);
  const upstreamRemote = upstream ? all.find((r) => r.name === upstream) : undefined;
  const selected =
    (upstreamRemote?.forge ? upstreamRemote : undefined) ??
    (all.length === 1 ? all[0] : (all.find((r) => r.forge) ?? all[0]));
  if (!selected) {
    return {
      ok: false,
      error:
        "no git remote is configured; add a remote or set an upstream before resolving review threads",
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

function classifyCliFailure(forge: Forge, action: string, error: string): string {
  if (/not found|no (pull request|merge request)|could not resolve|not.*associated/i.test(error)) {
    return `could not find the current branch's ${forge.noun}; open or check out the branch for the review, then retry`;
  }
  return `${forge.cli} failed while ${action}; install/authenticate ${forge.cli} and retry: ${error}`;
}

function parseJson<T>(text: string, context: string): ResolveReviewResult<T> {
  try {
    return { ok: true, data: JSON.parse(text) as T };
  } catch (e) {
    return { ok: false, error: `${context}: ${errText(e)}` };
  }
}

function githubOwnerRepo(remotePath: string): { owner: string; repo: string } | undefined {
  const parts = remotePath.split("/").filter(Boolean);
  if (parts.length < 2) return undefined;
  const owner = parts[parts.length - 2];
  const repo = parts[parts.length - 1];
  return owner && repo ? { owner, repo } : undefined;
}

function stableRef(prefix: "gh" | "gl", id: string): string {
  return `${prefix}:${id}`;
}

type GitHubPrView = { number?: number };
type GitHubThreads = {
  data?: {
    repository?: {
      pullRequest?: {
        reviewThreads?: {
          nodes?: Array<{
            id?: string;
            isResolved?: boolean;
            path?: string;
            line?: number | null;
            originalLine?: number | null;
            comments?: {
              nodes?: Array<{
                databaseId?: number | null;
                body?: string;
                author?: { login?: string | null } | null;
              }>;
            };
          }>;
        };
      } | null;
    } | null;
  };
};

type GitLabMrView = { iid?: number; id?: number };
type GitLabDiscussion = {
  id?: string;
  resolved?: boolean;
  notes?: Array<{
    id?: number;
    body?: string;
    system?: boolean;
    resolved?: boolean;
    author?: { username?: string; name?: string } | null;
    position?: {
      new_path?: string;
      old_path?: string;
      new_line?: number;
      old_line?: number;
    } | null;
  }>;
};

export async function fetchUnresolvedThreads(
  exec: RibExec,
  cwd: string,
): Promise<ResolveReviewResult<ReviewThread[]>> {
  try {
    const remote = await selectRemote(exec, cwd);
    if (!("name" in remote)) return remote;
    if (!remote.forge) {
      return {
        ok: false,
        error: `unsupported forge host "${remote.host}" for remote "${remote.name}"; use a GitHub/GitHub Enterprise or GitLab remote`,
      };
    }

    if (remote.forge.kind === "github") {
      const ownerRepo = githubOwnerRepo(remote.path);
      if (!ownerRepo) {
        return {
          ok: false,
          error: `could not derive GitHub owner/repo from remote "${remote.name}"`,
        };
      }
      const viewed = await runText(exec, cwd, "gh", ["pr", "view", "--json", "number"]);
      if (!viewed.ok)
        return {
          ok: false,
          error: classifyCliFailure(remote.forge, "finding the current pull request", viewed.error),
        };
      const pr = parseJson<GitHubPrView>(viewed.data, "could not parse gh pr view output");
      if (!pr.ok) return pr;
      if (typeof pr.data.number !== "number") {
        return { ok: false, error: "gh pr view did not return a pull request number" };
      }
      const query = `query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100){nodes{id isResolved path line originalLine comments(first:50){nodes{databaseId body author{login}}}}}}}}`;
      const fetched = await runText(exec, cwd, "gh", [
        "api",
        "graphql",
        "-f",
        `query=${query}`,
        "-F",
        `owner=${ownerRepo.owner}`,
        "-F",
        `repo=${ownerRepo.repo}`,
        "-F",
        `number=${pr.data.number}`,
      ]);
      if (!fetched.ok)
        return {
          ok: false,
          error: classifyCliFailure(remote.forge, "fetching review threads", fetched.error),
        };
      const parsed = parseJson<GitHubThreads>(
        fetched.data,
        "could not parse gh review thread output",
      );
      if (!parsed.ok) return parsed;
      const nodes =
        parsed.data.data?.repository?.pullRequest?.reviewThreads?.nodes?.filter(Boolean) ?? [];
      const threads: ReviewThread[] = [];
      for (const node of nodes) {
        if (node.isResolved) continue;
        const comments =
          node.comments?.nodes
            ?.filter((c) => typeof c?.body === "string")
            .map((c) => ({
              author: c.author?.login?.trim() || "unknown",
              body: c.body ?? "",
              databaseId: c.databaseId,
            })) ?? [];
        const first = comments[0];
        if (!node.id || !node.path || !first || typeof first.databaseId !== "number") continue;
        threads.push({
          forge: "github",
          threadRef: stableRef("gh", node.id),
          threadId: node.id,
          owner: ownerRepo.owner,
          repo: ownerRepo.repo,
          pullNumber: pr.data.number,
          firstCommentDatabaseId: first.databaseId,
          path: node.path,
          line: node.line ?? node.originalLine ?? 0,
          author: first.author,
          body: first.body,
          comments: comments.map(({ author, body }) => ({ author, body })),
        });
      }
      return { ok: true, data: threads };
    }

    const viewed = await runText(exec, cwd, "glab", [
      "mr",
      "view",
      "--output",
      "json",
      "--fields",
      "iid",
    ]);
    if (!viewed.ok)
      return {
        ok: false,
        error: classifyCliFailure(remote.forge, "finding the current merge request", viewed.error),
      };
    const mr = parseJson<GitLabMrView>(viewed.data, "could not parse glab mr view output");
    if (!mr.ok) return mr;
    const iid = typeof mr.data.iid === "number" ? mr.data.iid : mr.data.id;
    if (typeof iid !== "number")
      return { ok: false, error: "glab mr view did not return a merge request iid" };
    const projectPath = remote.path;
    const endpoint = `projects/${encodeURIComponent(projectPath)}/merge_requests/${iid}/discussions`;
    const fetched = await runText(exec, cwd, "glab", ["api", endpoint]);
    if (!fetched.ok)
      return {
        ok: false,
        error: classifyCliFailure(remote.forge, "fetching review discussions", fetched.error),
      };
    const parsed = parseJson<GitLabDiscussion[]>(
      fetched.data,
      "could not parse glab discussion output",
    );
    if (!parsed.ok) return parsed;
    const threads: ReviewThread[] = [];
    for (const discussion of parsed.data) {
      if (!discussion.id || discussion.resolved) continue;
      const notes = (discussion.notes ?? []).filter((n) => !n.system);
      if (notes.length === 0) continue;
      const first = notes[0];
      if (!first) continue;
      const path = first.position?.new_path ?? first.position?.old_path;
      const line = first.position?.new_line ?? first.position?.old_line ?? 0;
      threads.push({
        forge: "gitlab",
        threadRef: stableRef("gl", discussion.id),
        discussionId: discussion.id,
        projectPath,
        mergeRequestIid: iid,
        path,
        line,
        author: first.author?.username ?? first.author?.name ?? "unknown",
        body: first.body ?? "",
        comments: notes.map((n) => ({
          author: n.author?.username ?? n.author?.name ?? "unknown",
          body: n.body ?? "",
        })),
      });
    }
    return { ok: true, data: threads };
  } catch (e) {
    return { ok: false, error: `resolve review failed: ${errText(e)}` };
  }
}

export async function replyToThread(
  exec: RibExec,
  cwd: string,
  thread: ReviewThread,
  body: string,
): Promise<ResolveReviewResult<void>> {
  try {
    const result =
      thread.forge === "github"
        ? await runText(exec, cwd, "gh", [
            "api",
            `repos/${thread.owner}/${thread.repo}/pulls/${thread.pullNumber}/comments/${thread.firstCommentDatabaseId}/replies`,
            "--method",
            "POST",
            "-f",
            `body=${body}`,
          ])
        : await runText(exec, cwd, "glab", [
            "api",
            `projects/${encodeURIComponent(thread.projectPath)}/merge_requests/${thread.mergeRequestIid}/discussions/${thread.discussionId}/notes`,
            "--method",
            "POST",
            "-f",
            `body=${body}`,
          ]);
    if (result.ok) return { ok: true, data: undefined };
    const forge = thread.forge === "github" ? GITHUB_FORGE : GITLAB_FORGE;
    return {
      ok: false,
      error: classifyCliFailure(forge, "replying to a review thread", result.error),
    };
  } catch (e) {
    return { ok: false, error: `reply to review thread failed: ${errText(e)}` };
  }
}

export async function resolveThread(
  exec: RibExec,
  cwd: string,
  thread: ReviewThread,
): Promise<ResolveReviewResult<void>> {
  try {
    const result =
      thread.forge === "github"
        ? await runText(exec, cwd, "gh", [
            "api",
            "graphql",
            "-f",
            "query=mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{id isResolved}}}",
            "-f",
            `threadId=${thread.threadId}`,
          ])
        : await runText(exec, cwd, "glab", [
            "api",
            `projects/${encodeURIComponent(thread.projectPath)}/merge_requests/${thread.mergeRequestIid}/discussions/${thread.discussionId}`,
            "--method",
            "PUT",
            "-f",
            "resolved=true",
          ]);
    if (result.ok) return { ok: true, data: undefined };
    const forge = thread.forge === "github" ? GITHUB_FORGE : GITLAB_FORGE;
    return {
      ok: false,
      error: classifyCliFailure(forge, "resolving a review thread", result.error),
    };
  } catch (e) {
    return { ok: false, error: `resolve review thread failed: ${errText(e)}` };
  }
}
