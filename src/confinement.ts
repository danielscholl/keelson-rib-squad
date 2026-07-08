import type { RibExec } from "@keelson/shared";

export interface DeleteConfinementResult {
  ok: boolean;
  restored: string[];
  error?: string;
}

function splitNul(text: string): string[] {
  return text
    .split("\0")
    .filter((part) => part.length > 0)
    .sort();
}

async function listTreePaths(
  exec: RibExec,
  cwd: string,
  tree: string,
): Promise<{ ok: true; paths: Set<string> } | { ok: false; error: string }> {
  const result = await exec.runText("git", ["ls-tree", "-r", "--name-only", "-z", tree], { cwd });
  return result.ok
    ? { ok: true, paths: new Set(splitNul(result.data)) }
    : { ok: false, error: result.error };
}

export async function confineBaselineDeletes(
  exec: RibExec,
  cwd: string,
  baselineTree: string,
  currentTree: string,
): Promise<DeleteConfinementResult> {
  const [baseline, current] = await Promise.all([
    listTreePaths(exec, cwd, baselineTree),
    listTreePaths(exec, cwd, currentTree),
  ]);
  if (!baseline.ok) return { ok: false, restored: [], error: baseline.error };
  if (!current.ok) return { ok: false, restored: [], error: current.error };

  const deleted = [...baseline.paths].filter((path) => !current.paths.has(path)).sort();
  const restored: string[] = [];
  for (const path of deleted) {
    const result = await exec.runText("git", ["restore", "--source", baselineTree, "--", path], {
      cwd,
    });
    if (!result.ok) {
      return {
        ok: false,
        restored,
        error: `git restore ${path} failed: ${result.error}`,
      };
    }
    restored.push(path);
  }
  return { ok: true, restored };
}
