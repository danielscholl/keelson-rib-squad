import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  MessageChunk,
  RibAgentTurn,
  RibAgentTurnRequest,
  RibAgentTurnResult,
} from "@keelson/shared";
import {
  type CastProposalRecord,
  clearProposal,
  MAX_CAST_MEMBERS,
  proposeCast,
  readProposal,
  SCAN_TOOLS,
  writeProposal,
} from "../src/cast.ts";

// proposeCast takes the agent-turn seam as a parameter, so these drive it against a
// FAKE runAgentTurn — the scan reply is canned, and the captured request proves the
// confinement (cwd + allowedDirectories + read-only tool rail). No server, no provider.

async function* oneChunkStream(text: string): AsyncGenerator<MessageChunk> {
  yield { type: "text", content: text };
  yield { type: "done" };
}
const okResult = (text: string): RibAgentTurnResult => ({ status: "ok", text });
function fakeTurn(result: Promise<RibAgentTurnResult>): RibAgentTurn {
  return { stream: oneChunkStream("x"), result };
}

const PROJECT = { id: "p1", name: "keelson", rootPath: "/repo/keelson" };

function rosterReply(members: unknown[], summary = "a tuned team"): string {
  return JSON.stringify({ members, summary });
}

describe("proposeCast", () => {
  test("confines the scan to the project root with a read-only tool rail", async () => {
    let req: RibAgentTurnRequest | undefined;
    const runAgentTurn = (r: RibAgentTurnRequest): RibAgentTurn => {
      req = r;
      return fakeTurn(
        Promise.resolve(
          okResult(
            rosterReply([{ name: "Atlas", role: "Engineer", charter: "# Atlas", tools: ["read"] }]),
          ),
        ),
      );
    };

    const result = await proposeCast({ runAgentTurn, project: PROJECT, mission: "ship search" });
    expect(result.ok).toBe(true);
    expect(req?.cwd).toBe("/repo/keelson");
    expect(req?.allowedDirectories).toEqual(["/repo/keelson"]);
    expect(req?.allowedTools).toEqual([...SCAN_TOOLS]);
    // The mission rides into the prompt so the scan can tune the team to it.
    expect(req?.prompt).toContain("ship search");
  });

  test("injects the available providers and the role→engine heuristic into the scan", async () => {
    let req: RibAgentTurnRequest | undefined;
    const runAgentTurn = (r: RibAgentTurnRequest): RibAgentTurn => {
      req = r;
      return fakeTurn(
        Promise.resolve(
          okResult(rosterReply([{ name: "Atlas", role: "Engineer", charter: "# Atlas" }])),
        ),
      );
    };
    await proposeCast({
      runAgentTurn,
      project: PROJECT,
      providers: [
        { id: "claude", displayName: "Claude" },
        { id: "copilot", displayName: "Copilot" },
      ],
    });
    // The available provider ids and the overpowered heuristic reach the scan turn.
    expect(req?.prompt).toContain('"claude"');
    expect(req?.prompt).toContain('"copilot"');
    expect(req?.prompt).toContain("OVERPOWERED");
  });

  test("excludes internal non-chat providers (workflow, stub) from the offered catalog", async () => {
    let req: RibAgentTurnRequest | undefined;
    const runAgentTurn = (r: RibAgentTurnRequest): RibAgentTurn => {
      req = r;
      return fakeTurn(
        Promise.resolve(
          okResult(rosterReply([{ name: "Atlas", role: "Engineer", charter: "# Atlas" }])),
        ),
      );
    };
    await proposeCast({
      runAgentTurn,
      project: PROJECT,
      providers: [
        { id: "copilot", displayName: "GitHub Copilot" },
        { id: "workflow", displayName: "Workflow" },
        { id: "stub", displayName: "Stub" },
      ],
    });
    expect(req?.prompt).toContain('"copilot"');
    expect(req?.prompt).not.toContain('"workflow"');
    expect(req?.prompt).not.toContain('"stub"');
  });

  test("carries the scan's per-member provider/model assignment through", async () => {
    const runAgentTurn = (): RibAgentTurn =>
      fakeTurn(
        Promise.resolve(
          okResult(
            rosterReply([
              {
                name: "Atlas",
                role: "Tech Lead",
                charter: "# Atlas",
                provider: "claude",
                model: "claude-opus-4-8",
              },
              { name: "Vera", role: "Triager", charter: "# Vera", provider: "copilot" },
            ]),
          ),
        ),
      );
    const result = await proposeCast({
      runAgentTurn,
      project: PROJECT,
      providers: [
        { id: "claude", displayName: "Claude" },
        { id: "copilot", displayName: "Copilot" },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Fully-pinned lead survives; the vendor-only triager keeps its provider, no model.
    expect(result.proposal.members[0]).toMatchObject({
      provider: "claude",
      model: "claude-opus-4-8",
    });
    expect(result.proposal.members[1]?.provider).toBe("copilot");
    expect(result.proposal.members[1]?.model).toBeUndefined();
  });

  test("omits the assignment block when no providers are available", async () => {
    let req: RibAgentTurnRequest | undefined;
    const runAgentTurn = (r: RibAgentTurnRequest): RibAgentTurn => {
      req = r;
      return fakeTurn(
        Promise.resolve(
          okResult(rosterReply([{ name: "Atlas", role: "Engineer", charter: "# Atlas" }])),
        ),
      );
    };
    await proposeCast({ runAgentTurn, project: PROJECT, providers: [] });
    expect(req?.prompt).not.toContain("AVAILABLE on this harness");
    expect(req?.prompt).not.toContain("OVERPOWERED");
  });

  test("parses the structured roster and keeps each member's capability tags", async () => {
    const runAgentTurn = (): RibAgentTurn =>
      fakeTurn(
        Promise.resolve(
          okResult(
            rosterReply([
              { name: "Atlas", role: "Engineer", charter: "# Atlas", tools: ["code", "read"] },
              { name: "Vera", role: "Reviewer", charter: "# Vera" },
            ]),
          ),
        ),
      );
    const result = await proposeCast({ runAgentTurn, project: PROJECT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposal.members.map((m) => m.name)).toEqual(["Atlas", "Vera"]);
    expect(result.proposal.members[0]?.tools).toEqual(["code", "read"]);
    // No tags declared -> text-only (tools omitted).
    expect(result.proposal.members[1]?.tools).toBeUndefined();
    expect(result.proposal.summary).toBe("a tuned team");
    expect(result.proposal.projectName).toBe("keelson");
  });

  test("dedupes/trims capability tags and keeps a provider with no model (vendor pin)", async () => {
    const runAgentTurn = (): RibAgentTurn =>
      fakeTurn(
        Promise.resolve(
          okResult(
            rosterReply([
              {
                name: "Atlas",
                role: "Engineer",
                charter: "# Atlas",
                tools: ["code", " code ", "read", ""],
                provider: "anthropic",
              },
            ]),
          ),
        ),
      );
    const result = await proposeCast({ runAgentTurn, project: PROJECT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposal.members[0]?.tools).toEqual(["code", "read"]);
    // A provider may stand alone — pin the vendor, default model.
    expect(result.proposal.members[0]?.provider).toBe("anthropic");
    expect(result.proposal.members[0]?.model).toBeUndefined();
  });

  test("extracts the JSON object from a fenced / prose-wrapped reply", async () => {
    const fenced =
      "Here is the team:\n```json\n" +
      rosterReply([{ name: "Atlas", role: "Engineer", charter: "# Atlas" }]) +
      "\n```\nDone.";
    const runAgentTurn = (): RibAgentTurn => fakeTurn(Promise.resolve(okResult(fenced)));
    const result = await proposeCast({ runAgentTurn, project: PROJECT });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.proposal.members[0]?.name).toBe("Atlas");
  });

  test("caps the proposed team at maxMembers and records a truncation note", async () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      name: `M${i}`,
      role: "Engineer",
      charter: `# M${i}`,
    }));
    const runAgentTurn = (): RibAgentTurn => fakeTurn(Promise.resolve(okResult(rosterReply(many))));
    const result = await proposeCast({ runAgentTurn, project: PROJECT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposal.members).toHaveLength(MAX_CAST_MEMBERS);
    expect(result.proposal.notes.some((n) => n.includes(`capped to ${MAX_CAST_MEMBERS}`))).toBe(
      true,
    );
  });

  test("rejects a malformed scan reply (no valid roster)", async () => {
    const runAgentTurn = (): RibAgentTurn =>
      fakeTurn(Promise.resolve(okResult("I could not figure out a team, sorry.")));
    const result = await proposeCast({ runAgentTurn, project: PROJECT });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("valid roster");
  });

  test("rejects an empty members array (schema floor)", async () => {
    const runAgentTurn = (): RibAgentTurn => fakeTurn(Promise.resolve(okResult(rosterReply([]))));
    const result = await proposeCast({ runAgentTurn, project: PROJECT });
    expect(result.ok).toBe(false);
  });

  test("fails closed when the project has no root path to confine", async () => {
    let called = false;
    const runAgentTurn = (): RibAgentTurn => {
      called = true;
      return fakeTurn(Promise.resolve(okResult(rosterReply([]))));
    };
    const result = await proposeCast({
      runAgentTurn,
      project: { id: "p1", name: "keelson", rootPath: "   " },
    });
    expect(result.ok).toBe(false);
    expect(called).toBe(false);
  });

  test("surfaces a failed scan turn as an error", async () => {
    const runAgentTurn = (): RibAgentTurn =>
      fakeTurn(Promise.resolve({ status: "error", text: "", error: "provider blew up" }));
    const result = await proposeCast({ runAgentTurn, project: PROJECT });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("provider blew up");
  });

  test("a scan whose result outlives the timeout is reported as a timeout", async () => {
    const runAgentTurn = (): RibAgentTurn => ({
      stream: oneChunkStream("x"),
      result: new Promise((resolve) =>
        setTimeout(
          () => resolve(okResult(rosterReply([{ name: "A", role: "E", charter: "# A" }]))),
          60,
        ),
      ),
    });
    const result = await proposeCast({ runAgentTurn, project: PROJECT, timeoutMs: 20 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("timeout");
  });
});

describe("cast proposal store", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "squad-cast-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const record = (): CastProposalRecord => ({
    projectId: "p1",
    projectName: "keelson",
    rootPath: "/repo/keelson",
    mission: "ship search",
    members: [{ name: "Atlas", role: "Engineer", charter: "# Atlas", tools: ["code", "read"] }],
    summary: "a tuned team",
    notes: [],
    createdAt: "2026-06-27T00:00:00.000Z",
  });

  test("round-trips a proposal through write/read", async () => {
    await writeProposal(home, record());
    const back = await readProposal(home);
    expect(back?.projectName).toBe("keelson");
    expect(back?.members[0]?.tools).toEqual(["code", "read"]);
    expect(back?.members[0]?.identitySlot).toBe(0);
  });

  test("normalizes missing and invalid identity slots to cast-order slots within 0-4", async () => {
    await writeProposal(home, {
      ...record(),
      members: [
        { name: "A", role: "Engineer", charter: "# A", identitySlot: 3 },
        { name: "B", role: "Reviewer", charter: "# B", identitySlot: 9 },
        { name: "C", role: "Tester", charter: "# C", identitySlot: -1 },
        { name: "D", role: "Docs", charter: "# D" },
        { name: "E", role: "DevOps", charter: "# E", identitySlot: 4 },
        { name: "F", role: "Security", charter: "# F" },
      ],
    });
    const back = await readProposal(home);
    expect(back?.members.map((m) => m.identitySlot)).toEqual([3, 1, 2, 3, 4, 4]);
  });

  test("read returns undefined when there is no proposal", async () => {
    expect(await readProposal(home)).toBeUndefined();
  });

  test("clear removes the proposal (idempotent)", async () => {
    await writeProposal(home, record());
    await clearProposal(home);
    expect(await readProposal(home)).toBeUndefined();
    // Clearing again is a no-op, not a throw.
    await clearProposal(home);
  });
});
