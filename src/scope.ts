import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_SCOPE_ID, scopeMembersDir } from "./paths.ts";

// The operator's current project selection and a snapshot of the project catalog,
// both persisted at the GLOBAL home root (NOT a scoped subtree) so the
// out-of-process collectors can reach them through argv[2] without resolving a
// scope first. The selection's scopeId is the indirection every squad data path
// keys on; absent/corrupt degrades to the DEFAULT_SCOPE_ID sentinel, so an
// unselected harness behaves exactly as the legacy flat layout.

export interface SelectedProject {
  scopeId: string;
  projectId?: string;
  name?: string;
  rootPath?: string;
  at: string;
}

const SELECTED_FILE = "selected-project.json";
const PROJECTS_FILE = "projects.json";

export async function writeSelectedProject(home: string, sel: SelectedProject): Promise<void> {
  await mkdir(home, { recursive: true });
  await writeFile(join(home, SELECTED_FILE), `${JSON.stringify(sel, null, 2)}\n`);
}

// Read the persisted selection back, or undefined when there is none / it is
// unreadable / it fails validation — so a corrupt file reads as "no selection"
// (the default scope) rather than crashing a collector or a handler.
export async function readSelectedProject(home: string): Promise<SelectedProject | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(home, SELECTED_FILE), "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<SelectedProject>;
    if (typeof parsed !== "object" || parsed === null) return undefined;
    if (typeof parsed.scopeId !== "string" || !parsed.scopeId) return undefined;
    return {
      scopeId: parsed.scopeId,
      ...(typeof parsed.projectId === "string" && parsed.projectId
        ? { projectId: parsed.projectId }
        : {}),
      ...(typeof parsed.name === "string" && parsed.name ? { name: parsed.name } : {}),
      ...(typeof parsed.rootPath === "string" && parsed.rootPath
        ? { rootPath: parsed.rootPath }
        : {}),
      at: typeof parsed.at === "string" ? parsed.at : "",
    };
  } catch {
    return undefined;
  }
}

export async function clearSelectedProject(home: string): Promise<void> {
  await rm(join(home, SELECTED_FILE), { force: true });
}

export function selectedScopeId(sel: SelectedProject | undefined): string {
  return sel?.scopeId ?? DEFAULT_SCOPE_ID;
}

export interface ProjectsSnapshot {
  projects: { id: string; name: string }[];
  at: string;
}

export async function writeProjectsSnapshot(
  home: string,
  projects: readonly { id: string; name: string }[],
): Promise<void> {
  await mkdir(home, { recursive: true });
  const snapshot: ProjectsSnapshot = {
    projects: projects.map((p) => ({ id: p.id, name: p.name })),
    at: new Date().toISOString(),
  };
  await writeFile(join(home, PROJECTS_FILE), `${JSON.stringify(snapshot, null, 2)}\n`);
}

// Every scope's members dir: the default (legacy flat) dir FIRST, then one per
// existing projects/<seg> subtree SORTED by segment name, so a cross-scope reader
// (chat agents) sees a deterministic order (default wins ties on slug). Degrades to
// just the default dir when there is no projects/ tree yet. The segments are
// already-sanitized on disk, so they are read back verbatim (not re-derived).
export async function listScopeMembersDirs(home: string): Promise<string[]> {
  const dirs = [scopeMembersDir(home, DEFAULT_SCOPE_ID)];
  try {
    const segments = (await readdir(join(home, "projects"), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const seg of segments) dirs.push(join(home, "projects", seg, "members"));
  } catch {
    // no projects/ tree yet — just the default scope
  }
  return dirs;
}

export async function readProjectsSnapshot(home: string): Promise<{ id: string; name: string }[]> {
  let raw: string;
  try {
    raw = await readFile(join(home, PROJECTS_FILE), "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ProjectsSnapshot>;
    if (typeof parsed !== "object" || parsed === null || !Array.isArray(parsed.projects)) return [];
    return parsed.projects
      .filter(
        (p): p is { id: string; name: string } =>
          typeof p === "object" &&
          p !== null &&
          typeof (p as { id: unknown }).id === "string" &&
          typeof (p as { name: unknown }).name === "string",
      )
      .map((p) => ({ id: p.id, name: p.name }));
  } catch {
    return [];
  }
}
