import { describe, expect, test } from "bun:test";
import type { MessageChunk, RibAgentTurn, RibAgentTurnResult } from "@keelson/shared";
import {
  runConfinedTurn,
  TOOL_TRACE_CAP,
  type ToolTrace,
  type TurnOutcome,
} from "../src/turn-runner.ts";

function turnFrom(chunks: MessageChunk[], result: Partial<RibAgentTurnResult>): RibAgentTurn {
  async function* stream(): AsyncGenerator<MessageChunk> {
    for (const c of chunks) yield c;
  }
  return {
    stream: stream(),
    result: Promise.resolve({ status: "ok", text: "done", ...result } as RibAgentTurnResult),
  };
}

async function run(
  chunks: MessageChunk[],
  result: Partial<RibAgentTurnResult> = {},
  onTool?: (tools: readonly ToolTrace[]) => void,
): Promise<TurnOutcome> {
  return runConfinedTurn(() => turnFrom(chunks, result), { prompt: "p" }, 5_000, undefined, onTool);
}

describe("runConfinedTurn stream capture", () => {
  test("folds tool_use chunks into the trace with target digests", async () => {
    const outcome = await run([
      { type: "tool_use", id: "t1", toolName: "Read", toolInput: { file_path: "src/a.ts" } },
      { type: "tool_use", id: "t2", toolName: "Bash", toolInput: { command: "bun test" } },
      { type: "text", content: "working" },
      { type: "done" },
    ]);
    expect(outcome.status).toBe("ok");
    expect(outcome.tools).toEqual([
      { name: "Read", target: "src/a.ts" },
      { name: "Bash", target: "bun test" },
    ]);
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("pairs tool_result onto the originating tool_use and marks errors", async () => {
    const outcome = await run([
      { type: "tool_use", id: "t1", toolName: "Edit", toolInput: { file_path: "b.ts" } },
      { type: "tool_result", toolUseId: "t1", content: "ok" },
      { type: "tool_use", id: "t2", toolName: "Bash", toolInput: { command: "false" } },
      { type: "tool_result", toolUseId: "t2", content: "boom", isError: true },
      { type: "tool_result", toolUseId: "unknown", content: "ignored" },
      { type: "done" },
    ]);
    expect(outcome.tools).toEqual([
      { name: "Edit", target: "b.ts", ok: true },
      { name: "Bash", target: "false", ok: false },
    ]);
  });

  test("caps the trace at TOOL_TRACE_CAP, dropping the oldest", async () => {
    const chunks: MessageChunk[] = [];
    for (let i = 0; i < TOOL_TRACE_CAP + 3; i++) {
      chunks.push({ type: "tool_use", id: `t${i}`, toolName: `tool${i}` });
    }
    chunks.push({ type: "done" });
    const outcome = await run(chunks);
    expect(outcome.tools).toHaveLength(TOOL_TRACE_CAP);
    expect(outcome.tools?.[0]?.name).toBe("tool3");
    expect(outcome.tools?.at(-1)?.name).toBe(`tool${TOOL_TRACE_CAP + 2}`);
  });

  test("carries the settled result's usage", async () => {
    const outcome = await run([{ type: "done" }], {
      usage: { inputTokens: 120, outputTokens: 45 },
    });
    expect(outcome.usage).toEqual({ inputTokens: 120, outputTokens: 45 });
    expect(outcome.tools).toBeUndefined();
  });

  test("notifies onTool with a growing snapshot, and a throwing observer never breaks the turn", async () => {
    const seen: number[] = [];
    const outcome = await run(
      [
        { type: "tool_use", id: "t1", toolName: "Read" },
        { type: "tool_use", id: "t2", toolName: "Grep" },
        { type: "done" },
      ],
      {},
      (tools) => {
        seen.push(tools.length);
        throw new Error("observer bug");
      },
    );
    expect(outcome.status).toBe("ok");
    expect(seen).toEqual([1, 2]);
  });

  test("a timed-out turn still reports the partial trace", async () => {
    async function* hang(): AsyncGenerator<MessageChunk> {
      yield { type: "tool_use", id: "t1", toolName: "Bash", toolInput: { command: "sleep" } };
      await new Promise(() => {}); // never settles
    }
    const turn: RibAgentTurn = { stream: hang(), result: new Promise(() => {}) };
    const outcome = await runConfinedTurn(() => turn, { prompt: "p" }, 50);
    expect(outcome.status).toBe("timeout");
    expect(outcome.tools).toEqual([{ name: "Bash", target: "sleep" }]);
  });
});
