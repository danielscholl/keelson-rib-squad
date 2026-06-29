import type { RibAgentTurn, RibAgentTurnResult, RibContext } from "@keelson/shared";
import { errText } from "@keelson/shared";

// One confined agent turn run to its settled result, the discipline cast.ts and
// dispatch.ts each established: own a per-turn AbortController linked to the parent
// signal, drain the stream (the result is the source of truth), and race the result
// against a timeout — aborting the turn on timeout so a hung provider can't wedge the
// caller. Never throws; every failure mode maps to a TurnOutcome the caller surfaces.

export interface TurnOutcome {
  status: "ok" | "error" | "timeout" | "aborted";
  text: string;
  error?: string;
  // The provider id the host resolved the turn to (RibAgentTurnResult.providerId) — carried
  // so the caller can attribute work to the vendor that produced it (the mixed-provider story).
  providerId?: string;
}

type RunAgentTurn = NonNullable<RibContext["runAgentTurn"]>;
// The request a confined turn supplies; the runner owns abortSignal + timeoutMs.
export type ConfinedTurnRequest = Omit<Parameters<RunAgentTurn>[0], "abortSignal" | "timeoutMs">;

export async function runConfinedTurn(
  run: RunAgentTurn,
  req: ConfinedTurnRequest,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<TurnOutcome> {
  if (parentSignal?.aborted) return { status: "aborted", text: "" };

  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  parentSignal?.addEventListener("abort", onParentAbort, { once: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const turn: RibAgentTurn = run({ ...req, abortSignal: controller.signal, timeoutMs });
    // Wrap so neither branch rejects: a timed-out turn's still-pending drain must not
    // surface as an unhandled rejection once the race has settled.
    const settled = drainResult(turn).then(
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
      return { status: "timeout", text: "", error: `agent turn exceeded ${timeoutMs}ms` };
    }
    if (outcome.kind === "error") {
      return { status: "error", text: "", error: errText(outcome.err) };
    }
    const result = outcome.result;
    if (controller.signal.aborted || result.status === "aborted") {
      return { status: "aborted", text: result.text ?? "" };
    }
    if (result.status === "ok") {
      return {
        status: "ok",
        text: result.text,
        ...(result.providerId ? { providerId: result.providerId } : {}),
      };
    }
    return {
      status: result.status,
      text: "",
      error: result.error ?? result.text ?? `turn ${result.status}`,
    };
  } catch (e) {
    return { status: "error", text: "", error: errText(e) };
  } finally {
    if (timer) clearTimeout(timer);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}

// Drain the live stream to completion, then take the settled result (the source of
// truth). A stream error is swallowed — it resurfaces via result.status.
async function drainResult(turn: RibAgentTurn): Promise<RibAgentTurnResult> {
  try {
    for await (const _chunk of turn.stream) {
      // result is the source of truth; the stream is drained, not consumed
    }
  } catch {
    // a stream error surfaces via result.status below
  }
  return await turn.result;
}
