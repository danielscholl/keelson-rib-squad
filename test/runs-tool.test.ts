import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RibContext, ToolDefinition } from "@keelson/shared";
import type { CoordinatorLedger } from "../src/coordinator.ts";
import rib from "../src/index.ts";
import { scopeDataHome, setSquadDataHome } from "../src/paths.ts";
import { archiveRun } from "../src/runs-store.ts";
import { writeSelectedProject } from "../src/scope.ts";

// squad_runs is read-only, so a minimal ctx (a data home + a project list) is enough to
// drive its execute without an agent-turn seam.

let home: string;

function project(id: string, name: string, rootPath: string) {
  return { id, name, rootPath, createdAt: "2026-06-27T00:00:00.000Z" };
}

function bootTools(projects: ReturnType<typeof project>[]): readonly ToolDefinition[] {
  const ctx = {
    getExec: () => ({
      runJSON: async () => ({ ok: true as const, data: undefined }),
      runText: async () => ({ ok: true as const, data: "" }),
    }),
    getDataDir: () => home,
    getProjects: () => projects,
  } as unknown as RibContext;
  return rib.registerTools?.(ctx) ?? [];
}

function runsTool(projects: ReturnType<typeof project>[]): ToolDefinition | undefined {
  return bootTools(projects).find((t) => t.name === "squad_runs");
}

async function invoke(
  tool: ToolDefinition | undefined,
  input: unknown,
): Promise<{ content?: string; isError?: boolean }> {
  const chunks: { content?: string; isError?: boolean }[] = [];
  await tool?.execute(input, {
    emit: (c: { content?: string; isError?: boolean }) => chunks.push(c),
  } as never);
  return chunks[0] ?? {};
}

function ledger(overrides: Partial<CoordinatorLedger> = {}): CoordinatorLedger {
  return {
    task: "a past run",
    facts: [],
    plan: [],
    round: 3,
    stallCount: 0,
    resetCount: 0,
    status: "done",
    transcript: [],
    createdAt: "2026-06-30T00:00:00.000Z",
    updatedAt: "2026-06-30T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "squad-runs-tool-"));
});
afterEach(async () => {
  rib.dispose?.();
  setSquadDataHome(undefined);
  await rm(home, { recursive: true, force: true });
});

describe("squad_runs tool", () => {
  test("errors on an unknown explicit project instead of silently listing the default scope", async () => {
    const tool = runsTool([project("p1", "alpha", "/repo/a")]);
    const res = await invoke(tool, { project: "nope" });
    // Must mirror squad_code / squad_coordinate — a bad explicit project fails, not a default fallback.
    expect(res.isError).toBe(true);
    expect(res.content).toContain("unknown project");
  });

  test("lists the selected project's archived runs (no explicit arg)", async () => {
    await writeSelectedProject(home, {
      scopeId: "p1",
      projectId: "p1",
      name: "alpha",
      rootPath: "/repo/a",
      at: "2026-06-30T00:00:00.000Z",
    });
    await archiveRun(scopeDataHome(home, "p1"), ledger({ task: "implemented the widget" }));
    const res = await invoke(runsTool([project("p1", "alpha", "/repo/a")]), {});
    expect(res.isError).toBeUndefined();
    expect(res.content).toContain("1 archived run");
    expect(res.content).toContain("implemented the widget");
  });
});
