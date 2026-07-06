import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RibContext, SnapshotFrame, SnapshotManager, ToolDefinition } from "@keelson/shared";
import type { CoordinatorLedger } from "../src/coordinator.ts";
import rib from "../src/index.ts";
import { REPORT_KEY } from "../src/keys.ts";
import { scopeDataHome, setSquadDataHome } from "../src/paths.ts";
import { archiveRun } from "../src/runs-store.ts";
import { writeSelectedProject } from "../src/scope.ts";

// The report path is compose+publish over an in-memory SnapshotManager: enough to
// drive registerTools/onAction/squad_report without a harness, and to observe the
// validated html frame the real manager would broadcast.

let home: string;

type Registered = {
  compose: () => unknown | Promise<unknown>;
  validate?: (data: unknown) => unknown;
};

function makeSnapshots(): SnapshotManager {
  const composers = new Map<string, Registered>();
  const latest = new Map<string, SnapshotFrame>();
  return {
    register(key, compose, opts) {
      if (composers.has(key)) throw new Error(`duplicate key ${key}`);
      composers.set(key, {
        compose,
        ...(opts?.validate ? { validate: opts.validate as (data: unknown) => unknown } : {}),
      });
      return () => {
        composers.delete(key);
      };
    },
    async recompose(key) {
      const entry = composers.get(key);
      if (!entry) return undefined;
      try {
        const data = entry.validate ? entry.validate(await entry.compose()) : await entry.compose();
        const frame: SnapshotFrame = {
          type: "snapshot_update",
          key,
          version: (latest.get(key)?.version ?? 0) + 1,
          composedAt: new Date().toISOString(),
          data,
        };
        latest.set(key, frame);
        return frame as never;
      } catch {
        return undefined;
      }
    },
    latest(key) {
      return latest.get(key) as never;
    },
    keys() {
      return [...composers.keys()];
    },
    async dispose() {},
  };
}

function bootCtx(manager: SnapshotManager): RibContext {
  return {
    getExec: () => ({
      runJSON: async () => ({ ok: true as const, data: undefined }),
      runText: async () => ({ ok: true as const, data: "" }),
    }),
    getDataDir: () => home,
    getProjects: () => [
      { id: "p1", name: "alpha", rootPath: "/repo/a", createdAt: "2026-06-27T00:00:00.000Z" },
    ],
    getSnapshotManager: () => manager,
  } as unknown as RibContext;
}

function ledger(overrides: Partial<CoordinatorLedger> = {}): CoordinatorLedger {
  return {
    task: "a past run",
    facts: ["one finding"],
    plan: [],
    round: 3,
    stallCount: 0,
    resetCount: 0,
    status: "done",
    transcript: [
      {
        round: 1,
        kind: "code",
        speaker: "edie",
        text: "did the work",
        usage: { inputTokens: 1000, outputTokens: 200 },
      },
    ],
    createdAt: "2026-06-30T00:00:00.000Z",
    updatedAt: "2026-06-30T00:10:00.000Z",
    ...overrides,
  };
}

// runs-store derives the archive id from createdAt with [:.] mapped to dashes.
const RUN_ID = "2026-06-30T00-00-00-000Z";

async function seedScope(): Promise<void> {
  await writeSelectedProject(home, {
    scopeId: "p1",
    projectId: "p1",
    name: "alpha",
    rootPath: "/repo/a",
    at: "2026-06-30T00:00:00.000Z",
  });
  await archiveRun(scopeDataHome(home, "p1"), ledger());
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
  home = await mkdtemp(join(tmpdir(), "squad-report-"));
});
afterEach(async () => {
  rib.dispose?.();
  setSquadDataHome(undefined);
  await rm(home, { recursive: true, force: true });
});

describe("squad-report board action", () => {
  test("dispatch composes the report, publishes the html, and returns an open-canvas effect", async () => {
    const manager = makeSnapshots();
    const ctx = bootCtx(manager);
    rib.registerTools?.(ctx);
    await seedScope();

    const res = await rib.onAction?.({ type: "squad-report", payload: { runId: RUN_ID } }, ctx);
    expect(res?.ok).toBe(true);
    if (res?.ok) {
      expect(res.data).toEqual({
        effect: "open-canvas",
        key: REPORT_KEY,
        title: `Run report ${RUN_ID}`,
      });
    }
    const frame = manager.latest(REPORT_KEY);
    expect(typeof frame?.data).toBe("string");
    const page = frame?.data as string;
    expect(page).toContain("SQUAD RUN REPORT");
    expect(page).toContain("a past run");
    expect(page).toContain(RUN_ID);
  });

  test("fails closed without a runId and on an unknown run", async () => {
    const manager = makeSnapshots();
    const ctx = bootCtx(manager);
    rib.registerTools?.(ctx);
    await seedScope();

    const missing = await rib.onAction?.({ type: "squad-report", payload: {} }, ctx);
    expect(missing?.ok).toBe(false);
    const unknown = await rib.onAction?.(
      { type: "squad-report", payload: { runId: "no-such-run" } },
      ctx,
    );
    expect(unknown?.ok).toBe(false);
    if (!unknown?.ok) expect(unknown?.error).toContain("unknown run");
  });
});

describe("squad_report tool", () => {
  function reportTool(manager: SnapshotManager): ToolDefinition | undefined {
    return (rib.registerTools?.(bootCtx(manager)) ?? []).find((t) => t.name === "squad_report");
  }

  test("defaults to the most recent archived run", async () => {
    const manager = makeSnapshots();
    const tool = reportTool(manager);
    await seedScope();
    await archiveRun(
      scopeDataHome(home, "p1"),
      ledger({
        task: "the newer run",
        createdAt: "2026-07-02T00:00:00.000Z",
        updatedAt: "2026-07-02T01:00:00.000Z",
      }),
    );

    const res = await invoke(tool, {});
    expect(res.isError).toBeUndefined();
    expect(res.content).toContain(REPORT_KEY);
    expect(res.content).toContain("Run report 2026-07-02T00-00-00-000Z");
    expect(res.content).toContain("done · 3 rounds");
    expect(manager.latest(REPORT_KEY)?.data as string).toContain("the newer run");
  });

  test("an explicit run_id picks that run", async () => {
    const manager = makeSnapshots();
    const tool = reportTool(manager);
    await seedScope();
    await archiveRun(
      scopeDataHome(home, "p1"),
      ledger({
        task: "the newer run",
        createdAt: "2026-07-02T00:00:00.000Z",
        updatedAt: "2026-07-02T01:00:00.000Z",
      }),
    );

    const res = await invoke(tool, { run_id: RUN_ID });
    expect(res.isError).toBeUndefined();
    expect(res.content).toContain(`Run report ${RUN_ID}`);
    expect(manager.latest(REPORT_KEY)?.data as string).toContain("a past run");
  });

  test("an unknown run_id errors instead of silently reporting another run", async () => {
    const manager = makeSnapshots();
    const tool = reportTool(manager);
    await seedScope();
    const res = await invoke(tool, { run_id: "no-such-run" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("unknown run");
  });

  test("fails closed when the snapshot seam is absent", async () => {
    const ctx = {
      getExec: () => ({
        runJSON: async () => ({ ok: true as const, data: undefined }),
        runText: async () => ({ ok: true as const, data: "" }),
      }),
      getDataDir: () => home,
      getProjects: () => [],
    } as unknown as RibContext;
    const tool = (rib.registerTools?.(ctx) ?? []).find((t) => t.name === "squad_report");
    const res = await invoke(tool, {});
    expect(res.isError).toBe(true);
    expect(res.content).toContain("snapshot seam");
  });
});
