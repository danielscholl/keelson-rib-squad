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

// A turn whose stream carries the tool_use chunks the scan receipt is counted from.
function fakeTurnWithChunks(chunks: MessageChunk[], result: Promise<RibAgentTurnResult>) {
  async function* s(): AsyncGenerator<MessageChunk> {
    for (const c of chunks) yield c;
    yield { type: "done" };
  }
  return { stream: s(), result } as RibAgentTurn;
}
const readChunk = (path: string): MessageChunk => ({
  type: "tool_use",
  toolName: "Read",
  toolInput: { file_path: path },
});

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

  test("castAs flows through the proposal when the scan turn returns one", async () => {
    const runAgentTurn = (): RibAgentTurn =>
      fakeTurn(
        Promise.resolve(
          okResult(
            rosterReply([
              {
                name: "Atlas",
                role: "Engineer",
                charter: "# Atlas",
                castAs: {
                  newThemeLabel: "Apollo 13",
                  characterName: "Gene Kranz",
                  personality: "Unflappable.",
                  backstory: "Brings the crew home.",
                },
              },
            ]),
          ),
        ),
      );
    const result = await proposeCast({ runAgentTurn, project: PROJECT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposal.members[0]?.castAs).toEqual({
      newThemeLabel: "Apollo 13",
      characterName: "Gene Kranz",
      personality: "Unflappable.",
      backstory: "Brings the crew home.",
    });
  });

  test("dataHome supplies the squad's casting context into the scan prompt", async () => {
    const home = await mkdtemp(join(tmpdir(), "squad-cast-ctx-"));
    try {
      let req: RibAgentTurnRequest | undefined;
      const runAgentTurn = (r: RibAgentTurnRequest): RibAgentTurn => {
        req = r;
        return fakeTurn(
          Promise.resolve(
            okResult(rosterReply([{ name: "Atlas", role: "Engineer", charter: "# Atlas" }])),
          ),
        );
      };
      await proposeCast({ runAgentTurn, project: PROJECT, dataHome: home });
      // A fresh registry at this data home -> a themed context with the static
      // catalog rendered as inspiration.
      expect(req?.prompt).toContain("Casting context:");
      expect(req?.prompt).toContain("The Usual Suspects");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("an omitted dataHome still proposes a team (degrades to a fresh casting context)", async () => {
    let req: RibAgentTurnRequest | undefined;
    const runAgentTurn = (r: RibAgentTurnRequest): RibAgentTurn => {
      req = r;
      return fakeTurn(
        Promise.resolve(
          okResult(rosterReply([{ name: "Atlas", role: "Engineer", charter: "# Atlas" }])),
        ),
      );
    };
    const result = await proposeCast({ runAgentTurn, project: PROJECT });
    expect(result.ok).toBe(true);
    expect(req?.prompt).toContain("Casting context:");
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

  test("carries the scan's per-member rationale through, trimmed", async () => {
    const runAgentTurn = (): RibAgentTurn =>
      fakeTurn(
        Promise.resolve(
          okResult(
            rosterReply([
              {
                name: "Atlas",
                role: "Engineer",
                charter: "# Atlas",
                rationale: "  src/search/ has 40 files and no owner.  ",
              },
              { name: "Vera", role: "Reviewer", charter: "# Vera" },
            ]),
          ),
        ),
      );
    const result = await proposeCast({ runAgentTurn, project: PROJECT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposal.members[0]?.rationale).toBe("src/search/ has 40 files and no owner.");
    // The field is optional: a scan that skips it still yields a usable proposal —
    // the board falls back to the charter excerpt rather than dropping the seat.
    expect(result.proposal.members[1]?.rationale).toBeUndefined();
  });

  test("asks the scan to justify each seat against real files", async () => {
    let req: RibAgentTurnRequest | undefined;
    const runAgentTurn = (r: RibAgentTurnRequest): RibAgentTurn => {
      req = r;
      return fakeTurn(Promise.resolve(okResult(rosterReply([]))));
    };
    await proposeCast({ runAgentTurn, project: PROJECT });
    expect(req?.prompt).toContain("rationale");
    expect(req?.prompt).toContain("naming the real files or directories");
  });

  // The receipt is the only thing on the cast board the model can't author. It is
  // counted off the turn's own tool_use chunks, so these drive real chunk streams.
  test("counts the files the scan actually read, deduped, plus its searches", async () => {
    const runAgentTurn = (): RibAgentTurn =>
      fakeTurnWithChunks(
        [
          readChunk("/repo/keelson/src/index.ts"),
          readChunk("/repo/keelson/src/cast.ts"),
          // The same file twice is one file read.
          readChunk("/repo/keelson/src/index.ts"),
          { type: "tool_use", toolName: "Glob", toolInput: { pattern: "src/**/*.ts" } },
          { type: "tool_use", toolName: "Grep", toolInput: { pattern: "registerTools" } },
        ],
        Promise.resolve(okResult(rosterReply([{ name: "A", role: "Engineer", charter: "# A" }]))),
      );
    const result = await proposeCast({ runAgentTurn, project: PROJECT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposal.read?.files).toEqual([
      "/repo/keelson/src/cast.ts",
      "/repo/keelson/src/index.ts",
    ]);
    // A Glob matching 200 paths read none of them — only a Read proves a file was opened.
    expect(result.proposal.read?.searches).toBe(2);
    expect(result.proposal.read?.ms).toBeGreaterThanOrEqual(0);
  });

  test("omits the receipt when the provider reports no readable tool input", async () => {
    // toolInput is optional in the contract, and casting pins members across providers —
    // an empty capture must render no receipt rather than "0 files read", and must never
    // fall back to the model's own account of what it read.
    const runAgentTurn = (): RibAgentTurn =>
      fakeTurnWithChunks(
        [
          { type: "tool_use", toolName: "Read" },
          { type: "tool_use", toolName: "Grep", toolInput: { pattern: "x" } },
        ],
        Promise.resolve(okResult(rosterReply([{ name: "A", role: "Engineer", charter: "# A" }]))),
      );
    const result = await proposeCast({ runAgentTurn, project: PROJECT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposal.read).toBeUndefined();
  });

  test("a scan that read nothing at all carries no receipt", async () => {
    const runAgentTurn = (): RibAgentTurn =>
      fakeTurn(
        Promise.resolve(okResult(rosterReply([{ name: "A", role: "Engineer", charter: "# A" }]))),
      );
    const result = await proposeCast({ runAgentTurn, project: PROJECT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposal.read).toBeUndefined();
  });

  test("dedupes/trims capability tags and tool allowlists", async () => {
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
                toolAllowlist: ["osdu_quality", " osdu_quality ", ""],
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
    expect(result.proposal.members[0]?.toolAllowlist).toEqual(["osdu_quality"]);
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
    members: [
      {
        name: "Atlas",
        role: "Engineer",
        charter: "# Atlas",
        tools: ["code", "read"],
        toolAllowlist: ["osdu_quality"],
      },
    ],
    summary: "a tuned team",
    notes: [],
    createdAt: "2026-06-27T00:00:00.000Z",
  });

  test("round-trips a proposal through write/read", async () => {
    await writeProposal(home, record());
    const back = await readProposal(home);
    expect(back?.projectName).toBe("keelson");
    expect(back?.members[0]?.tools).toEqual(["code", "read"]);
    expect(back?.members[0]?.toolAllowlist).toEqual(["osdu_quality"]);
    expect(back?.members[0]?.identitySlot).toBe(0);
  });

  // readProposal is an allowlist, not a passthrough: normalizeStoredMember rebuilds
  // each member field by field, so a field it forgets is dropped silently — and a
  // collector that "degrades, never throws" guarantees the silence. These pin the
  // subset-approve fields to the read path.
  test("round-trips picked:false and the scan's rationale", async () => {
    const r = record();
    r.members[0] = { ...r.members[0]!, picked: false, rationale: "src/search/ has no owner." };
    await writeProposal(home, r);
    const back = await readProposal(home);
    expect(back?.members[0]?.picked).toBe(false);
    expect(back?.members[0]?.rationale).toBe("src/search/ has no owner.");
  });

  test("an absent picked flag reads as a picked seat — nothing to migrate", async () => {
    await writeProposal(home, record());
    const back = await readProposal(home);
    // Every proposal written before subset approve is on disk in exactly this shape.
    expect(back?.members[0]?.picked).toBeUndefined();
    expect(back?.members[0]?.picked !== false).toBe(true);
  });

  test("backfills a slug the pick verb can address when the file lacks one", async () => {
    await writeProposal(home, record());
    const back = await readProposal(home);
    expect(back?.members[0]?.slug).toBe("atlas");
  });

  test("round-trips the scan receipt", async () => {
    await writeProposal(home, {
      ...record(),
      read: { files: ["src/a.ts", "src/b.ts"], searches: 4, ms: 41_000 },
    });
    const back = await readProposal(home);
    expect(back?.read).toEqual({ files: ["src/a.ts", "src/b.ts"], searches: 4, ms: 41_000 });
  });

  test("drops a receipt with no files — it isn't a receipt, it's a claim we can't make", async () => {
    await writeProposal(home, {
      ...record(),
      read: { files: [], searches: 9, ms: 41_000 },
    });
    expect((await readProposal(home))?.read).toBeUndefined();
  });

  test("a proposal with no receipt reads back cleanly", async () => {
    await writeProposal(home, record());
    const back = await readProposal(home);
    expect(back?.read).toBeUndefined();
    expect(back?.members).toHaveLength(1);
  });

  test("normalizes missing and invalid identity slots to cast-order slots", async () => {
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
    // F is the 6th seat against five hues: it takes the out-of-ramp sentinel and
    // renders neutral rather than repeating E's id-olive.
    expect(back?.members.map((m) => m.identitySlot)).toEqual([3, 1, 2, 3, 4, 5]);
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
