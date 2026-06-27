import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageChunk, RibAgentTurn, RibContext } from "@keelson/shared";
import type { Member } from "../src/types.ts";
import { authorWorkflow, validateWorkflowDef } from "../src/workflow-authoring.ts";

async function* stream(text: string): AsyncGenerator<MessageChunk> {
  yield { type: "text", content: text };
  yield { type: "done" };
}
function fakeTurn(text: string, status: "ok" | "error" = "ok"): RibAgentTurn {
  return {
    stream: stream("x"),
    result: Promise.resolve(
      status === "ok" ? { status, text } : { status, text: "", error: "boom" },
    ),
  };
}
function run(text: string, status: "ok" | "error" = "ok"): NonNullable<RibContext["runAgentTurn"]> {
  return () => fakeTurn(text, status);
}
const MEMBER: Member = {
  slug: "planner",
  name: "Planner",
  role: "Planner",
  charter: "# Planner\n\n## Role\n\nDesigns workflows.",
  status: "active",
  tools: ["read"],
};

const VALID = JSON.stringify({
  name: "Nightly Lint",
  description: "lint then report",
  nodes: [
    { id: "lint", bash: "bun run check" },
    { id: "report", prompt: "summarize the lint result", needs: ["lint"] },
  ],
});

describe("validateWorkflowDef", () => {
  test("accepts a well-formed DAG", () => {
    const r = validateWorkflowDef(JSON.parse(VALID));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.def.name).toBe("Nightly Lint");
      expect(r.def.nodes).toHaveLength(2);
    }
  });

  test("rejects a non-object", () => {
    expect(validateWorkflowDef("nope").ok).toBe(false);
    expect(validateWorkflowDef(null).ok).toBe(false);
  });

  test("rejects a missing name", () => {
    expect(validateWorkflowDef({ nodes: [{ id: "a", bash: "x" }] }).ok).toBe(false);
  });

  test("rejects missing / empty nodes", () => {
    expect(validateWorkflowDef({ name: "x", nodes: [] }).ok).toBe(false);
    expect(validateWorkflowDef({ name: "x" }).ok).toBe(false);
  });

  test("rejects a node with no id", () => {
    expect(validateWorkflowDef({ name: "x", nodes: [{ bash: "x" }] }).ok).toBe(false);
  });

  test("rejects duplicate node ids", () => {
    const r = validateWorkflowDef({
      name: "x",
      nodes: [
        { id: "a", bash: "x" },
        { id: "a", prompt: "y" },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("duplicate");
  });

  test("rejects a node with zero or multiple node-type keys", () => {
    expect(validateWorkflowDef({ name: "x", nodes: [{ id: "a" }] }).ok).toBe(false);
    expect(
      validateWorkflowDef({ name: "x", nodes: [{ id: "a", bash: "x", prompt: "y" }] }).ok,
    ).toBe(false);
  });

  test("rejects a dangling needs reference", () => {
    const r = validateWorkflowDef({
      name: "x",
      nodes: [{ id: "a", bash: "x", needs: ["ghost"] }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("ghost");
  });
});

describe("authorWorkflow", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "squad-wf-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  test("authors, validates, and persists a workflow artifact", async () => {
    const r = await authorWorkflow({
      runAgentTurn: run(`Here is the workflow.\n${VALID}`),
      membersRoot: home,
      dataHome: home,
      member: MEMBER,
      task: "lint nightly and report",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.name).toBe("Nightly Lint");
      expect(r.nodeCount).toBe(2);
      expect(r.path).toContain("authored-workflows/nightly-lint.json");
      const persisted = JSON.parse(await readFile(r.path, "utf8"));
      expect(persisted.name).toBe("Nightly Lint");
      expect(persisted.nodes).toHaveLength(2);
    }
  });

  test("fails closed on malformed JSON", async () => {
    const r = await authorWorkflow({
      runAgentTurn: run("{ not json at all"),
      membersRoot: home,
      dataHome: home,
      member: MEMBER,
      task: "x",
    });
    expect(r.ok).toBe(false);
  });

  test("fails closed on a structurally-invalid workflow", async () => {
    const r = await authorWorkflow({
      runAgentTurn: run('{"name":"x","nodes":[]}'),
      membersRoot: home,
      dataHome: home,
      member: MEMBER,
      task: "x",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("invalid workflow");
  });

  test("surfaces an authoring-turn failure", async () => {
    const r = await authorWorkflow({
      runAgentTurn: run("", "error"),
      membersRoot: home,
      dataHome: home,
      member: MEMBER,
      task: "x",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("authoring turn");
  });
});
