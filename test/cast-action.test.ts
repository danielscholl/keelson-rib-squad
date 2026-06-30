import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageChunk, RibAgentTurn, RibAgentTurnRequest, RibContext } from "@keelson/shared";
import { readProposal } from "../src/cast.ts";
import { loadRegistry, saveRegistry } from "../src/casting/registry.ts";
import rib from "../src/index.ts";
import { CAST_KEY } from "../src/keys.ts";
import { readMembers } from "../src/member-store.ts";
import { membersDir, scopeMembersDir, setSquadDataHome } from "../src/paths.ts";
import { writeSelectedProject } from "../src/scope.ts";

// onAction reads the runAgentTurn / getProjects / refreshWorkflow seams captured in
// registerTools, so each test boots the rib with a fake ctx (a canned scan reply, a
// project list, an in-memory data home) and disposes after — no server, no provider.

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

function bootRib(projects: ReturnType<typeof project>[], reply = ROSTER_REPLY): void {
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
  } as unknown as RibContext;
  rib.registerTools?.(ctx);
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

describe("cast-propose action", () => {
  test("scans the sole project, persists the proposal, and opens the cast canvas", async () => {
    bootRib([project("p1", "keelson", "/repo/keelson")]);
    const res = await rib.onAction?.(
      { type: "cast-propose", payload: { project: "keelson" } },
      {} as RibContext,
    );
    expect(res?.ok).toBe(true);
    if (res?.ok) {
      expect(res.data).toEqual({ effect: "open-canvas", key: CAST_KEY, title: "Proposed squad" });
    }
    // The scan was confined to the project root with the read-only rail.
    expect(lastReq?.cwd).toBe("/repo/keelson");
    expect(lastReq?.allowedDirectories).toEqual(["/repo/keelson"]);
    expect(lastReq?.allowedTools).toEqual(["Read", "Glob", "Grep"]);
    // The proposal landed on disk and the cast panel was refreshed.
    const proposal = await readProposal(home);
    expect(proposal?.members.map((m) => m.name)).toEqual(["Atlas", "Vera"]);
    expect(refreshed).toContain("squad-cast");
  });

  test("carries the operator mission into the scan", async () => {
    bootRib([project("p1", "keelson", "/repo/keelson")]);
    await rib.onAction?.(
      {
        type: "cast-propose",
        payload: { project: "keelson", mission: "ship the OSDU search rib" },
      },
      {} as RibContext,
    );
    expect(lastReq?.prompt).toContain("ship the OSDU search rib");
  });

  test("rejects an unknown project selector, listing the choices", async () => {
    bootRib([project("p1", "keelson", "/repo/keelson")]);
    const res = await rib.onAction?.(
      { type: "cast-propose", payload: { project: "nope" } },
      {} as RibContext,
    );
    expect(res?.ok).toBe(false);
    if (!res?.ok) expect(res?.error).toContain('unknown project "nope"');
  });

  test("with no selection and no explicit project, requires a project to cast for", async () => {
    bootRib([project("p1", "alpha", "/repo/a"), project("p2", "beta", "/repo/b")]);
    const res = await rib.onAction?.({ type: "cast-propose", payload: {} }, {} as RibContext);
    expect(res?.ok).toBe(false);
    if (!res?.ok) expect(res?.error).toContain("select a project");
    expect(await readProposal(home)).toBeUndefined();
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

describe("approve-cast / discard-cast actions", () => {
  test("approve themes + scaffolds the proposed members (with tags) and clears the proposal", async () => {
    bootRib([project("p1", "keelson", "/repo/keelson")]);
    await rib.onAction?.(
      { type: "cast-propose", payload: { project: "keelson" } },
      {} as RibContext,
    );
    const res = await rib.onAction?.({ type: "approve-cast" }, {} as RibContext);
    expect(res?.ok).toBe(true);
    if (res?.ok) {
      const data = res.data as { created: string[]; skipped: string[]; truncated: number };
      // Two members scaffolded under their themed (cast) slugs, not the proposed ones.
      expect(data.created).toHaveLength(2);
    }
    const members = await readMembers(membersDir());
    // The proposed names became originalName; casting routes the tags through.
    const atlas = members.find((m) => m.originalName === "Atlas");
    expect(atlas?.tools).toEqual(["code", "read"]);
    expect(atlas?.themeId).toBeDefined();
    expect(atlas?.personality).toBeTruthy();
    expect(atlas?.name).not.toBe("Atlas");
    // The whole roster is cast from ONE ensemble (a coherent squad).
    expect(new Set(members.map((m) => m.themeId)).size).toBe(1);
    // The proposal was consumed; the roster + cast panels refreshed.
    expect(await readProposal(home)).toBeUndefined();
    expect(refreshed).toContain("squad-roster");
  });

  test("approve fails closed with no pending proposal", async () => {
    bootRib([project("p1", "keelson", "/repo/keelson")]);
    const res = await rib.onAction?.({ type: "approve-cast" }, {} as RibContext);
    expect(res?.ok).toBe(false);
    if (!res?.ok) expect(res?.error).toContain("no proposal");
  });

  test("approve is collision-safe — re-approving the same cast skips existing members", async () => {
    bootRib([project("p1", "keelson", "/repo/keelson")]);
    await rib.onAction?.(
      { type: "cast-propose", payload: { project: "keelson" } },
      {} as RibContext,
    );
    await rib.onAction?.({ type: "approve-cast" }, {} as RibContext);
    // Cast + approve again — the authored members must not be clobbered.
    await rib.onAction?.(
      { type: "cast-propose", payload: { project: "keelson" } },
      {} as RibContext,
    );
    const res = await rib.onAction?.({ type: "approve-cast" }, {} as RibContext);
    expect(res?.ok).toBe(true);
    if (res?.ok) {
      const data = res.data as { created: string[]; skipped: string[] };
      // Stable casting: the same proposed names re-resolve to the same themed slugs,
      // so the second approve skips them — no duplicate members under fresh names.
      expect(data.created).toEqual([]);
      expect(data.skipped).toHaveLength(2);
    }
    expect(await readMembers(membersDir())).toHaveLength(2);
  });

  test("discard clears the pending proposal", async () => {
    bootRib([project("p1", "keelson", "/repo/keelson")]);
    await rib.onAction?.(
      { type: "cast-propose", payload: { project: "keelson" } },
      {} as RibContext,
    );
    const res = await rib.onAction?.({ type: "discard-cast" }, {} as RibContext);
    expect(res?.ok).toBe(true);
    expect(await readProposal(home)).toBeUndefined();
    expect(refreshed).toContain("squad-cast");
  });

  test("cast↔run scope agree: a team cast for the SELECTED project lands under its scope", async () => {
    bootRib([project("px", "proj-x", "/repo/x")]);
    // Select project X — the single source of truth a no-arg cast (and a no-arg run)
    // both key on. Casting with no explicit field scans X and stores under X's scope.
    await writeSelectedProject(home, {
      scopeId: "px",
      projectId: "px",
      name: "proj-x",
      rootPath: "/repo/x",
      at: "2026-06-30T00:00:00.000Z",
    });
    await rib.onAction?.({ type: "cast-propose", payload: {} }, {} as RibContext);
    const res = await rib.onAction?.({ type: "approve-cast" }, {} as RibContext);
    expect(res?.ok).toBe(true);
    // Members land under projects/px/members (the selection's scope), NOT the default
    // tree — so a no-arg squad_coordinate/squad_code with X selected reads this team.
    expect(await readMembers(scopeMembersDir(home, "px"))).toHaveLength(2);
    expect(await readMembers(membersDir())).toHaveLength(0);
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
