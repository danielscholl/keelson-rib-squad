import type { CoordinatorLedger } from "./coordinator.ts";
import type {
  RollbackCommit,
  RollbackPerformedRow,
  RollbackRefusalReason,
} from "./rollback-store.ts";

export interface RollbackGitExec {
  runGit(args: string[]): Promise<{ ok: true; data: string } | { ok: false; error: string }>;
  pathExists(path: string): Promise<boolean>;
}

export type RollbackPlan =
  | { type: "performed"; manifest: Omit<RollbackPerformedRow, "type" | "runId" | "at"> }
  | { type: "refused"; reason: RollbackRefusalReason; observedHead: string }
  | { type: "noop"; preRollbackHead: string; preRollbackTree: string };

function splitLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function splitNul(text: string): string[] {
  return text
    .split("\0")
    .filter((part) => part.length > 0)
    .sort();
}

function isRollbackableStatus(status: CoordinatorLedger["status"]): boolean {
  return (
    status === "aborted" || status === "verification-failed" || status === "change-quality-failed"
  );
}

async function git(exec: RollbackGitExec, args: string[]): Promise<string> {
  const result = await exec.runGit(args);
  if (!result.ok) throw new Error(`git ${args.join(" ")} failed: ${result.error}`);
  return result.data;
}

async function captureHead(exec: RollbackGitExec): Promise<{ head: string; tree: string }> {
  const head = (await git(exec, ["rev-parse", "HEAD"])).trim();
  const tree = (await git(exec, ["rev-parse", "HEAD^{tree}"])).trim();
  if (!head) throw new Error("git rev-parse HEAD returned an empty ref");
  if (!tree) throw new Error("git rev-parse HEAD^{tree} returned an empty tree");
  return { head, tree };
}

async function hasMergeOrRebaseInProgress(exec: RollbackGitExec): Promise<boolean> {
  const mergeHead = await exec.runGit(["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
  if (mergeHead.ok && mergeHead.data.trim()) return true;
  const rebaseMerge = (await git(exec, ["rev-parse", "--git-path", "rebase-merge"])).trim();
  if (rebaseMerge && (await exec.pathExists(rebaseMerge))) return true;
  const rebaseApply = (await git(exec, ["rev-parse", "--git-path", "rebase-apply"])).trim();
  return Boolean(rebaseApply && (await exec.pathExists(rebaseApply)));
}

async function commitsToRewind(
  exec: RollbackGitExec,
  baselineHeadSha: string,
): Promise<RollbackCommit[]> {
  const range = `${baselineHeadSha}..HEAD`;
  const shas = splitLines(await git(exec, ["rev-list", "--reverse", range]));
  const commits: RollbackCommit[] = [];
  for (const sha of shas) {
    const raw = await git(exec, ["log", "-n", "1", "--format=%h%x00%s", sha]);
    const [shortSha, subject] = raw.replace(/\n$/, "").split("\0");
    if (shortSha) commits.push({ sha: shortSha, subject: subject ?? "" });
  }
  return commits;
}

export async function computeRollbackPlan(
  ledger: Pick<CoordinatorLedger, "baselineTree" | "baselineHeadSha" | "status">,
  exec: RollbackGitExec,
): Promise<RollbackPlan> {
  const { head: preRollbackHead, tree: preRollbackTree } = await captureHead(exec);
  if (!ledger.baselineTree || !ledger.baselineHeadSha || !isRollbackableStatus(ledger.status)) {
    return { type: "refused", reason: "run-not-rollbackable", observedHead: preRollbackHead };
  }
  const ancestor = await exec.runGit([
    "merge-base",
    "--is-ancestor",
    ledger.baselineHeadSha,
    "HEAD",
  ]);
  if (!ancestor.ok) {
    return { type: "refused", reason: "head-rewritten", observedHead: preRollbackHead };
  }
  if (await hasMergeOrRebaseInProgress(exec)) {
    return { type: "refused", reason: "merge-in-progress", observedHead: preRollbackHead };
  }

  const revertedCommits = await commitsToRewind(exec, ledger.baselineHeadSha);
  const revertedPaths = splitNul(
    await git(exec, [
      "diff-tree",
      "-r",
      "-z",
      "--diff-filter=DMRT",
      "--name-only",
      ledger.baselineTree,
      preRollbackTree,
    ]),
  );
  const deletedPaths = splitNul(
    await git(exec, [
      "diff-tree",
      "-r",
      "-z",
      "--diff-filter=A",
      "--name-only",
      ledger.baselineTree,
      preRollbackTree,
    ]),
  );
  if (revertedCommits.length === 0 && revertedPaths.length === 0 && deletedPaths.length === 0) {
    return { type: "noop", preRollbackHead, preRollbackTree };
  }
  return {
    type: "performed",
    manifest: {
      preRollbackTree,
      preRollbackHead,
      rollbackRef: ledger.baselineHeadSha,
      baselineTree: ledger.baselineTree,
      baselineHeadSha: ledger.baselineHeadSha,
      revertedCommits,
      revertedPaths,
      deletedPaths,
    },
  };
}
