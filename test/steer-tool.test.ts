import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RibContext, ToolDefinition } from "@keelson/shared";
import rib from "../src/index.ts";
import { setSquadDataHome } from "../src/paths.ts";

// squad_steer queues an operator instruction for a live coordinator run to fold in next round.
// The queue is only reachable while a run is live (activeCoordinateRuns holds its controller),
// so a tool-level test covers the guards; the fold itself is exercised in coordinator.test.ts.

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

function steerTool(projects: ReturnType<typeof project>[]): ToolDefinition | undefined {
  return bootTools(projects).find((t) => t.name === "squad_steer");
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

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "squad-steer-tool-"));
});
afterEach(async () => {
  rib.dispose?.();
  setSquadDataHome(undefined);
  await rm(home, { recursive: true, force: true });
});

describe("squad_steer tool", () => {
  test("errors when there is no live coordinator run in scope", async () => {
    const res = await invoke(steerTool([]), { instruction: "prefer the existing helper" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("no live coordinator run");
  });

  test("errors on an unknown explicit project instead of silently steering the default scope", async () => {
    const res = await invoke(steerTool([project("p1", "alpha", "/repo/a")]), {
      project: "nope",
      instruction: "do the thing",
    });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("unknown project");
  });

  test("rejects an empty instruction", async () => {
    const res = await invoke(steerTool([]), { instruction: "" });
    expect(res.isError).toBe(true);
  });
});
