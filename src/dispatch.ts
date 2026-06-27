import type {
  RibAgentTurn,
  RibAgentTurnRequest,
  RibAgentTurnResult,
  RibContext,
} from "@keelson/shared";
import { errText } from "@keelson/shared";
import { composeMemberSystemPrompt } from "./compose.ts";
import type { Member } from "./types.ts";

// The fan-out coordinator: one turn per member in parallel, then one synthesis
// turn over their replies. Built on an INJECTED runAgentTurn (the host seam), not
// an imported host, so the mechanism is unit-testable against a fake. Turns are
// text-only (no tools, no cwd) — the spike proves the shape, not unconfined work.

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_PER_TURN_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_MEMBERS = 6;

export type DispatchStatus = "ok" | "error" | "timeout" | "aborted";

export interface DispatchResult {
  slug: string;
  name: string;
  status: DispatchStatus;
  text: string;
  error?: string;
}

export interface DispatchOutcome {
  task: string;
  perMember: DispatchResult[];
  synthesis?: string;
  // Truncation, synthesis-skip, and synthesis-failure are surfaced here, never
  // silently dropped.
  notes: string[];
}

export interface DispatchFanoutOptions {
  runAgentTurn: NonNullable<RibContext["runAgentTurn"]>;
  membersRoot: string;
  members: Member[];
  task: string;
  concurrency?: number;
  perTurnTimeoutMs?: number;
  maxMembers?: number;
  synthesize?: boolean;
  // The member that authors the synthesis turn; absent runs a generic synthesis
  // with no charter.
  synthesizer?: Member;
  abortSignal?: AbortSignal;
}

// Total cost is (capped members) + 1 turn when synthesis runs — one billed
// provider call per dispatched member, plus the synthesizer.
export async function dispatchFanout(opts: DispatchFanoutOptions): Promise<DispatchOutcome> {
  const notes: string[] = [];
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
  const perTurnTimeoutMs = opts.perTurnTimeoutMs ?? DEFAULT_PER_TURN_TIMEOUT_MS;
  const maxMembers = Math.max(1, opts.maxMembers ?? DEFAULT_MAX_MEMBERS);
  const wantSynthesis = opts.synthesize ?? true;

  let members = opts.members;
  if (members.length > maxMembers) {
    notes.push(`truncated to ${maxMembers} of ${members.length} members (cost cap)`);
    members = members.slice(0, maxMembers);
  }

  const perMember = await runPool(members, concurrency, async (member): Promise<DispatchResult> => {
    if (opts.abortSignal?.aborted) {
      return { slug: member.slug, name: member.name, status: "aborted", text: "" };
    }
    const system = await composeMemberSystemPrompt(opts.membersRoot, member);
    const outcome = await executeTurn(
      opts.runAgentTurn,
      {
        system,
        prompt: opts.task,
        ...(member.model ? { model: member.model } : {}),
        ...(member.model && member.provider ? { provider: member.provider } : {}),
      },
      perTurnTimeoutMs,
      opts.abortSignal,
    );
    return { slug: member.slug, name: member.name, ...outcome };
  });

  const oks = perMember.filter((r) => r.status === "ok");
  let synthesis: string | undefined;
  if (!wantSynthesis) {
    notes.push("synthesis skipped (disabled)");
  } else if (oks.length === 0) {
    notes.push("synthesis skipped — no member returned a usable result");
  } else if (opts.abortSignal?.aborted) {
    notes.push("synthesis skipped — dispatch aborted");
  } else {
    const synthSystem = opts.synthesizer
      ? await composeMemberSystemPrompt(opts.membersRoot, opts.synthesizer)
      : GENERIC_SYNTH_SYSTEM;
    const outcome = await executeTurn(
      opts.runAgentTurn,
      {
        system: synthSystem,
        prompt: buildSynthesisPrompt(opts.task, oks),
        ...(opts.synthesizer?.model ? { model: opts.synthesizer.model } : {}),
        ...(opts.synthesizer?.model && opts.synthesizer.provider
          ? { provider: opts.synthesizer.provider }
          : {}),
      },
      perTurnTimeoutMs,
      opts.abortSignal,
    );
    if (outcome.status === "ok") synthesis = outcome.text;
    else {
      notes.push(
        `synthesis turn ${outcome.status}${outcome.error ? `: ${outcome.error}` : ""} — returning per-member results only`,
      );
    }
  }

  return {
    task: opts.task,
    perMember,
    ...(synthesis !== undefined ? { synthesis } : {}),
    notes,
  };
}

const GENERIC_SYNTH_SYSTEM =
  "You are a synthesis agent. You receive a task and several independent specialists' answers to it, and merge them into one coherent, non-redundant answer — reconciling agreement, surfacing disagreement, and attributing where it matters.";

function buildSynthesisPrompt(task: string, results: readonly DispatchResult[]): string {
  const sections = results.map((r) => `### ${r.name} (${r.slug})\n${r.text}`).join("\n\n");
  return `A task was dispatched to several squad members in parallel. Synthesize their independent responses into one coherent answer.\n\n## Task\n${task}\n\n## Member responses\n\n${sections}\n\n## Your job\nProduce a single synthesized answer to the task. Reconcile where they agree, note where they diverge, and do not merely concatenate them.`;
}

interface TurnOutcome {
  status: DispatchStatus;
  text: string;
  error?: string;
}

// Run one turn to its settled result, mirroring the room.ts drain discipline:
// own a per-turn AbortController linked to the wave signal, drain the stream
// (result is the source of truth), and race the result against the timeout —
// aborting the turn on timeout. Never throws; every failure mode maps to a
// TurnOutcome so a wave's Promise.all can't be short-circuited by one bad turn.
async function executeTurn(
  runAgentTurn: NonNullable<RibContext["runAgentTurn"]>,
  req: Omit<RibAgentTurnRequest, "abortSignal" | "timeoutMs">,
  perTurnTimeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<TurnOutcome> {
  if (parentSignal?.aborted) return { status: "aborted", text: "" };

  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  parentSignal?.addEventListener("abort", onParentAbort, { once: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const turn = runAgentTurn({
      ...req,
      abortSignal: controller.signal,
      timeoutMs: perTurnTimeoutMs,
    });
    // Wrap so neither branch rejects: a timed-out turn's still-pending drain must
    // not surface as an unhandled rejection once the race has settled.
    const settled = drainResult(turn).then(
      (result) => ({ kind: "result" as const, result }),
      (err) => ({ kind: "error" as const, err }),
    );
    const timed = new Promise<{ kind: "timeout" }>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ kind: "timeout" });
      }, perTurnTimeoutMs);
    });

    const outcome = await Promise.race([settled, timed]);
    if (outcome.kind === "timeout") {
      return { status: "timeout", text: "", error: `turn exceeded ${perTurnTimeoutMs}ms` };
    }
    if (outcome.kind === "error") {
      return { status: "error", text: "", error: errText(outcome.err) };
    }
    return mapResult(outcome.result, controller.signal.aborted);
  } catch (e) {
    return { status: "error", text: "", error: errText(e) };
  } finally {
    if (timer) clearTimeout(timer);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}

function mapResult(result: RibAgentTurnResult, aborted: boolean): TurnOutcome {
  if (aborted || result.status === "aborted") return { status: "aborted", text: result.text ?? "" };
  if (result.status === "ok") return { status: "ok", text: result.text };
  return {
    status: result.status,
    text: "",
    error: result.error ?? result.text ?? `turn ${result.status}`,
  };
}

// Drain the live stream to completion, then take the settled result (the source
// of truth). A stream error is swallowed — it resurfaces via result.status.
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

// A bounded async pool: at most `concurrency` workers in flight, each pulling the
// next index off a shared cursor. The worker is total (returns, never throws), so
// Promise.all gives Promise.allSettled isolation — one member's failure can't
// abort the wave. Results stay in member order.
async function runPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runner = async (): Promise<void> => {
    while (true) {
      const i = cursor++;
      const item = items[i];
      if (i >= items.length || item === undefined) break;
      results[i] = await worker(item);
    }
  };
  const lanes = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: lanes }, runner));
  return results;
}
