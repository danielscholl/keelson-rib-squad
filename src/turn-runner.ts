import type {
  MessageChunk,
  RibAgentTurn,
  RibAgentTurnResult,
  RibContext,
  TokenUsage,
} from "@keelson/shared";
import { errText } from "@keelson/shared";

// One confined agent turn run to its settled result, the discipline cast.ts and
// dispatch.ts each established: own a per-turn AbortController linked to the parent
// signal, consume the stream (the result stays the source of truth for text), and race
// the result against a timeout — aborting the turn on timeout so a hung provider can't
// wedge the caller. Never throws; every failure mode maps to a TurnOutcome the caller
// surfaces. Consuming (not draining) the stream is what makes squad minds observable:
// tool_use/tool_result chunks fold into a capped trace the ledger and live board carry.

// One observed tool call: the name, a short digest of its most identifying argument,
// and whether its result came back clean. `ok` stays unset until the result pairs.
export interface ToolTrace {
  name: string;
  target?: string;
  ok?: boolean;
}

export interface TurnOutcome {
  status: "ok" | "error" | "timeout" | "aborted";
  text: string;
  error?: string;
  // The provider id the host resolved the turn to (RibAgentTurnResult.providerId) — carried
  // so the caller can attribute work to the vendor that produced it (the mixed-provider story).
  providerId?: string;
  // Folded from the turn's stream; present on every terminal status (a timed-out turn's
  // partial trace is exactly what the operator needs to see).
  tools?: ToolTrace[];
  // From the settled result's usage-bearing chunk; absent when the provider reported none.
  usage?: TokenUsage;
  durationMs?: number;
}

// Rolling per-turn trace bound: enough to show the work's shape without letting a
// long build loop grow the ledger unbounded. Oldest entries fall off.
export const TOOL_TRACE_CAP = 24;
const TARGET_CAP = 120;

type RunAgentTurn = NonNullable<RibContext["runAgentTurn"]>;
// The request a confined turn supplies; the runner owns abortSignal + timeoutMs.
export type ConfinedTurnRequest = Omit<Parameters<RunAgentTurn>[0], "abortSignal" | "timeoutMs">;

export async function runConfinedTurn(
  run: RunAgentTurn,
  req: ConfinedTurnRequest,
  timeoutMs: number,
  parentSignal?: AbortSignal,
  // Fired after each trace mutation with the current snapshot; throttling is the
  // caller's job. A throwing observer must never break the turn (guarded below).
  onTool?: (tools: readonly ToolTrace[]) => void,
): Promise<TurnOutcome> {
  if (parentSignal?.aborted) return { status: "aborted", text: "" };

  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  parentSignal?.addEventListener("abort", onParentAbort, { once: true });

  const startedAt = Date.now();
  const trace: TraceState = { entries: [], ids: [], byId: new Map() };
  // Snapshot at return: a timed-out turn's consume keeps running in the background,
  // so the outcome must carry a copy, not the live array.
  const outcomeTools = (): Pick<TurnOutcome, "tools" | "durationMs"> => ({
    ...(trace.entries.length > 0 ? { tools: trace.entries.map((t) => ({ ...t })) } : {}),
    durationMs: Date.now() - startedAt,
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const turn: RibAgentTurn = run({ ...req, abortSignal: controller.signal, timeoutMs });
    // Wrap so neither branch rejects: a timed-out turn's still-pending consume must not
    // surface as an unhandled rejection once the race has settled.
    const settled = consumeResult(turn, trace, onTool).then(
      (result) => ({ kind: "result" as const, result }),
      (err) => ({ kind: "error" as const, err }),
    );
    const timed = new Promise<{ kind: "timeout" }>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ kind: "timeout" });
      }, timeoutMs);
    });

    const outcome = await Promise.race([settled, timed]);
    if (outcome.kind === "timeout") {
      return {
        status: "timeout",
        text: "",
        error: `agent turn exceeded ${timeoutMs}ms`,
        ...outcomeTools(),
      };
    }
    if (outcome.kind === "error") {
      return { status: "error", text: "", error: errText(outcome.err), ...outcomeTools() };
    }
    const result = outcome.result;
    if (controller.signal.aborted || result.status === "aborted") {
      return { status: "aborted", text: result.text ?? "", ...outcomeTools() };
    }
    if (result.status === "ok") {
      return {
        status: "ok",
        text: result.text,
        ...(result.providerId ? { providerId: result.providerId } : {}),
        ...(result.usage ? { usage: result.usage } : {}),
        ...outcomeTools(),
      };
    }
    return {
      status: result.status,
      text: "",
      error: result.error ?? result.text ?? `turn ${result.status}`,
      ...outcomeTools(),
    };
  } catch (e) {
    return { status: "error", text: "", error: errText(e), ...outcomeTools() };
  } finally {
    if (timer) clearTimeout(timer);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}

interface TraceState {
  entries: ToolTrace[];
  // tool_use ids aligned index-for-index with `entries` (undefined for id-less
  // chunks), so capping can prune `byId` as entries roll off.
  ids: (string | undefined)[];
  // tool_use id → its trace entry, so a tool_result can stamp `ok`. Pruned in
  // lockstep with the cap window — a result for a rolled-off call is dropped.
  byId: Map<string, ToolTrace>;
}

// Consume the live stream to completion (folding tool chunks into the trace), then
// take the settled result (the source of truth for text/usage). A stream error is
// swallowed — it resurfaces via result.status.
async function consumeResult(
  turn: RibAgentTurn,
  trace: TraceState,
  onTool?: (tools: readonly ToolTrace[]) => void,
): Promise<RibAgentTurnResult> {
  try {
    for await (const chunk of turn.stream) {
      if (foldToolChunk(chunk, trace)) {
        try {
          // A fresh snapshot per notification: an observer must never see (or be able
          // to mutate) the live fold state, and a retained reference must stay stable.
          onTool?.(trace.entries.map((t) => ({ ...t })));
        } catch {
          // a throwing observer must never break the turn
        }
      }
    }
  } catch {
    // a stream error surfaces via result.status below
  }
  return await turn.result;
}

function foldToolChunk(chunk: MessageChunk, trace: TraceState): boolean {
  if (chunk.type === "tool_use") {
    const target = digestTarget(chunk.toolInput);
    const entry: ToolTrace = { name: chunk.toolName, ...(target ? { target } : {}) };
    trace.entries.push(entry);
    trace.ids.push(chunk.id);
    if (chunk.id) trace.byId.set(chunk.id, entry);
    if (trace.entries.length > TOOL_TRACE_CAP) {
      trace.entries.shift();
      const dropped = trace.ids.shift();
      if (dropped) trace.byId.delete(dropped);
    }
    return true;
  }
  if (chunk.type === "tool_result") {
    const entry = trace.byId.get(chunk.toolUseId);
    if (!entry) return false;
    entry.ok = chunk.isError !== true;
    return true;
  }
  return false;
}

// The argument keys that most identify a tool call, in preference order — a file
// being edited, a command being run, a query being searched.
const TARGET_KEYS = ["file_path", "path", "command", "cmd", "query", "pattern", "url", "name"];

export function digestTarget(input?: Record<string, unknown>): string | undefined {
  if (!input) return undefined;
  for (const key of TARGET_KEYS) {
    const v = input[key];
    if (typeof v === "string" && v.trim().length > 0) {
      const t = v.trim();
      return t.length > TARGET_CAP ? `${t.slice(0, TARGET_CAP - 1)}…` : t;
    }
  }
  return undefined;
}
