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
import { CODE_TOOLS, memberCanCode, runCodeTurn } from "../src/code.ts";
import rib from "../src/index.ts";
import { type MemberRecord, scaffoldMember } from "../src/member-store.ts";
import { scopeMembersDir, setSquadDataHome } from "../src/paths.ts";
import type { Member } from "../src/types.ts";

async function* stream(text: string): AsyncGenerator<MessageChunk> {
  yield { type: "text", content: text };
  yield { type: "done" };
}
function fakeTurn(text: string): RibAgentTurn {
  return { stream: stream("x"), result: Promise.resolve({ status: "ok", text }) };
}

function member(over: {
  slug: string;
  name: string;
  tools?: readonly string[];
  model?: string;
  provider?: string;
  status?: "active" | "inactive";
}): Member {
  return {
    slug: over.slug,
    name: over.name,
    role: "Engineer",
    charter: `# ${over.name}\n\n## Role\n\nBuilds.`,
    status: over.status ?? "active",
    ...(over.tools ? { tools: over.tools } : {}),
    ...(over.model ? { model: over.model } : {}),
    ...(over.provider ? { provider: over.provider } : {}),
  };
}

describe("runCodeTurn", () => {
  let home: string;
  let captured: RibAgentTurnRequest | undefined;
  function capturingRun(reply = "edited foo.ts"): NonNullable<RibContext["runAgentTurn"]> {
    return (r: RibAgentTurnRequest): RibAgentTurn => {
      captured = r;
      return fakeTurn(reply);
    };
  }

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "squad-code-"));
    captured = undefined;
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  test("confines the turn to the project root with the code rail and member identity", async () => {
    const res = await runCodeTurn({
      runAgentTurn: capturingRun(),
      membersRoot: home,
      member: member({ slug: "atlas", name: "Atlas", tools: ["code", "read"] }),
      project: { name: "keelson", rootPath: "/repo/keelson" },
      task: "add a --verbose flag",
    });
    expect(res.ok).toBe(true);
    expect(captured?.cwd).toBe("/repo/keelson");
    expect(captured?.allowedDirectories).toEqual(["/repo/keelson"]);
    expect(captured?.allowedTools).toEqual([...CODE_TOOLS]);
    // Identity comes from the composed system prompt (falls back to member.charter).
    expect(captured?.system).toContain("Atlas");
    expect(captured?.prompt).toContain("add a --verbose flag");
    // The prose nudge reinforces the RAI floor.
    expect(captured?.prompt).toMatch(/do not .*push|merge/i);
  });

  test("adds review-gate verify guidance when full verification is deferred", async () => {
    await runCodeTurn({
      runAgentTurn: capturingRun(),
      membersRoot: home,
      member: member({ slug: "atlas", name: "Atlas", tools: ["code"] }),
      project: { name: "keelson", rootPath: "/repo/keelson" },
      task: "add a --verbose flag",
      deferFullVerify: true,
    });
    expect(captured?.prompt).toMatch(/do not run.*full.*matrix/i);
    expect(captured?.prompt).toMatch(/verify gate owns it|review gate/i);
    expect(captured?.prompt).toMatch(/commit your work early/i);
  });

  test("omits review-gate verify guidance by default", async () => {
    await runCodeTurn({
      runAgentTurn: capturingRun(),
      membersRoot: home,
      member: member({ slug: "atlas", name: "Atlas", tools: ["code"] }),
      project: { name: "keelson", rootPath: "/repo/keelson" },
      task: "add a --verbose flag",
    });
    expect(captured?.prompt).not.toMatch(/full check\/test matrix/i);
    expect(captured?.prompt).not.toMatch(/verify gate owns it/i);
    expect(captured?.prompt).not.toMatch(/commit your work early/i);
  });

  test("pins the member's provider/model when both are set", async () => {
    await runCodeTurn({
      runAgentTurn: capturingRun(),
      membersRoot: home,
      member: member({
        slug: "atlas",
        name: "Atlas",
        tools: ["code"],
        model: "claude-opus-4-8",
        provider: "copilot",
      }),
      project: { name: "keelson", rootPath: "/repo/keelson" },
      task: "x",
    });
    expect(captured?.model).toBe("claude-opus-4-8");
    expect(captured?.provider).toBe("copilot");
  });

  test("fails closed for a member without the code capability (never runs the turn)", async () => {
    const res = await runCodeTurn({
      runAgentTurn: capturingRun(),
      membersRoot: home,
      member: member({ slug: "vera", name: "Vera", tools: ["read"] }),
      project: { name: "keelson", rootPath: "/repo/keelson" },
      task: "x",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("not code-capable");
    expect(captured).toBeUndefined();
  });

  test("fails closed when the project has no root to confine to", async () => {
    const res = await runCodeTurn({
      runAgentTurn: capturingRun(),
      membersRoot: home,
      member: member({ slug: "atlas", name: "Atlas", tools: ["code"] }),
      project: { name: "ghost", rootPath: "   " },
      task: "x",
    });
    expect(res.ok).toBe(false);
    expect(captured).toBeUndefined();
  });

  test("surfaces a turn error as ok:true with a non-ok outcome", async () => {
    const failRun: NonNullable<RibContext["runAgentTurn"]> = () => ({
      stream: stream("x"),
      result: Promise.resolve({ status: "error", text: "", error: "provider exploded" }),
    });
    const res = await runCodeTurn({
      runAgentTurn: failRun,
      membersRoot: home,
      member: member({ slug: "atlas", name: "Atlas", tools: ["code"] }),
      project: { name: "keelson", rootPath: "/repo/keelson" },
      task: "x",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.outcome.status).toBe("error");
      expect(res.outcome.error).toContain("provider exploded");
    }
  });
});

describe("memberCanCode", () => {
  test("true only when the member carries the code tag", () => {
    expect(memberCanCode({ tools: ["code", "read"] })).toBe(true);
    expect(memberCanCode({ tools: ["read"] })).toBe(false);
    expect(memberCanCode({ tools: [] })).toBe(false);
    expect(memberCanCode({})).toBe(false);
  });
});

describe("squad_code tool", () => {
  let home: string;
  let lastReq: RibAgentTurnRequest | undefined;

  function project(id: string, name: string, rootPath: string) {
    return { id, name, rootPath, createdAt: "2026-06-27T00:00:00.000Z" };
  }
  function boot(
    projects: ReturnType<typeof project>[],
    reply = "edited foo.ts",
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
      refreshWorkflow: async () => {},
    } as unknown as RibContext;
    return rib.registerTools?.(ctx) ?? [];
  }
  function tool(tools: readonly ToolDefinition[]): ToolDefinition {
    const t = tools.find((x) => x.name === "squad_code");
    if (!t) throw new Error("squad_code not registered");
    return t;
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
  async function add(rec: {
    slug: string;
    name: string;
    tools?: readonly string[];
    status?: "active" | "inactive";
  }) {
    const record: MemberRecord = {
      slug: rec.slug,
      name: rec.name,
      role: "Engineer",
      charter: `# ${rec.name}\n\n## Role\n\nx`,
      status: rec.status ?? "active",
      createdAt: "2026-06-27T00:00:00.000Z",
      ...(rec.tools && rec.tools.length > 0 ? { tools: rec.tools } : {}),
    };
    // A project-bound run reads the team cast FOR that project (projects/p1/members),
    // not the default scope — these tests boot the sole project "p1".
    await scaffoldMember(scopeMembersDir(home, "p1"), record);
  }

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "squad-code-tool-"));
    lastReq = undefined;
  });
  afterEach(async () => {
    rib.dispose?.();
    setSquadDataHome(undefined);
    await rm(home, { recursive: true, force: true });
  });

  test("is registered and state-changing", () => {
    expect(tool(boot([project("p1", "keelson", "/repo/keelson")])).state_changing).toBe(true);
  });

  test("dispatches a confined coding turn for a code-capable member", async () => {
    const tools = boot([project("p1", "keelson", "/repo/keelson")]);
    await add({ slug: "atlas", name: "Atlas", tools: ["code", "read"] });
    const { ctx, out } = capture();
    // An explicit project binds that repo + its scope (projects/p1/members).
    await tool(tools).execute({ member: "atlas", task: "add a flag", project: "keelson" }, ctx);
    expect(out().isError).toBe(false);
    expect(lastReq?.cwd).toBe("/repo/keelson");
    expect(lastReq?.allowedDirectories).toEqual(["/repo/keelson"]);
    expect(lastReq?.allowedTools).toEqual([...CODE_TOOLS]);
    expect(out().content).toContain("Atlas");
  });

  test("refuses a non-code member (never runs a turn)", async () => {
    const tools = boot([project("p1", "keelson", "/repo/keelson")]);
    await add({ slug: "vera", name: "Vera", tools: ["read"] });
    const { ctx, out } = capture();
    await tool(tools).execute({ member: "vera", task: "x", project: "keelson" }, ctx);
    expect(out().isError).toBe(true);
    expect(out().content).toContain('lacks the "code" capability');
    expect(lastReq).toBeUndefined();
  });

  test("refuses an unknown member", async () => {
    const tools = boot([project("p1", "keelson", "/repo/keelson")]);
    const { ctx, out } = capture();
    await tool(tools).execute({ member: "ghost", task: "x", project: "keelson" }, ctx);
    expect(out().isError).toBe(true);
    expect(out().content).toContain("unknown member");
  });

  test("refuses an inactive member", async () => {
    const tools = boot([project("p1", "keelson", "/repo/keelson")]);
    await add({ slug: "atlas", name: "Atlas", tools: ["code"], status: "inactive" });
    const { ctx, out } = capture();
    await tool(tools).execute({ member: "atlas", task: "x", project: "keelson" }, ctx);
    expect(out().isError).toBe(true);
    expect(out().content).toContain("not active");
  });

  test("no selection + no explicit project resolves to the default scope (no repo to code)", async () => {
    const tools = boot([project("p1", "alpha", "/repo/a"), project("p2", "beta", "/repo/b")]);
    // A code-capable member on the DEFAULT scope; with no selection and no arg the run
    // resolves to the default scope (no auto-pick), finds the member, but has no repo.
    await scaffoldMember(scopeMembersDir(home, "default"), {
      slug: "atlas",
      name: "Atlas",
      role: "Engineer",
      charter: "# Atlas\n\n## Role\n\nx",
      status: "active",
      createdAt: "2026-06-27T00:00:00.000Z",
      tools: ["code"],
    });
    const { ctx, out } = capture();
    await tool(tools).execute({ member: "atlas", task: "x" }, ctx);
    expect(out().isError).toBe(true);
    expect(out().content).toContain("no project bound");
    expect(lastReq).toBeUndefined();
  });

  test("fails closed without the agent-turn seam", async () => {
    const bare = {
      getExec: () => ({
        runJSON: async () => ({ ok: true as const, data: undefined }),
        runText: async () => ({ ok: true as const, data: "" }),
      }),
      getDataDir: () => home,
    } as unknown as RibContext;
    const tools = rib.registerTools?.(bare) ?? [];
    const { ctx, out } = capture();
    await tool(tools).execute({ member: "atlas", task: "x" }, ctx);
    expect(out().isError).toBe(true);
    expect(out().content).toContain("seam");
  });
});
