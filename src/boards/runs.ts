import type { CanvasBoardView, CanvasTone } from "@keelson/shared";
import type { RunSummary } from "../runs-store.ts";
import { stripMd } from "./coordinator.ts";

// Pure: the archived coordinator runs for a scope -> a canvas `board` (the Runs
// history panel). No runs renders a calm idle board; otherwise one card per run
// (newest first, capped) tagged with its terminal status and carrying a View verb
// that opens the run's full drill-down board. Validated against canvasViewSchema in
// tests; the collector never parses (validation lives at the binding edge via
// expectView).

// Open one archived run as a drill-down canvas. Shared with onAction so the action
// type can't drift from its handler; the payload carries the run's id.
export const VIEW_RUN_ACTION = "view-run";

const TASK_CAP = 160;
// The archive can grow unbounded; the panel shows only the most recent runs (the
// list arrives newest-first from listRuns). The full history stays on disk.
const MAX_RUNS = 20;

// Terminal-status tone, mirroring the Run-loop board's statusPill so a run reads the
// same in the history as it did live.
function statusTone(status: string): CanvasTone {
  switch (status) {
    case "done":
      return "ok";
    case "active":
      return "info";
    case "gave-up":
      return "warn";
    case "max-rounds":
      return "caution";
    case "verification-failed":
    case "change-quality-failed":
      return "error";
    default:
      return "neutral";
  }
}

export function buildRunsBoard(runs: readonly RunSummary[]): CanvasBoardView {
  if (runs.length === 0) return idleBoard();
  const shown = runs.slice(0, MAX_RUNS);
  return {
    view: "board",
    title: "Runs",
    header: {
      status: {
        label: `${runs.length} ${runs.length === 1 ? "run" : "runs"}`,
        tone: "brand" as CanvasTone,
      },
      chip: "history",
    },
    sections: [
      {
        kind: "cards",
        items: shown.map((r) => ({
          title: stripMd(truncate(r.task, TASK_CAP)) || "(no task)",
          dot: statusTone(r.status),
          pill: { label: r.status, tone: statusTone(r.status) },
          fields: [
            { label: "rounds", value: `r${r.round}` },
            { label: "when", value: shortTime(r.updatedAt) },
          ],
          actions: [
            {
              type: VIEW_RUN_ACTION,
              label: "View",
              glyph: "→",
              inline: true,
              payload: { id: r.id },
            },
          ],
        })),
      },
    ],
  };
}

function idleBoard(): CanvasBoardView {
  return {
    view: "board",
    title: "Runs",
    header: { status: { label: "no runs", tone: "neutral" as CanvasTone }, chip: "history" },
    sections: [
      {
        kind: "rows",
        items: [
          {
            glyph: "neutral" as CanvasTone,
            text: "No coordinator runs yet — give the squad a task in the Run loop, and each run is archived here.",
          },
        ],
      },
    ],
  };
}

// A compact "YYYY-MM-DD HH:MM" from an ISO timestamp for the run's trailing label;
// falls back to the raw value if it isn't the expected shape.
function shortTime(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]}` : iso;
}

function truncate(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
