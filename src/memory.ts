import { createHash } from "node:crypto";
import {
  MEMORY_TEXT_LIMIT,
  type MemoryTools,
  RECALL_REQUEST_SCHEMA_VERSION,
  type RibContext,
  WRITEBACK_REQUEST_SCHEMA_VERSION,
} from "@keelson/shared";
import { parseTrailingDirective } from "./control-json.ts";
import { runConfinedTurn } from "./turn-runner.ts";

// The coordinator's governed-memory loop (#15 capstone) over the RibContext.getMemory
// seam: recall prior decisions/lessons INTO a run so the team is grounded in what it
// learned before, and reflect the run's outcome BACK as a governed `decision` row so the
// knowledge compounds across runs. Both are project-scoped and fail-soft — a missing
// seam (older harness), no bound project, or a store hiccup degrades to no-memory rather
// than crashing a run. The server-side guardrails still hold: a writeback here is
// evidence-default and review-gated — it CANNOT mint an instruction-grade row.

const RUNTIME = "rib:squad";
const RECALL_MAX_ITEMS = 8;
const SUMMARY_CAP = 200;
const FACTS_IN_DECISION = 5;
// Per-item grounding excerpt. The substance lives in `content` (the run's outcome +
// facts), not the headline `summary` — surfacing the content is what makes a recalled
// decision actually inform the next pass rather than just announce that one exists.
// Generous because a run's key takeaway can sit past a paragraph of context; recall is
// already capped at RECALL_MAX_ITEMS, so the grounding block stays bounded.
const RECALL_EXCERPT = 1000;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function clamp(text: string, max: number = MEMORY_TEXT_LIMIT): string {
  return text.length > max ? text.slice(0, max) : text;
}

// Recall prior governed decisions/lessons relevant to the task as grounding lines the
// coordinator folds into its prompt. Project-scoped; returns [] when there is no memory
// seam or no project (memory in keelson is scoped to a project), and on any failure.
export async function recallGrounding(
  memory: MemoryTools | undefined,
  projectId: string | undefined,
  task: string,
): Promise<string[]> {
  if (!memory || !projectId) return [];
  try {
    const res = await memory.recall({
      schemaVersion: RECALL_REQUEST_SCHEMA_VERSION,
      scope: { visibility: "project", projectId },
      task: { runtime: RUNTIME },
      query: task,
      limits: { maxItems: RECALL_MAX_ITEMS },
    });
    return res.items.map((it) => {
      const detail = it.content.trim().replace(/\s+/g, " ").slice(0, RECALL_EXCERPT);
      return `[recalled ${it.type}] ${detail}`;
    });
  } catch {
    return []; // fail-soft: a memory hiccup must not crash the run
  }
}

// Write one `decision` row to the governed ledger (evidence-default; the server forces
// review_status pending). Shared by the raw and distilled writeback paths so both derive
// the dedupe key the same way. Fail-soft; returns whether a row was submitted.
async function writeDecisionRow(
  memory: MemoryTools,
  projectId: string,
  headline: string,
  body: string,
): Promise<boolean> {
  const content = clamp(body);
  const contentHash = sha256(content);
  try {
    const res = await memory.writeback({
      schemaVersion: WRITEBACK_REQUEST_SCHEMA_VERSION,
      // Content-derived so an identical task+outcome re-run dedupes at the ledger.
      idempotencyKey: `squad-coord:${projectId}:${contentHash}`,
      scope: { visibility: "project", projectId },
      task: { runtime: RUNTIME },
      memories: [
        {
          type: "decision",
          summary: clamp(headline, SUMMARY_CAP),
          content,
          contentHash,
          provenance: "generated",
          sourceRefs: [],
          artifacts: [],
        },
      ],
    });
    return res.written.length > 0;
  } catch {
    return false; // fail-soft
  }
}

// Write the run's RAW outcome back as one governed `decision` row — the pre-distillation
// shape, kept as the fail-soft fallback when distillation is unavailable so a completed run
// still compounds memory. No-ops without a seam, a project, or a summary.
export async function reflectOutcome(
  memory: MemoryTools | undefined,
  projectId: string | undefined,
  task: string,
  summary: string,
  facts: readonly string[],
): Promise<boolean> {
  if (!memory || !projectId || !summary.trim()) return false;
  const content = [summary.trim(), ...facts.slice(-FACTS_IN_DECISION)].join("\n");
  return writeDecisionRow(memory, projectId, `Squad outcome — ${task.trim()}`, content);
}

// Write a DISTILLED lesson back as one governed `decision` row — the preferred shape: a
// concise, decontextualized takeaway in place of the raw summary + facts dump, so the next
// run recalls substance, not narration. No-ops without a seam, a project, or content.
export async function reflectDistilled(
  memory: MemoryTools | undefined,
  projectId: string | undefined,
  distilled: { headline: string; content: string },
): Promise<boolean> {
  if (!memory || !projectId || !distilled.headline.trim() || !distilled.content.trim()) {
    return false;
  }
  return writeDecisionRow(memory, projectId, distilled.headline, distilled.content);
}

// --- distillation turn ---------------------------------------------------------

// What a distillation turn decided about a completed run: a durable lesson worth recording,
// an explicit abstain (the run produced nothing generalizable — the pollution gate), or
// unavailable (the turn failed/timed-out or returned no parseable verdict — the caller falls
// back to the raw writeback so the validated "a done run compounds memory" guarantee holds).
export type DistillResult =
  | { kind: "lesson"; headline: string; content: string }
  | { kind: "abstain" }
  | { kind: "unavailable" };

const DISTILL_TIMEOUT_MS = 120_000;
const DISTILL_ACTIONS: ReadonlySet<string> = new Set(["record", "skip"]);

const DISTILL_SYSTEM =
  "You are the keelson squad's scribe. A multi-agent run just finished. Your one job is to distill the SINGLE most useful durable decision or lesson the team should carry into future work on this project — or to judge that this run produced nothing worth recording. You curate shared team memory; you do not summarize the run.";

function distillPrompt(input: {
  task: string;
  summary: string;
  facts: readonly string[];
  recalled: readonly string[];
}): string {
  const factsBlock = input.facts.length
    ? input.facts.map((f) => `- ${f}`).join("\n")
    : "(none recorded)";
  // Show what the team already knows so the turn records a delta, not a restatement — the
  // same "don't re-derive what's in memory" discipline the per-member reflection follows.
  const recalledBlock = input.recalled.length
    ? `\nAlready in the team's memory (do NOT restate these — record only something new or a genuine refinement):\n${input.recalled.map((r) => `- ${r}`).join("\n")}\n`
    : "";
  return `The squad just completed this task:
---
${input.task}
---

Final outcome:
---
${input.summary.trim() || "(no summary)"}
---

Findings gathered during the run:
${factsBlock}
${recalledBlock}
Decide what — if anything — a future run on THIS project should know. Record at most ONE durable item: a decision the team made (and why), or a lesson about the project, the domain, or how the work goes. It must be decontextualized — written so a future run with no memory of THIS run understands it alone, naming concrete files/people/choices and absolute dates. Do NOT record run-specific narration, the restated task, or anything already in memory above. If the run thrashed, stayed shallow, or produced nothing generalizable, record nothing — that is the common, correct outcome.

End your reply with EXACTLY ONE JSON object on its own line and nothing after it:
- to record one durable item: {"action":"record","headline":"<short title>","lesson":"<the decontextualized decision or lesson>"}
- to record nothing: {"action":"skip"}`;
}

// Run ONE confined turn to distill a completed run into a durable lesson (or an abstain).
// Text-only (no tools); fail-soft — any turn failure or unparseable reply resolves to
// `unavailable` rather than throwing, so the caller can fall back to the raw writeback.
export async function distillOutcome(
  runAgentTurn: NonNullable<RibContext["runAgentTurn"]>,
  input: {
    task: string;
    summary: string;
    facts: readonly string[];
    recalled: readonly string[];
    abortSignal?: AbortSignal;
    timeoutMs?: number;
  },
): Promise<DistillResult> {
  if (input.abortSignal?.aborted) return { kind: "unavailable" };
  const turn = await runConfinedTurn(
    runAgentTurn,
    { system: DISTILL_SYSTEM, prompt: distillPrompt(input), allowedTools: [] },
    input.timeoutMs ?? DISTILL_TIMEOUT_MS,
    input.abortSignal,
  );
  if (turn.status !== "ok") return { kind: "unavailable" };
  const directive = parseTrailingDirective(turn.text, DISTILL_ACTIONS);
  if (!directive) return { kind: "unavailable" };
  if (directive.parsed.action === "skip") return { kind: "abstain" };
  const headline =
    typeof directive.parsed.headline === "string" ? directive.parsed.headline.trim() : "";
  const lesson = typeof directive.parsed.lesson === "string" ? directive.parsed.lesson.trim() : "";
  // A malformed `record` (missing/empty fields) is treated as unavailable, not abstain — only
  // an explicit `skip` suppresses the writeback; uncertainty preserves the raw fallback.
  if (!headline || !lesson) return { kind: "unavailable" };
  return { kind: "lesson", headline: clamp(headline, SUMMARY_CAP), content: clamp(lesson) };
}
