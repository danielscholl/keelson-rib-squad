import { createHash } from "node:crypto";
import {
  MEMORY_TEXT_LIMIT,
  type MemoryTools,
  RECALL_REQUEST_SCHEMA_VERSION,
  WRITEBACK_REQUEST_SCHEMA_VERSION,
} from "@keelson/shared";

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

// Write the run's outcome back to the governed ledger as one `decision` row
// (evidence-default; the server forces review_status pending). No-ops without a seam,
// a project, or a summary; fail-soft. Returns whether a row was submitted, so the
// coordinator can note it in the transcript.
export async function reflectOutcome(
  memory: MemoryTools | undefined,
  projectId: string | undefined,
  task: string,
  summary: string,
  facts: readonly string[],
): Promise<boolean> {
  if (!memory || !projectId || !summary.trim()) return false;
  const content = clamp([summary.trim(), ...facts.slice(-FACTS_IN_DECISION)].join("\n"));
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
          summary: clamp(`Squad outcome — ${task.trim()}`, SUMMARY_CAP),
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
