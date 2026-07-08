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
import { DEFAULT_PROJECT_NAME } from "@keelson/shared";
import { readProposal, writeProposal } from "../src/cast.ts";
import { loadRegistry, saveRegistry } from "../src/casting/registry.ts";
import { type CoordinatorLedger, loadLedger, saveLedger } from "../src/coordinator.ts";
import rib from "../src/index.ts";
import { listMemberRecords, readMembers, scaffoldMember } from "../src/member-store.ts";
import { membersDir, scopeDataHome, scopeMembersDir, setSquadDataHome } from "../src/paths.ts";
import { readPendingGenesis, writePendingGenesis } from "../src/pending-genesis.ts";
import { appendRollbackRow, listRollbackRows } from "../src/rollback-store.ts";
import { archiveRun, listRuns } from "../src/runs-store.ts";
import { selectedScopeId, writeSelectedProject } from "../src/scope.ts";

function terminalLedger(over: Partial<CoordinatorLedger> = {}): CoordinatorLedger {
  return {
    task: "add retry/backoff",
    facts: [],
    plan: [],
    round: 4,
    stallCount: 0,
    resetCount: 0,
    status: "done",
    transcript: [],
    createdAt: "2026-07-06T00:00:00.000Z",
    updatedAt: "2026-07-06T00:10:00.000Z",
    ...over,
  };
}

// The cast SCAN lives in the squad_propose_cast tool (invoked by the squad-cast-scan
// workflow); the cast-propose ACTION only preflights the selection and launches that
// workflow. So each test boots the rib with a fake ctx (a canned scan reply, a project
// list, an in-memory data home), then either dispatches the action or runs the tool.

async function* stream(text: string): AsyncGenerator<MessageChunk> {
  yield { type: "text", content: text };
  yield { type: "done" };
}
function fakeTurn(text: string): RibAgentTurn {
  return { stream: stream("x"), result: Promise.resolve({ status: "ok", text }) };
}

const ROSTER_REPLY = JSON.stringify({
  members: [
    {
      name: "Atlas",
      role: "Engineer",
      charter: "# Atlas\n\n## Role\n\nBuilds.",
      tools: ["code", "read"],
    },
    { name: "Vera", role: "Reviewer", charter: "# Vera\n\n## Role\n\nReviews." },
  ],
  summary: "an engineer + a reviewer",
});

let home: string;
let lastReq: RibAgentTurnRequest | undefined;
let refreshed: string[];

function project(id: string, name: string, rootPath: string) {
  return { id, name, rootPath, createdAt: "2026-06-27T00:00:00.000Z" };
}

// Select a project — casting is selection-driven, so this is the setup a cast needs.
async function selectProject(id: string, name: string, rootPath: string): Promise<void> {
  await writeSelectedProject(home, {
    scopeId: id,
    projectId: id,
    name,
    rootPath,
    at: "2026-06-30T00:00:00.000Z",
  });
}

// Boot the rib and return its registered tools, so a test can drive squad_propose_cast
// directly (the scan seam the cast-scan workflow calls).
function bootRib(
  projects: ReturnType<typeof project>[],
  reply = ROSTER_REPLY,
  providers?: { id: string; displayName: string }[],
): readonly ToolDefinition[] {
  const ctx = {
    getExec: () => ({
      runJSON: async () => ({ ok: true as const, data: undefined }),
      runText: async () => ({ ok: true as const, data: "" }),
    }),
    getDataDir: () => home,
    getProjects: () => projects,
    runAgentTurn: (r: RibAgentTurnRequest): RibAgentTurn => {
      lastReq = r;
      return fakeTurn(reply);
    },
    refreshWorkflow: async (name: string) => {
      refreshed.push(name);
    },
    ...(providers !== undefined ? { getProviders: () => providers } : {}),
  } as unknown as RibContext;
  return rib.registerTools?.(ctx) ?? [];
}

// Run a rib tool against a fake ToolContext and return the single tool_result it emits.
async function runTool(
  tool: ToolDefinition,
  input: unknown,
): Promise<{ content: string; isError: boolean }> {
  let out = { content: "", isError: false };
  const ctx = {
    emit: (chunk: { type: string; content?: string; isError?: boolean }) => {
      if (chunk.type === "tool_result") {
        out = { content: chunk.content ?? "", isError: chunk.isError ?? false };
      }
    },
  } as unknown as ToolContext;
  await tool.execute(input, ctx);
  return out;
}

function proposeCastTool(tools: readonly ToolDefinition[]): ToolDefinition {
  const tool = tools.find((t) => t.name === "squad_propose_cast");
  if (!tool) throw new Error("squad_propose_cast tool not registered");
  return tool;
}

function emitMemberTool(tools: readonly ToolDefinition[]): ToolDefinition {
  const tool = tools.find((t) => t.name === "squad_emit_member");
  if (!tool) throw new Error("squad_emit_member tool not registered");
  return tool;
}

// Set up a pending proposal the way the surface does — through the scan tool — so the
// approve/discard tests exercise the real produce→consume path.
async function proposeViaTool(
  tools: readonly ToolDefinition[],
  input: Record<string, unknown> = {},
): Promise<void> {
  await runTool(proposeCastTool(tools), input);
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "squad-cast-action-"));
  lastReq = undefined;
  refreshed = [];
});
afterEach(async () => {
  rib.dispose?.();
  setSquadDataHome(undefined);
  await rm(home, { recursive: true, force: true });
});

describe("cast-propose action (launches the cast-scan workflow)", () => {
  test("with a selected project, returns a run-workflow directive for squad-cast-scan", async () => {
    bootRib([project("p1", "keelson", "/repo/keelson")]);
    await selectProject("p1", "keelson", "/repo/keelson");
    const res = await rib.onAction?.(
      { type: "cast-propose", payload: { mission: "ship the search rib" } },
      {} as RibContext,
    );
    expect(res?.ok).toBe(true);
    if (res?.ok) {
      expect(res.data).toEqual({
        effect: "run-workflow",
        workflow: "squad-cast-scan",
        args: { mission: "ship the search rib" },
        stay: true,
      });
    }
    // The action only launches — it does NOT scan in-process (no agent turn fired).
    expect(lastReq).toBeUndefined();
  });

  test("omits the mission arg when none is given", async () => {
    bootRib([project("p1", "keelson", "/repo/keelson")]);
    await selectProject("p1", "keelson", "/repo/keelson");
    const res = await rib.onAction?.({ type: "cast-propose", payload: {} }, {} as RibContext);
    expect(res?.ok).toBe(true);
    if (res?.ok) {
      expect(res.data).toEqual({
        effect: "run-workflow",
        workflow: "squad-cast-scan",
        args: {},
        stay: true,
      });
    }
  });

  test("with only the default project and no projectId selection, still launches (workspace fallback)", async () => {
    // Fresh install: the sole project is the workspace default and no projectId is
    // selected yet — casting must still work (it scans the default project's root),
    // not dead-end telling the operator to select the project they already have.
    bootRib([project("d1", DEFAULT_PROJECT_NAME, "/repo/workspace")]);
    const res = await rib.onAction?.({ type: "cast-propose", payload: {} }, {} as RibContext);
    expect(res?.ok).toBe(true);
    if (res?.ok) expect((res.data as { workflow: string }).workflow).toBe("squad-cast-scan");
  });

  test("seats a pending cast boot-card marker in the selection scope", async () => {
    bootRib([project("p1", "keelson", "/repo/keelson")]);
    await selectProject("p1", "keelson", "/repo/keelson");
    const res = await rib.onAction?.({ type: "cast-propose", payload: {} }, {} as RibContext);
    expect(res?.ok).toBe(true);
    const marker = await readPendingGenesis(scopeDataHome(home, "p1"));
    expect(marker?.kind).toBe("cast");
    expect(marker?.error).toBeUndefined();
    // The boot card shows at once — the roster panel is refreshed on begin.
    expect(refreshed).toContain("squad-roster");
  });

  test("with no selection but projects available, points the operator at the picker", async () => {
    bootRib([project("p1", "alpha", "/repo/a"), project("p2", "beta", "/repo/b")]);
    const res = await rib.onAction?.({ type: "cast-propose", payload: {} }, {} as RibContext);
    expect(res?.ok).toBe(false);
    if (!res?.ok) expect(res?.error).toContain("select a project in the picker");
    // A failed preflight seats no boot card.
    expect(await readPendingGenesis(scopeDataHome(home, selectedScopeId(undefined)))).toBeNull();
  });

  test("with no projects at all, tells the operator to add one first", async () => {
    bootRib([]);
    const res = await rib.onAction?.({ type: "cast-propose", payload: {} }, {} as RibContext);
    expect(res?.ok).toBe(false);
    if (!res?.ok) expect(res?.error).toContain("add a project first");
  });

  test("fails closed when the agent-turn / projects seams are absent", async () => {
    // A bare ctx (no seams) — registerTools captures undefined seams.
    const bare = {
      getExec: () => ({
        runJSON: async () => ({ ok: true as const, data: undefined }),
        runText: async () => ({ ok: true as const, data: "" }),
      }),
      getDataDir: () => home,
    } as unknown as RibContext;
    rib.registerTools?.(bare);
    const res = await rib.onAction?.({ type: "cast-propose", payload: {} }, {} as RibContext);
    expect(res?.ok).toBe(false);
    if (!res?.ok) expect(res?.error).toContain("seam");
  });
});

describe("squad_propose_cast tool (runs the confined scan)", () => {
  test("scans the selected project with the read-only rail, persists the proposal, refreshes cast", async () => {
    const tools = bootRib([project("p1", "keelson", "/repo/keelson")]);
    await selectProject("p1", "keelson", "/repo/keelson");
    const out = await runTool(proposeCastTool(tools), {});
    expect(out.isError).toBe(false);
    // The scan was confined to the selected project's root with the read-only rail.
    expect(lastReq?.cwd).toBe("/repo/keelson");
    expect(lastReq?.allowedDirectories).toEqual(["/repo/keelson"]);
    expect(lastReq?.allowedTools).toEqual(["Read", "Glob", "Grep"]);
    // The proposal landed under the selection's scope and the cast panel was refreshed.
    const proposal = await readProposal(scopeDataHome(home, "p1"));
    expect(proposal?.members[0]).toMatchObject({
      name: "McManus",
      originalName: "Atlas",
      slug: "mcmanus",
      themeId: "usual-suspects",
      identitySlot: 0,
    });
    expect(proposal?.members[1]?.identitySlot).toBe(1);
    expect(proposal?.members.map((m) => m.name)).not.toEqual(["Atlas", "Vera"]);
    expect(proposal?.members[0]?.charter.startsWith("# McManus")).toBe(true);
    expect(proposal?.members[0]?.charter).not.toContain("# Atlas");
    expect(refreshed).toContain("squad-cast");
  });

  test("clears the pending cast marker and refreshes the roster when the proposal lands", async () => {
    const tools = bootRib([project("p1", "keelson", "/repo/keelson")]);
    await selectProject("p1", "keelson", "/repo/keelson");
    await rib.onAction?.({ type: "cast-propose", payload: {} }, {} as RibContext);
    refreshed.length = 0;
    const out = await runTool(proposeCastTool(tools), {});
    expect(out.isError).toBe(false);
    expect(await readPendingGenesis(scopeDataHome(home, "p1"))).toBeNull();
    expect(refreshed).toContain("squad-roster");
  });

  test("stamps the pending marker failed (not cleared) when the scan returns garbage", async () => {
    const tools = bootRib([project("p1", "keelson", "/repo/keelson")], "not a proposal");
    await selectProject("p1", "keelson", "/repo/keelson");
    await rib.onAction?.({ type: "cast-propose", payload: {} }, {} as RibContext);
    const out = await runTool(proposeCastTool(tools), {});
    expect(out.isError).toBe(true);
    const marker = await readPendingGenesis(scopeDataHome(home, "p1"));
    expect(marker?.kind).toBe("cast");
    expect(marker?.error).toContain("roster proposal");
  });

  test("a direct call never clobbers a member-genesis boot card, on failure or success", async () => {
    // A member genesis is in flight (marker without kind) when squad_propose_cast is
    // invoked directly — its boot card must survive both tool outcomes untouched.
    const memberMarker = { startedAt: "2026-07-08T00:00:00.000Z", role: "Engineer" };
    const failing = bootRib([project("p1", "keelson", "/repo/keelson")], "not a proposal");
    await selectProject("p1", "keelson", "/repo/keelson");
    await writePendingGenesis(memberMarker, scopeDataHome(home, "p1"));
    expect((await runTool(proposeCastTool(failing), {})).isError).toBe(true);
    expect(await readPendingGenesis(scopeDataHome(home, "p1"))).toEqual(memberMarker);
    const succeeding = bootRib([project("p1", "keelson", "/repo/keelson")]);
    expect((await runTool(proposeCastTool(succeeding), {})).isError).toBe(false);
    expect(await readPendingGenesis(scopeDataHome(home, "p1"))).toEqual(memberMarker);
  });

  test("carries the operator mission into the scan", async () => {
    const tools = bootRib([project("p1", "keelson", "/repo/keelson")]);
    await selectProject("p1", "keelson", "/repo/keelson");
    await runTool(proposeCastTool(tools), { mission: "ship the OSDU search rib" });
    expect(lastReq?.prompt).toContain("ship the OSDU search rib");
  });

  test("drops an unregistered provider pin from the persisted proposal and records a note", async () => {
    const reply = JSON.stringify({
      members: [
        {
          name: "Atlas",
          role: "Engineer",
          charter: "# Atlas",
          provider: "ghost",
          model: "ghost-max",
        },
      ],
    });
    const tools = bootRib([project("p1", "keelson", "/repo/keelson")], reply, [
      { id: "copilot", displayName: "Copilot" },
    ]);
    await selectProject("p1", "keelson", "/repo/keelson");

    const out = await runTool(proposeCastTool(tools), {});
    const proposal = await readProposal(scopeDataHome(home, "p1"));

    expect(out.isError).toBe(false);
    expect(proposal?.members[0]?.provider).toBeUndefined();
    expect(proposal?.members[0]?.model).toBeUndefined();
    expect(proposal?.notes.join("\n")).toContain('dropped provider/model "ghost" / "ghost-max"');
    expect(proposal?.notes.join("\n")).toContain("provider is not registered for squad members");
  });

  test("keeps a registered provider/model pin in the persisted proposal", async () => {
    const reply = JSON.stringify({
      members: [
        {
          name: "Atlas",
          role: "Engineer",
          charter: "# Atlas",
          provider: "copilot",
          model: "gpt-5.5",
        },
      ],
    });
    const tools = bootRib([project("p1", "keelson", "/repo/keelson")], reply, [
      { id: "copilot", displayName: "Copilot" },
    ]);
    await selectProject("p1", "keelson", "/repo/keelson");

    await runTool(proposeCastTool(tools), {});
    const proposal = await readProposal(scopeDataHome(home, "p1"));

    expect(proposal?.members[0]?.provider).toBe("copilot");
    expect(proposal?.members[0]?.model).toBe("gpt-5.5");
    expect(proposal?.notes.join("\n")).not.toContain("dropped provider");
  });

  test("scans AND places under the SELECTION scope, never mis-placed", async () => {
    const tools = bootRib([project("p1", "alpha", "/repo/a"), project("p2", "beta", "/repo/b")]);
    await selectProject("p1", "alpha", "/repo/a");
    await runTool(proposeCastTool(tools), {});
    expect(lastReq?.cwd).toBe("/repo/a");
    expect(await readProposal(scopeDataHome(home, "p1"))).toBeDefined();
    expect(await readProposal(scopeDataHome(home, "p2"))).toBeUndefined();
  });

  test("fails closed with no selected project", async () => {
    const tools = bootRib([project("p1", "alpha", "/repo/a")]);
    const out = await runTool(proposeCastTool(tools), {});
    expect(out.isError).toBe(true);
    expect(out.content).toContain("select a project");
  });

  test("with no projectId selection, scans the workspace default project (flat scope)", async () => {
    const tools = bootRib([project("d1", DEFAULT_PROJECT_NAME, "/repo/workspace")]);
    const out = await runTool(proposeCastTool(tools), {});
    expect(out.isError).toBe(false);
    expect(lastReq?.cwd).toBe("/repo/workspace");
    // The proposal lands under the flat/default scope (the home root).
    expect(await readProposal(home)).toBeDefined();
  });
});

describe("squad_emit_member tool", () => {
  test("drops an unregistered provider pin from the emitted member and returns a note", async () => {
    const tools = bootRib([], ROSTER_REPLY, [{ id: "copilot", displayName: "Copilot" }]);

    const out = await runTool(emitMemberTool(tools), {
      name: "Atlas",
      role: "Engineer",
      charter: "# Atlas",
      provider: "ghost",
      model: "ghost-max",
    });
    const result = JSON.parse(out.content) as { note?: string };
    const members = await readMembers(scopeMembersDir(home, "default"));

    expect(out.isError).toBe(false);
    expect(members[0]?.provider).toBeUndefined();
    expect(members[0]?.model).toBeUndefined();
    expect(result.note).toContain('dropped provider/model "ghost" / "ghost-max"');
    expect(result.note).toContain("provider is not registered for squad members");
  });
});

describe("approve-cast / discard-cast actions", () => {
  test("approve scaffolds the already-themed proposal with tags, slots, and names intact", async () => {
    const tools = bootRib([project("p1", "keelson", "/repo/keelson")]);
    await selectProject("p1", "keelson", "/repo/keelson");
    await proposeViaTool(tools);
    const proposal = await readProposal(scopeDataHome(home, "p1"));
    expect(proposal).toBeDefined();
    const res = await rib.onAction?.({ type: "approve-cast" }, {} as RibContext);
    expect(res?.ok).toBe(true);
    if (res?.ok) {
      const data = res.data as { created: string[]; skipped: string[]; truncated: number };
      // Two members scaffolded under their themed (cast) slugs, not the proposed ones.
      expect(data.created).toHaveLength(2);
    }
    const members = await readMembers(scopeMembersDir(home, "p1"));
    const records = await listMemberRecords(scopeMembersDir(home, "p1"));
    const atlas = members.find((m) => m.originalName === "Atlas");
    expect(atlas?.tools).toEqual(["code", "read"]);
    expect(atlas?.themeId).toBeDefined();
    expect(atlas?.personality).toBeTruthy();
    expect(atlas?.name).toBe(proposal?.members.find((m) => m.originalName === "Atlas")?.name);
    expect(records.find((m) => m.originalName === "Atlas")?.identitySlot).toBe(0);
    expect(records.find((m) => m.originalName === "Vera")?.identitySlot).toBe(1);
    // The whole roster is cast from ONE ensemble (a coherent squad).
    expect(new Set(members.map((m) => m.themeId)).size).toBe(1);
    // The proposal was consumed; the roster + cast panels refreshed. The member-gated
    // coordinator panel refreshes too, so the Run-loop panel appears as the squad seats
    // instead of lagging to its cadence tick.
    expect(await readProposal(scopeDataHome(home, "p1"))).toBeUndefined();
    expect(refreshed).toContain("squad-roster");
    expect(refreshed).toContain("squad-coordinator");
  });

  test("approve fails closed with no pending proposal", async () => {
    bootRib([project("p1", "keelson", "/repo/keelson")]);
    const res = await rib.onAction?.({ type: "approve-cast" }, {} as RibContext);
    expect(res?.ok).toBe(false);
    if (!res?.ok) expect(res?.error).toContain("no proposal");
  });

  test("approve preserves normalized proposal slots instead of recomputing from names", async () => {
    bootRib([project("p1", "keelson", "/repo/keelson")]);
    await selectProject("p1", "keelson", "/repo/keelson");
    await writeProposal(scopeDataHome(home, "p1"), {
      projectId: "p1",
      projectName: "keelson",
      rootPath: "/repo/keelson",
      members: [
        {
          slug: "first",
          name: "First",
          role: "Engineer",
          charter: "# First",
          originalName: "Zed",
          identitySlot: 4,
        },
        {
          slug: "second",
          name: "Second",
          role: "Reviewer",
          charter: "# Second",
          originalName: "Ana",
          identitySlot: 42,
        },
      ],
      notes: [],
      createdAt: "2026-06-27T00:00:00.000Z",
    });
    const res = await rib.onAction?.({ type: "approve-cast" }, {} as RibContext);
    expect(res?.ok).toBe(true);
    const records = await listMemberRecords(scopeMembersDir(home, "p1"));
    expect(records.find((m) => m.slug === "first")?.identitySlot).toBe(4);
    expect(records.find((m) => m.slug === "second")?.identitySlot).toBe(1);
  });

  test("approve is collision-safe — re-approving the same cast skips existing members", async () => {
    const tools = bootRib([project("p1", "keelson", "/repo/keelson")]);
    await selectProject("p1", "keelson", "/repo/keelson");
    await proposeViaTool(tools);
    await rib.onAction?.({ type: "approve-cast" }, {} as RibContext);
    // Cast + approve again — the authored members must not be clobbered.
    await proposeViaTool(tools);
    const res = await rib.onAction?.({ type: "approve-cast" }, {} as RibContext);
    expect(res?.ok).toBe(true);
    if (res?.ok) {
      const data = res.data as { created: string[]; skipped: string[] };
      // Stable casting: the same proposed names re-resolve to the same themed slugs,
      // so the second approve skips them — no duplicate members under fresh names.
      expect(data.created).toEqual([]);
      expect(data.skipped).toHaveLength(2);
    }
    expect(await readMembers(scopeMembersDir(home, "p1"))).toHaveLength(2);
  });

  test("discard clears the pending proposal", async () => {
    const tools = bootRib([project("p1", "keelson", "/repo/keelson")]);
    await selectProject("p1", "keelson", "/repo/keelson");
    await proposeViaTool(tools);
    const res = await rib.onAction?.({ type: "discard-cast" }, {} as RibContext);
    expect(res?.ok).toBe(true);
    expect(await readProposal(scopeDataHome(home, "p1"))).toBeUndefined();
    expect(refreshed).toContain("squad-cast");
    // The roster refreshes too — its launchpad returns once the proposal is gone.
    expect(refreshed).toContain("squad-roster");
  });

  test("cast↔run scope agree: a team cast for the SELECTED project lands under its scope", async () => {
    const tools = bootRib([project("px", "proj-x", "/repo/x")]);
    // Select project X — the single source of truth a no-arg cast (and a no-arg run)
    // both key on. Casting with no explicit field scans X and stores under X's scope.
    await writeSelectedProject(home, {
      scopeId: "px",
      projectId: "px",
      name: "proj-x",
      rootPath: "/repo/x",
      at: "2026-06-30T00:00:00.000Z",
    });
    await proposeViaTool(tools);
    const res = await rib.onAction?.({ type: "approve-cast" }, {} as RibContext);
    expect(res?.ok).toBe(true);
    // Members land under projects/px/members (the selection's scope), NOT the default
    // tree — so a no-arg squad_coordinate/squad_code with X selected reads this team.
    expect(await readMembers(scopeMembersDir(home, "px"))).toHaveLength(2);
    expect(await readMembers(membersDir())).toHaveLength(0);
  });
});

describe("assign-code action", () => {
  const now = "2026-07-01T00:00:00.000Z";

  test("launches squad-code-run for an active, code-capable member in the selected scope", async () => {
    bootRib([project("p1", "keelson", "/repo/keelson")]);
    // No project selected → the flat default scope; scaffold a code-capable member there.
    await scaffoldMember(scopeMembersDir(home, "default"), {
      slug: "coder",
      name: "Coder",
      role: "Engineer",
      charter: "# Coder",
      status: "active",
      createdAt: now,
      tools: ["code"],
    });
    const res = await rib.onAction?.(
      { type: "assign-code", payload: { slug: "coder", task: "add a --json flag" } },
      {} as RibContext,
    );
    expect(res?.ok).toBe(true);
    if (res?.ok) {
      expect(res.data).toEqual({
        effect: "run-workflow",
        workflow: "squad-code-run",
        args: { member: "coder", task: "add a --json flag" },
      });
    }
  });

  test("rejects a member that lacks the code capability, before launching", async () => {
    bootRib([project("p1", "keelson", "/repo/keelson")]);
    await scaffoldMember(scopeMembersDir(home, "default"), {
      slug: "talker",
      name: "Talker",
      role: "Reviewer",
      charter: "# Talker",
      status: "active",
      createdAt: now,
    });
    const res = await rib.onAction?.(
      { type: "assign-code", payload: { slug: "talker", task: "x" } },
      {} as RibContext,
    );
    expect(res?.ok).toBe(false);
    if (!res?.ok) expect(res?.error).toContain('lacks the "code" capability');
  });
});

describe("retire action", () => {
  test("frees the cast name even when the member dir is already gone (no phantom leak)", async () => {
    bootRib([project("p1", "keelson", "/repo/keelson")]);
    // A phantom reservation: a casting-registry entry with no member dir (a failed scaffold).
    await saveRegistry(home, {
      version: 1,
      activeThemeId: "usual-suspects",
      themeHistory: ["usual-suspects"],
      members: {
        ghost: {
          themedName: "Keyser",
          themeId: "usual-suspects",
          status: "active",
          originalName: "Ghost",
        },
      },
    });
    const res = await rib.onAction?.(
      { type: "retire", payload: { slug: "ghost" } },
      {} as RibContext,
    );
    expect(res?.ok).toBe(false); // retireMember throws on the missing dir...
    expect((await loadRegistry(home)).members.ghost?.status).toBe("retired"); // ...name still freed
  });
});

describe("reset-squad action", () => {
  const now = "2026-07-06T00:00:00.000Z";

  // Seed the default scope with every persistent store populated: members, a terminal
  // run ledger, an archived run, a rollback row, and a pending proposal.
  async function seedLeftoverState(): Promise<void> {
    const membersRoot = scopeMembersDir(home, "default");
    await scaffoldMember(membersRoot, {
      slug: "keyser",
      name: "Keyser",
      role: "Tech Lead",
      charter: "# Keyser",
      status: "active",
      createdAt: now,
    });
    await scaffoldMember(membersRoot, {
      slug: "edie",
      name: "Edie",
      role: "Reviewer",
      charter: "# Edie",
      status: "active",
      createdAt: now,
    });
    await saveLedger(home, terminalLedger());
    await archiveRun(home, terminalLedger({ createdAt: "2026-07-05T00:00:00.000Z" }));
    await appendRollbackRow(home, { type: "noop", runId: "run-1", at: now });
    await writeProposal(home, {
      projectId: "default",
      projectName: "keelson",
      rootPath: "/repo/keelson",
      members: [],
      notes: [],
      createdAt: now,
    });
  }

  test("returns the surface to empty: retires members and clears runs/ledger/rollbacks/proposal", async () => {
    bootRib([]);
    await seedLeftoverState();

    const res = await rib.onAction?.({ type: "reset-squad" }, {} as RibContext);
    expect(res?.ok).toBe(true);
    if (res?.ok) expect(res.data).toEqual({ retired: 2 });

    // Every persisted store for the scope is now empty — the pristine first moment.
    expect(await readMembers(scopeMembersDir(home, "default"))).toHaveLength(0);
    expect(await loadLedger(home)).toBeUndefined();
    expect(await listRuns(home)).toHaveLength(0);
    expect(await listRollbackRows(home)).toHaveLength(0);
    expect(await readProposal(home)).toBeUndefined();

    // All four panels were re-read so the surface repaints to empty immediately.
    for (const wf of ["squad-roster", "squad-cast", "squad-coordinator", "squad-runs"]) {
      expect(refreshed).toContain(wf);
    }
  });

  test("refuses while a run is active — nothing is cleared", async () => {
    bootRib([]);
    await seedLeftoverState();
    await saveLedger(home, terminalLedger({ status: "active" }));

    const res = await rib.onAction?.({ type: "reset-squad" }, {} as RibContext);
    expect(res?.ok).toBe(false);
    if (!res?.ok) expect(res?.error).toContain("run is active");

    // Guard held: the seeded state survives an attempted reset over a live run.
    expect(await readMembers(scopeMembersDir(home, "default"))).toHaveLength(2);
    expect(await loadLedger(home)).toBeDefined();
    expect(await listRuns(home)).toHaveLength(1);
  });
});
