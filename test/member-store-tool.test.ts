import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RibContext, ToolDefinition } from "@keelson/shared";
import rib from "../src/index.ts";
import { readMembers } from "../src/member-store.ts";
import { scopeMembersDir, setSquadDataHome } from "../src/paths.ts";
import { writeSelectedProject } from "../src/scope.ts";

let home: string;
let refreshed: string[];

function project(id: string, name: string, rootPath: string) {
  return { id, name, rootPath, createdAt: "2026-06-27T00:00:00.000Z" };
}

function bootTools(projects: ReturnType<typeof project>[]): readonly ToolDefinition[] {
  const ctx = {
    getDataDir: () => home,
    getProjects: () => projects,
    refreshWorkflow: async (name: string) => {
      refreshed.push(name);
    },
  } as unknown as RibContext;
  return rib.registerTools?.(ctx) ?? [];
}

function tool(tools: readonly ToolDefinition[], name: string): ToolDefinition {
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`${name} not registered`);
  return found;
}

async function invoke(
  t: ToolDefinition,
  input: unknown,
): Promise<{ content: string; isError: boolean }> {
  let content = "";
  let isError = false;
  await t.execute(input, {
    emit: (e: { type?: string; content?: string; isError?: boolean }) => {
      content = e.content ?? "";
      isError = Boolean(e.isError);
    },
  } as never);
  return { content, isError };
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "squad-member-tools-"));
  refreshed = [];
});

afterEach(async () => {
  rib.dispose?.();
  setSquadDataHome(undefined);
  await rm(home, { recursive: true, force: true });
});

describe("member store tools", () => {
  test("emit and list honor an explicit project scope", async () => {
    const tools = bootTools([project("alpha", "alpha", "/repo/alpha")]);

    const emitted = await invoke(tool(tools, "squad_emit_member"), {
      name: "Atlas",
      role: "Engineer",
      charter: "# Atlas",
      project: "alpha",
    });
    const listed = await invoke(tool(tools, "squad_list_members"), { project: "alpha" });
    const parsed = JSON.parse(listed.content) as { members: { slug: string; name: string }[] };

    expect(emitted.isError).toBe(false);
    expect(listed.isError).toBe(false);
    const atlas = JSON.parse(emitted.content) as { slug: string };
    expect(parsed.members).toEqual([expect.objectContaining({ slug: atlas.slug })]);
    expect(await readMembers(scopeMembersDir(home, "default"))).toEqual([]);
    expect(refreshed).toContain("squad-roster");
  });

  test("emit round-trips tool allowlists and normalizes empty lists to absent", async () => {
    const tools = bootTools([project("alpha", "alpha", "/repo/alpha")]);

    const emittedAtlas = await invoke(tool(tools, "squad_emit_member"), {
      name: "Atlas",
      role: "Engineer",
      charter: "# Atlas",
      project: "alpha",
      toolAllowlist: ["osdu_quality", " osdu_quality ", ""],
    });
    const emittedBeacon = await invoke(tool(tools, "squad_emit_member"), {
      name: "Beacon",
      role: "Reviewer",
      charter: "# Beacon",
      project: "alpha",
      toolAllowlist: [],
    });

    const atlas = JSON.parse(emittedAtlas.content) as { slug: string };
    const beacon = JSON.parse(emittedBeacon.content) as { slug: string };
    const members = await readMembers(scopeMembersDir(home, "alpha"));
    expect(members.find((m) => m.slug === atlas.slug)?.toolAllowlist).toEqual(["osdu_quality"]);
    expect(members.find((m) => m.slug === beacon.slug)?.toolAllowlist).toBeUndefined();
  });

  test("emit and list without project use the selected scope", async () => {
    await writeSelectedProject(home, {
      scopeId: "beta",
      projectId: "beta",
      name: "beta",
      rootPath: "/repo/beta",
      at: "2026-06-30T00:00:00.000Z",
    });
    const tools = bootTools([project("beta", "beta", "/repo/beta")]);

    const emitted = await invoke(tool(tools, "squad_emit_member"), {
      name: "Beacon",
      role: "Reviewer",
      charter: "# Beacon",
    });
    const listed = await invoke(tool(tools, "squad_list_members"), {});
    const parsed = JSON.parse(listed.content) as { members: { slug: string; name: string }[] };

    expect(listed.isError).toBe(false);
    const beacon = JSON.parse(emitted.content) as { slug: string };
    expect(parsed.members).toEqual([expect.objectContaining({ slug: beacon.slug })]);
    expect(await readMembers(scopeMembersDir(home, "beta"))).toHaveLength(1);
  });

  test("bad explicit projects fail instead of falling back to the selected scope", async () => {
    const tools = bootTools([project("alpha", "alpha", "/repo/alpha")]);

    const emitted = await invoke(tool(tools, "squad_emit_member"), {
      name: "Ghost",
      role: "Engineer",
      charter: "# Ghost",
      project: "missing",
    });
    const listed = await invoke(tool(tools, "squad_list_members"), { project: "missing" });

    expect(emitted.isError).toBe(true);
    expect(emitted.content).toContain("unknown project");
    expect(listed.isError).toBe(true);
    expect(listed.content).toContain("unknown project");
    expect(await readMembers(scopeMembersDir(home, "default"))).toEqual([]);
  });

  test("retire honors an explicit project scope", async () => {
    const tools = bootTools([
      project("alpha", "alpha", "/repo/alpha"),
      project("beta", "beta", "/repo/beta"),
    ]);
    const emittedAlpha = await invoke(tool(tools, "squad_emit_member"), {
      name: "Atlas",
      role: "Engineer",
      charter: "# Atlas",
      project: "alpha",
    });
    const alpha = JSON.parse(emittedAlpha.content) as { slug: string };
    const emittedBeta = await invoke(tool(tools, "squad_emit_member"), {
      name: "Beacon",
      role: "Reviewer",
      charter: "# Beacon",
      project: "beta",
    });
    const beta = JSON.parse(emittedBeta.content) as { slug: string };

    const retired = await invoke(tool(tools, "squad_retire_member"), {
      slug: alpha.slug,
      project: "alpha",
    });

    expect(retired.isError).toBe(false);
    expect(await readMembers(scopeMembersDir(home, "alpha"))).toEqual([]);
    expect(await readMembers(scopeMembersDir(home, "beta"))).toEqual([
      expect.objectContaining({ slug: beta.slug }),
    ]);
  });
});
