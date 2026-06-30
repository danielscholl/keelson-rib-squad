// The irreversible git/PR operations the squad RAI floor forbids from any squad
// agent turn — merging a PR and rewriting history (force-push), plus the destructive
// remote-branch deletions in the same family. A flat regex over the raw command was
// trivially evaded (bundled short flags `-fv`, a `git -C dir push --force` global
// option before the subcommand, a forced refspec `+main` with no flag at all, a REST
// self-merge via `gh api`), so detection tokenizes the command instead and gates the
// resolved subcommand. It errs toward over-matching: a false positive blocks one
// irreversible op; a false negative is a history rewrite or self-merge past the floor.

// Named merge tools a provider may expose as first-class tool calls — matched on the
// normalized name so `gh_pr_merge`, `merge-pr`, `mergePR` all resolve the same.
const MERGE_TOOL_NAMES = new Set(["mergepr", "ghprmerge", "ghmerge", "mergepullrequest"]);

export function isMergeToolName(tool: string): boolean {
  return MERGE_TOOL_NAMES.has(tool.toLowerCase().replace(/[^a-z]/g, ""));
}

// Split a command line into command segments (on the operators that begin a new
// command) and each segment into argv tokens (stripping simple quoting). Not a full
// shell parser — deliberately conservative for a security denylist, so `a && git push
// --force` is seen as two commands and the second is gated. Parens are NOT split here:
// splitting on them mid-`$(…)` tore a real `git push … $(…) … --force` apart and let it
// pass, so a spaced subshell `( git push --force )` is handled by skipping the standalone
// `(`/`)` grouping tokens instead (see isGroupingToken).
export function splitShellCommands(cmd: string): string[][] {
  return cmd
    .split(/\n|;|\|\||&&|\||&/)
    .map(tokenizeArgv)
    .filter((argv) => argv.length > 0);
}

// Leading shell grouping / negation tokens that wrap a command without changing which
// command runs: a subshell `( … )`, a brace group `{ …; }`, or a `!` negation. Skipped so
// the real command (`( git push --force )`, `{ git push --force; }`) isn't masked behind them.
function isGroupingToken(t: string): boolean {
  return t === "{" || t === "}" || t === "(" || t === ")" || t === "!";
}

function tokenizeArgv(segment: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec drain loop.
  while ((m = re.exec(segment)) !== null) {
    tokens.push(m[1] ?? m[2] ?? m[3] ?? "");
  }
  return tokens;
}

// True when ANY command in the line is a forbidden git/gh integration op.
export function isForbiddenGitCommand(raw: string): boolean {
  for (const argv of splitShellCommands(raw)) {
    // Skip any leading run of shell grouping/negation tokens (`( … )`, `{ …; }`, `! …`) and
    // `VAR=value` env assignments, in ANY order, so an interleaving like `GIT_DIR=/x ! git push`
    // can't mask the real command behind whichever wrapper happens to come second.
    let i = 0;
    while (i < argv.length) {
      const t = argv[i] ?? "";
      if (isGroupingToken(t) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
        i++;
        continue;
      }
      break;
    }
    const cmd = argv[i];
    const rest = argv.slice(i + 1);
    if (cmd === "git" && isForbiddenGitArgs(rest)) return true;
    if (cmd === "gh" && isForbiddenGhArgs(rest)) return true;
  }
  return false;
}

// After `git`, skip the global options (`-C dir`, `-c k=v`, `--git-dir=…`, `-P`, …)
// that can sit before the subcommand, then gate `push`.
function isForbiddenGitArgs(args: string[]): boolean {
  let i = 0;
  while (i < args.length) {
    const t = args[i] ?? "";
    if (
      t === "-C" ||
      t === "-c" ||
      t === "--git-dir" ||
      t === "--work-tree" ||
      t === "--namespace"
    ) {
      i += 2; // option takes a separate-token value
      continue;
    }
    if (t.startsWith("-")) {
      i += 1; // `--git-dir=…`, `-P`, `--no-pager`, or an unknown global flag
      continue;
    }
    break;
  }
  if (args[i] !== "push") return false;
  return isForbiddenPush(args.slice(i + 1));
}

// A push is forbidden when it rewrites history or deletes a remote ref: an explicit
// force flag, a force/delete short-flag cluster (`-f`, `-fv`, `-uf`, `-d`), `--mirror`,
// a forced refspec (`+src:dst`), or a delete refspec (`:dst`, empty source).
function isForbiddenPush(pushArgs: string[]): boolean {
  for (const t of pushArgs) {
    if (t === "--force" || t === "--force-with-lease" || t.startsWith("--force-with-lease=")) {
      return true;
    }
    if (t === "--delete" || t === "--mirror") return true;
    if (/^-[a-z]+$/i.test(t) && (t.includes("f") || t.includes("d"))) return true;
    if (t.startsWith("+") || t.startsWith(":")) return true;
  }
  return false;
}

// `gh pr merge …` and its REST equivalent `gh api … pulls/<n>/merge` with a write
// method (an explicit PUT/POST/PATCH, or a field flag that implies POST), plus the GraphQL
// `mergePullRequest` / `enablePullRequestAutoMerge` mutations. Gated at the SEGMENT level (the
// resolved command really is `gh api`), not by token presence on the raw line, so a `git commit`
// or `gh pr create` whose message/body merely mentions the mutation is not falsely blocked.
function isForbiddenGhArgs(args: string[]): boolean {
  if (args[0] === "pr" && args[1] === "merge") return true;
  if (args[0] === "api") {
    const joined = args.join(" ");
    if (/pulls\/[^/\s]+\/merge\b/i.test(joined)) {
      if (/(?:-X|--method)[=\s]+(?:PUT|POST|PATCH)\b/i.test(joined)) return true;
      if (args.some((a) => a === "-f" || a === "--field" || a === "-F" || a === "--raw-field")) {
        return true;
      }
    }
    // A graphql call (`gh api graphql …`) carrying a merge/auto-merge mutation — the inline
    // query value tokenizes so `mergePullRequest(...` lands among the args.
    if (
      args.includes("graphql") &&
      /\b(?:mergePullRequest|enablePullRequestAutoMerge)\b/i.test(joined)
    ) {
      return true;
    }
  }
  return false;
}
