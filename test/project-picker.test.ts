import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  MessageChunk,
  RibAgentTurn,
  RibAgentTurnRequest,
  RibContext,
  ToolContext,
  ToolDefinition,
} from "@keelson/shared";
import { loadLedger } from "../src/coordinator.ts";
import rib from "../src/index.ts";
import { type MemberRecord, scaffoldMember } from "../src/member-store.ts";
import { scopeDataHome, scopeMembersDir, setSquadDataHome } from "../src/paths.ts";
import { readProjectsSnapshot, readSelectedProject, writeSelectedProject } from "../src/scope.ts";

// A manager reply that ends the coordinator loop after one round, no dispatch.
const DONE_REPLY = 'ok\n{"action":"done","summary":"finished it"}';

async function* oneShot(): AsyncGenerator<MessageChunk> {
  yield { type: "done" };
}

function project(id: string, name: string, rootPath: string) {
  return { id, name, rootPath, createdAt: "2026-06-27T00:00:00.000Z" };
}

const memberRecord = (over: {
  slug: string;
  name: string;
  tools?: readonly string[];
}): MemberRecord => ({
  slug: over.slug,
  name: over.name,
  role: "Engineer",
  charter: `# ${over.name}\n\n## Role\n\nBuilds.`,
  status: "active",
  createdAt: "2026-06-27T00:00:00.000Z",
  tools: [...(over.tools ?? ["read"])],
});

let home: string;
let refreshed: string[];

function boot(
  projects: ReturnType<typeof project>[],
  reply = DONE_REPLY,
): readonly ToolDefinition[] {
  const ctx = {
    getExec: () => ({
      runJSON: async () => ({ ok: true as const, data: undefined }),
      runText: async () => ({ ok: true as const, data: "" }),
    }),
    getDataDir: () => home,
    getProjects: () => projects,
    runAgentTurn: (_r: RibAgentTurnRequest): RibAgentTurn => ({
      stream: oneShot(),
      result: Promise.resolve({ status: "ok" as const, text: reply }),
    }),
    refreshWorkflow: async (name: string) => {
      refreshed.push(name);
    },
  } as unknown as RibContext;
  return rib.registerTools?.(ctx) ?? [];
}

function capture(): { ctx: ToolContext; out: () => { content: string; isError: boolean } } {
  let content = "";
  let isError = false;
  const ctx = {
    emit: (e: { type: string; content?: string; isError?: boolean }) => {
      if (e.type === "tool_result") {
        content = e.content ?? "";
        isError = Boolean(e.isError);
      }
    },
  } as unknown as ToolContext;
  return { ctx, out: () => ({ content, isError }) };
}

function coordinateTool(tools: readonly ToolDefinition[]): ToolDefinition {
  const t = tools.find((x) => x.name === "squad_coordinate");
  if (!t) throw new Error("squad_coordinate not registered");
  return t;
}

function codeTool(tools: readonly ToolDefinition[]): ToolDefinition {
  const t = tools.find((x) => x.name === "squad_code");
  if (!t) throw new Error("squad_code not registered");
  return t;
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "squad-picker-"));
  refreshed = [];
});
afterEach(async () => {
  rib.dispose?.();
  setSquadDataHome(undefined);
  await rm(home, { recursive: true, force: true });
});

describe("select-project action", () => {
  test("a valid id persists the selection, rewrites projects.json, and refreshes three panels", async () => {
    boot([project("alpha", "alpha", "/repo/alpha"), project("beta", "beta", "/repo/beta")]);
    const res = await rib.onAction?.(
      { type: "select-project", payload: { scopeId: "alpha" } },
      {} as RibContext,
    );
    expect(res?.ok).toBe(true);
    if (res?.ok) expect(res.data).toEqual({ scopeId: "alpha" });

    const sel = await readSelectedProject(home);
    expect(sel?.scopeId).toBe("alpha");
    expect(sel?.projectId).toBe("alpha");
    expect(sel?.rootPath).toBe("/repo/alpha");
    expect(await readProjectsSnapshot(home)).toEqual([
      { id: "alpha", name: "alpha" },
      { id: "beta", name: "beta" },
    ]);
    expect(refreshed).toEqual(
      expect.arrayContaining(["squad-roster", "squad-cast", "squad-coordinator"]),
    );
  });

  test("an unknown id fails closed and writes no selection", async () => {
    boot([project("alpha", "alpha", "/repo/alpha")]);
    const res = await rib.onAction?.(
      { type: "select-project", payload: { scopeId: "ghost" } },
      {} as RibContext,
    );
    expect(res?.ok).toBe(false);
    if (res && !res.ok) expect(res.error).toContain("unknown project");
    expect(await readSelectedProject(home)).toBeUndefined();
  });

  test('"default" writes the default selection', async () => {
    boot([project("alpha", "alpha", "/repo/alpha")]);
    const res = await rib.onAction?.(
      { type: "select-project", payload: { scopeId: "default" } },
      {} as RibContext,
    );
    expect(res?.ok).toBe(true);
    expect((await readSelectedProject(home))?.scopeId).toBe("default");
  });
});

describe("squad_coordinate binds the selected project (live-demo regression)", () => {
  const projects = () => [
    project("alpha", "alpha", "/repo/alpha"),
    project("beta", "beta", "/repo/beta"),
  ];

  test("no explicit project + a selection binds the run to that project's scope, team, and repo", async () => {
    const tools = boot(projects());
    // The alpha team lives under projects/alpha/members — NOT the default scope.
    await scaffoldMember(
      scopeMembersDir(home, "alpha"),
      memberRecord({ slug: "atlas", name: "Atlas" }),
    );
    await writeSelectedProject(home, {
      scopeId: "alpha",
      projectId: "alpha",
      name: "alpha",
      rootPath: "/repo/alpha",
      at: "2026-06-27T00:00:00.000Z",
    });

    const { ctx, out } = capture();
    await coordinateTool(tools).execute({ task: "ship it" }, ctx);

    // The run found the alpha-scope team and completed (not "no matching active members").
    expect(out().isError).toBe(false);
    expect(out().content).toContain("done");
    // The ledger landed under alpha's scope, bound to project alpha (proves dataHome +
    // project: X were both routed to the resolved selection).
    const ledger = await loadLedger(scopeDataHome(home, "alpha"));
    expect(ledger?.projectId).toBe("alpha");
    // Nothing leaked to the default scope.
    expect(await loadLedger(home)).toBeUndefined();
  });

  test("no explicit project + no selection runs reasoning-only on the default scope", async () => {
    const tools = boot(projects());
    // The default-scope team; no selection + ambiguous projects → no project bound.
    await scaffoldMember(
      scopeMembersDir(home, "default"),
      memberRecord({ slug: "atlas", name: "Atlas" }),
    );

    const { ctx, out } = capture();
    await coordinateTool(tools).execute({ task: "ship it" }, ctx);

    expect(out().isError).toBe(false);
    expect(out().content).toContain("done");
    const ledger = await loadLedger(home);
    expect(ledger).toBeDefined();
    expect(ledger?.projectId).toBeUndefined();
    expect(await loadLedger(scopeDataHome(home, "alpha"))).toBeUndefined();
  });

  test("SINGLE project, no selection, no arg → reasoning-only on DEFAULT (no auto-pick regression)", async () => {
    // The bug this guards: the old auto-pick bound a no-arg run to the sole project's
    // own (empty) scope, regressing a default-scope team to "no matching active members".
    const tools = boot([project("solo", "solo", "/repo/solo")]);
    await scaffoldMember(
      scopeMembersDir(home, "default"),
      memberRecord({ slug: "atlas", name: "Atlas" }),
    );

    const { ctx, out } = capture();
    await coordinateTool(tools).execute({ task: "ship it" }, ctx);

    expect(out().isError).toBe(false);
    expect(out().content).toContain("done");
    // The run read the DEFAULT-scope team and stayed reasoning-only (no project bound).
    const ledger = await loadLedger(home);
    expect(ledger?.projectId).toBeUndefined();
    expect(await loadLedger(scopeDataHome(home, "solo"))).toBeUndefined();
  });
});

describe("a stale selection degrades symmetrically (deleted project)", () => {
  // The selection points at "gone", which getProjects() no longer returns. The scope
  // STAYS the selection's (so the cast team there is still reachable); only the bound
  // project (repo access) degrades to undefined — identically for both tools.
  const liveProjects = () => [project("alpha", "alpha", "/repo/alpha")];
  const staleSelection = () => ({
    scopeId: "gone",
    projectId: "gone",
    name: "gone",
    rootPath: "/repo/gone",
    at: "2026-06-27T00:00:00.000Z",
  });

  test("squad_coordinate keeps the selection's scope and runs reasoning-only (no throw)", async () => {
    const tools = boot(liveProjects());
    await scaffoldMember(
      scopeMembersDir(home, "gone"),
      memberRecord({ slug: "atlas", name: "Atlas" }),
    );
    await writeSelectedProject(home, staleSelection());

    const { ctx, out } = capture();
    await coordinateTool(tools).execute({ task: "ship it" }, ctx);

    expect(out().isError).toBe(false);
    expect(out().content).toContain("done");
    // Scope stayed the selection's ("gone"); no project bound (projectId undefined).
    const ledger = await loadLedger(scopeDataHome(home, "gone"));
    expect(ledger).toBeDefined();
    expect(ledger?.projectId).toBeUndefined();
  });

  test("squad_code keeps the selection's scope and degrades cleanly (no throw, no hard 'unknown project')", async () => {
    const tools = boot(liveProjects());
    await scaffoldMember(
      scopeMembersDir(home, "gone"),
      memberRecord({ slug: "atlas", name: "Atlas", tools: ["code"] }),
    );
    await writeSelectedProject(home, staleSelection());

    const { ctx, out } = capture();
    // Resolves without throwing; the member is found at the selection's scope (proving
    // the scope held), then code degrades because it has no repo to edit.
    await codeTool(tools).execute({ member: "atlas", task: "x" }, ctx);

    expect(out().isError).toBe(true);
    expect(out().content).toContain("no project bound");
    expect(out().content).not.toContain("unknown project");
  });
});
