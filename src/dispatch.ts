import type {
  RibAgentTurn,
  RibAgentTurnRequest,
  RibAgentTurnResult,
  RibContext,
} from "@keelson/shared";
import { errText } from "@keelson/shared";
import { composeMemberSystemPrompt } from "./compose.ts";
import { MEMORY_DOC_CAP, readMemberDoc, writeMemory } from "./member-store.ts";
import type { Member } from "./types.ts";

// The fan-out coordinator: one turn per member in parallel, then one synthesis
// turn over their replies. Built on an INJECTED runAgentTurn (the host seam), not
// an imported host, so the mechanism is unit-testable against a fake. Turns are
// text-only by default; a project-bound wave grants each member READ_TOOLS confined
// to the repo root so a reviewer can actually inspect what it is asked to judge.

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_PER_TURN_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_MEMBERS = 6;

// The read rail for a project-bound dispatch: enough to inspect the repo (the read subset
// of code.ts's CODE_TOOLS), and nothing that mutates it. allowedTools present means "these
// and no others" at the host, so a dispatched member can ground its answer in real files but
// cannot edit, run commands, or push — those stay the code arm's job, behind the RAI floor.
export const READ_TOOLS = ["Read", "Glob", "Grep"] as const;

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
  // When set, each member's turn gets READ_TOOLS confined to the project root (cwd +
  // allowedDirectories) so it can inspect the repo to answer — a reviewer that can't read
  // the diff is useless. Absent keeps the turn text-only (pure reasoning, no filesystem).
  project?: { name: string; rootPath: string };
  concurrency?: number;
  perTurnTimeoutMs?: number;
  maxMembers?: number;
  synthesize?: boolean;
  // The member that authors the synthesis turn; absent runs a generic synthesis
  // with no charter.
  synthesizer?: Member;
  // Opt-in post-wave reflection: after the wave, each member that returned a
  // substantive answer runs ONE more (paid) turn to curate its own memory.md from
  // what it just learned. OFF by default — it DOUBLES the per-member turn cost, so
  // normal dispatch is unchanged unless a caller asks for it.
  reflect?: boolean;
  abortSignal?: AbortSignal;
}

// Total cost is (capped members) + 1 turn when synthesis runs — one billed
// provider call per dispatched member, plus the synthesizer.
export async function dispatchFanout(opts: DispatchFanoutOptions): Promise<DispatchOutcome> {
  const notes: string[] = [];
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
  const perTurnTimeoutMs = opts.perTurnTimeoutMs ?? DEFAULT_PER_TURN_TIMEOUT_MS;
  const maxMembers = Math.max(1, opts.maxMembers ?? DEFAULT_MAX_MEMBERS);

  let members = opts.members;
  if (members.length > maxMembers) {
    notes.push(`truncated to ${maxMembers} of ${members.length} members (cost cap)`);
    members = members.slice(0, maxMembers);
  }

  // Default synthesis on for a multi-member wave, off for a single member (its one
  // reply IS the answer — a synthesis turn there is a redundant paid call). An explicit
  // `synthesize` still wins. Computed AFTER truncation so a cost-capped 1-member wave
  // skips it too.
  const wantSynthesis = opts.synthesize ?? members.length > 1;

  const root = opts.project?.rootPath.trim();
  const perMember = await runPool(members, concurrency, async (member): Promise<DispatchResult> => {
    if (opts.abortSignal?.aborted) {
      return { slug: member.slug, name: member.name, status: "aborted", text: "" };
    }
    const system = await composeMemberSystemPrompt(opts.membersRoot, member);
    const outcome = await executeTurn(
      opts.runAgentTurn,
      {
        system,
        prompt: buildDispatchPrompt(opts.task, opts.project),
        ...(root ? { cwd: root, allowedDirectories: [root], allowedTools: [...READ_TOOLS] } : {}),
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

  // Post-wave reflection (opt-in). Runs after synthesis so a reflection turn never
  // delays the answer's assembly; each member curates its own memory from its own
  // reply. Gated, fail-closed — a member with no substance, or a reflection that
  // errors/empties/over-caps, leaves the prior memory standing.
  if (opts.reflect) {
    await reflectMembers(opts, members, perMember, concurrency, perTurnTimeoutMs, notes);
  }

  return {
    task: opts.task,
    perMember,
    ...(synthesis !== undefined ? { synthesis } : {}),
    notes,
  };
}

// One reflection turn per member that produced substance, bounded by the same pool
// width as the wave. Each member is distinct, so the turns run in parallel — no
// per-member serialization is needed (unlike chamber, where concurrent room closes
// can target one Mind). The reflection's full reply IS the new memory document;
// writeMemory caps it. Every skip/failure is surfaced as a note, never silent.
async function reflectMembers(
  opts: DispatchFanoutOptions,
  members: readonly Member[],
  perMember: readonly DispatchResult[],
  concurrency: number,
  perTurnTimeoutMs: number,
  notes: string[],
): Promise<void> {
  if (opts.abortSignal?.aborted) {
    notes.push("reflection skipped — dispatch aborted");
    return;
  }
  // Members and perMember are index-aligned (perMember is built from `members`
  // in order, after truncation), so zip them to pair each reply with its author.
  const reflectors = members
    .map((member, i) => ({ member, result: perMember[i] }))
    .filter(
      (r): r is { member: Member; result: DispatchResult } =>
        r.result?.status === "ok" && r.result.text.trim().length > 0,
    );
  if (reflectors.length === 0) {
    notes.push("reflection skipped — no member produced substance");
    return;
  }

  await runPool(reflectors, concurrency, async ({ member, result }) => {
    if (opts.abortSignal?.aborted) return;
    const prior = (await readMemberDoc(opts.membersRoot, member.slug, "memory.md")) ?? "";
    const system = await composeMemberSystemPrompt(opts.membersRoot, member);
    const outcome = await executeTurn(
      opts.runAgentTurn,
      {
        system,
        prompt: buildReflectionPrompt(member, opts.task, result.text, prior),
        allowedTools: [],
        ...(member.model ? { model: member.model } : {}),
        ...(member.model && member.provider ? { provider: member.provider } : {}),
      },
      perTurnTimeoutMs,
      opts.abortSignal,
    );
    if (outcome.status !== "ok") {
      notes.push(
        `reflection for ${member.slug} ${outcome.status}${outcome.error ? `: ${outcome.error}` : ""} — prior memory kept`,
      );
      return;
    }
    const next = outcome.text.trim();
    if (next.length === 0) {
      notes.push(`reflection for ${member.slug} returned empty — prior memory kept`);
      return;
    }
    // A shutdown landing during the (paid) turn drops the late write (mirrors the
    // chamber reflection gate) so a disposing run can't resurrect memory.
    if (opts.abortSignal?.aborted) return;
    try {
      await writeMemory(opts.membersRoot, member.slug, next);
      notes.push(`reflection updated ${member.slug} memory`);
    } catch (e) {
      // Over-cap / unsafe / missing — fail closed: the prior memory stands.
      notes.push(`reflection for ${member.slug} not persisted (${errText(e)}) — prior memory kept`);
    }
  });
}

// One participating member paired with everything it contributed across a completed run —
// the substance a loop-close reflection curates its memory from.
export interface MemberContribution {
  member: Member;
  contribution: string;
}

export interface ReflectAtCloseOptions {
  runAgentTurn: NonNullable<RibContext["runAgentTurn"]>;
  membersRoot: string;
  task: string;
  contributions: readonly MemberContribution[];
  concurrency?: number;
  perTurnTimeoutMs?: number;
  abortSignal?: AbortSignal;
}

// Loop-close reflection: each member that did substantive work in a COMPLETED run curates
// its own memory.md ONCE, over its whole contribution — the issue #2 boundary-gated cadence,
// distinct from dispatch's per-wave `reflect` (which would multiply paid turns every round).
// Members are distinct so the (paid) turns run in a bounded pool; fail-closed per member (an
// aborted/errored/empty/over-cap reflection leaves the prior memory). Returns the slugs whose
// memory was updated.
export async function reflectMembersAtClose(opts: ReflectAtCloseOptions): Promise<string[]> {
  if (opts.abortSignal?.aborted) return [];
  const reflectors = opts.contributions.filter((c) => c.contribution.trim().length > 0);
  if (reflectors.length === 0) return [];
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
  const perTurnTimeoutMs = opts.perTurnTimeoutMs ?? DEFAULT_PER_TURN_TIMEOUT_MS;
  const updated: string[] = [];
  await runPool(reflectors, concurrency, async ({ member, contribution }) => {
    if (opts.abortSignal?.aborted) return;
    const prior = (await readMemberDoc(opts.membersRoot, member.slug, "memory.md")) ?? "";
    const system = await composeMemberSystemPrompt(opts.membersRoot, member);
    const outcome = await executeTurn(
      opts.runAgentTurn,
      {
        system,
        prompt: buildReflectionPrompt(member, opts.task, contribution, prior),
        allowedTools: [],
        ...(member.model ? { model: member.model } : {}),
        ...(member.model && member.provider ? { provider: member.provider } : {}),
      },
      perTurnTimeoutMs,
      opts.abortSignal,
    );
    if (outcome.status !== "ok") return;
    const next = outcome.text.trim();
    if (next.length === 0) return;
    // A shutdown landing during the (paid) turn drops the late write, so a disposing run
    // can't resurrect memory (mirrors the per-wave reflect gate).
    if (opts.abortSignal?.aborted) return;
    try {
      await writeMemory(opts.membersRoot, member.slug, next);
      updated.push(member.slug);
    } catch {
      // Over-cap / unsafe / missing — fail closed: the prior memory stands.
    }
  });
  return updated;
}

// The reflection doctrine, mirrored from chamber: curate (don't summarize), a high
// bar for what persists, decontextualize, and CONSOLIDATE the whole document so
// pruning is in-band rather than a blind append. The reply is the COMPLETE new
// memory (plain Markdown — no tool, no JSON), written to the member it reflects for.
function buildReflectionPrompt(
  member: Member,
  task: string,
  reply: string,
  priorMemory: string,
): string {
  const role = member.role?.trim() ? member.role.trim() : "member";
  return `You are ${member.name}. You just answered a task dispatched to your squad. Curate your long-term memory before moving on.

You are NOT summarizing the task. Decide what — if anything — your future self should carry into a DIFFERENT task. Most of this belongs to this task alone and should be forgotten. Persist only what would make you a sharper ${role} weeks from now: a durable fact about the project, the operator, or the domain; or a lesson about how you work. When unsure, keep nothing. Do NOT restate your charter — identity is not memory.

The task you answered:
---
${task}
---

Your answer:
---
${reply}
---

Your CURRENT memory:
---
${priorMemory.trim() || "(empty)"}
---

Return the COMPLETE updated memory document (Markdown), not an addition. For each existing item: keep it, sharpen it, fold this task's learning into it, or DELETE it if it is now wrong or stale. Then add only genuinely new durable facts. Merge near-duplicates. Keep the whole document under ${MEMORY_DOC_CAP} characters. Write every item so a future you with no memory of this task understands it alone (name who/what/when with absolute dates).

Reply with ONLY the memory document text and nothing else. To change nothing, return your current memory verbatim. Writing nothing new is the common, correct outcome.`;
}

// Frame a project-bound member turn so it knows it can (and should) read the repo to ground
// its answer rather than guess at file contents — the read tools are useless if the member
// doesn't reach for them. Text-only turns pass the task through unchanged.
function buildDispatchPrompt(task: string, project?: { name: string; rootPath: string }): string {
  if (!project?.rootPath.trim()) return task;
  return `You are working in the project "${project.name}", at its repository root. You have Read, Glob, and Grep to inspect the repo — open the files you need to ground your answer instead of guessing at their contents. This is a read-only analysis/review turn: you cannot edit, run commands, or push.

${task}`;
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
