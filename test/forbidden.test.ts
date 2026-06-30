import { describe, expect, test } from "bun:test";
import { isForbiddenGitCommand, isMergeToolName } from "../src/forbidden.ts";

describe("isForbiddenGitCommand — force-push", () => {
  test("denies every force-push form the flat regex once missed", () => {
    for (const cmd of [
      "git push --force",
      "git push -f origin main",
      "git push -fv origin main", // bundled short flags
      "git push -uf origin main",
      "git push --force-with-lease",
      "git push --force-with-lease=origin/main",
      "git -C /repo push --force", // global option before the subcommand
      "git -c user.name=x push --force",
      "git push origin +main", // forced refspec, no flag at all
      "git push origin +HEAD:refs/heads/main",
      "GIT_DIR=/x git push --force", // leading env assignment
      "GIT_DIR=/x ! git push --force", // env assignment THEN a grouping token (interleaved)
      "VAR=1 { git push --force; }", // env assignment THEN a brace group
      "! GIT_DIR=/x git push --force", // grouping token THEN an env assignment
      "cd /tmp && git push --force", // chained
      "echo hi; git push -f", // chained on ;
    ]) {
      expect(isForbiddenGitCommand(cmd)).toBe(true);
    }
  });
});

describe("isForbiddenGitCommand — remote-branch deletion", () => {
  test("denies delete forms", () => {
    for (const cmd of [
      "git push origin --delete main",
      "git push origin :main", // empty-source delete refspec
      "git push -d origin main",
      "git push --mirror origin",
    ]) {
      expect(isForbiddenGitCommand(cmd)).toBe(true);
    }
  });
});

describe("isForbiddenGitCommand — gh self-merge", () => {
  test("denies gh pr merge and the REST equivalent", () => {
    for (const cmd of [
      "gh pr merge 1",
      "gh pr merge --squash 42",
      "gh api repos/o/r/pulls/1/merge -X PUT",
      "gh api --method PUT repos/o/r/pulls/1/merge",
      "gh api repos/o/r/pulls/1/merge -f merge_method=squash", // field flag implies POST
    ]) {
      expect(isForbiddenGitCommand(cmd)).toBe(true);
    }
  });
});

describe("isForbiddenGitCommand — subshell / brace grouping", () => {
  test("denies a forbidden op wrapped in a subshell or brace group", () => {
    for (const cmd of [
      "( git push --force )", // subshell
      "( git push -f origin main )",
      "{ git push --force; }", // brace group
      "{ git push -f origin main ; }",
      "( gh pr merge 1 )",
    ]) {
      expect(isForbiddenGitCommand(cmd)).toBe(true);
    }
  });
});

describe("isForbiddenGitCommand — command substitution must not mask a force-push", () => {
  test("a `$(...)` in the args does not hide the surrounding force-push", () => {
    // Parens are NOT split boundaries (splitting mid-`$(...)` would tear the force flag into
    // its own segment and let the push slip past) — these must stay blocked.
    for (const cmd of [
      "git push origin $(git symbolic-ref --short HEAD) --force",
      'git -C "$(git rev-parse --show-toplevel)" push --force',
    ]) {
      expect(isForbiddenGitCommand(cmd)).toBe(true);
    }
  });
});

describe("isForbiddenGitCommand — gh GraphQL self-merge", () => {
  test("denies the mergePullRequest / enablePullRequestAutoMerge mutations", () => {
    for (const cmd of [
      `gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: "x"}) { clientMutationId } }'`,
      `gh api graphql -f query='mutation Foo($id: ID!) { enablePullRequestAutoMerge(input: {pullRequestId: $id}) { actor { login } } }'`,
    ]) {
      expect(isForbiddenGitCommand(cmd)).toBe(true);
    }
  });
});

describe("isForbiddenGitCommand — allowed (ordinary) ops are NOT denied", () => {
  test("ordinary pushes, commits, PR creation, and reads pass", () => {
    for (const cmd of [
      "git push", // ordinary push — the dev loop ends in a draft PR, not a merge
      "git push origin main",
      "git push -u origin feature", // set-upstream
      "git push --set-upstream origin feature",
      "git push origin main:main", // normal (non-forced) refspec
      "git commit -m 'wip'",
      "git commit -m '(wip)'", // parens inside a quoted arg must not look like a subshell
      "git status",
      "(ls -la)", // a benign subshell stays allowed
      "! git push origin main", // a non-force push, negated, is still an ordinary push
      "gh pr create --fill",
      "gh api repos/o/r/pulls/1", // GET, no /merge
      "gh api repos/o/r/pulls/1/merge", // bare GET on the merge endpoint (checks status)
      `gh api graphql -f query='query { repository(owner:"o",name:"r") { id } }'`, // a read query
      // The GraphQL gate is segment-scoped, so merely MENTIONING the mutation in a commit
      // message or PR/issue body must not block these ordinary ops.
      'git commit -m "refactor gh api graphql mergePullRequest helper"',
      'gh pr create --title "Add mergePullRequest detector" --body "blocks gh api graphql mergePullRequest"',
      'gh issue comment 5 --body "do not call mergePullRequest via gh api graphql"',
    ]) {
      expect(isForbiddenGitCommand(cmd)).toBe(false);
    }
  });
});

describe("isMergeToolName", () => {
  test("matches normalized merge tool names", () => {
    for (const name of [
      "merge_pr",
      "gh_pr_merge",
      "gh-pr-merge",
      "mergePR",
      "merge_pull_request",
    ]) {
      expect(isMergeToolName(name)).toBe(true);
    }
  });
  test("does not match read/other tools", () => {
    for (const name of ["list_prs", "get_pr", "Bash", "create_pr", "git_status"]) {
      expect(isMergeToolName(name)).toBe(false);
    }
  });
});
