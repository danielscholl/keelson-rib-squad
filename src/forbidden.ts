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
// --force` is seen as two commands and the second is gated.
export function splitShellCommands(cmd: string): string[][] {
  return cmd
    .split(/\n|;|\|\||&&|\||&/)
    .map(tokenizeArgv)
    .filter((argv) => argv.length > 0);
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
    // Drop leading `VAR=value` env assignments (e.g. `GIT_DIR=… git push`).
    let i = 0;
    while (i < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i] ?? "")) i++;
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
// method (an explicit PUT/POST/PATCH, or a field flag that implies POST).
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
  }
  return false;
}
