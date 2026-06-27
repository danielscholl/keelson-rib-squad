import type { CanvasBoardView, CanvasTone } from "@keelson/shared";

// A recalled governed decision/lesson, trimmed to what a card renders. Mirrors the
// fields of @keelson/shared's recallItemSchema (the squad-decisions recall block
// returns these) but stays a plain shape here — the rib peer-deps only the canvas
// types, not the memory schema, so this is the local projection.
export interface DecisionItem {
  summary: string;
  type?: string;
  content?: string;
  provenance?: string;
  // The recall wire carries no lifecycle, but a future deterministic producer
  // might; render it when present so a stale/superseded row reads as such.
  lifecycle?: string;
  // RFC3339 — only the calendar date is shown (recency without a now-dependent
  // relative string, so the board is deterministic).
  createdAt?: string;
}

// The verb the decisions board offers to capture a new decision: it runs the
// squad-decide workflow (the governed `memory: { writeback }` path). Shared with
// onAction so the action type can't drift from its handler.
export const RECORD_DECISION_ACTION = "record-decision";

// Pure: a list of recalled decisions -> a canvas `board`. Zero decisions renders a
// cold-start row (record the first); >=1 renders one card per decision. Both shapes
// always carry the "Record a decision" action so the operator can always add one.
// Validated against canvasViewSchema in tests; the producer never parses (validation
// lives at the binding edge via expectView).
export function buildDecisionsBoard(decisions: readonly DecisionItem[]): CanvasBoardView {
  const sections: CanvasBoardView["sections"] =
    decisions.length === 0
      ? coldStartSections()
      : [{ kind: "cards", items: decisions.map(cardFor) }];
  sections.push(recordSection());
  return {
    view: "board",
    title: "Decisions",
    header: {
      status: {
        label: `${decisions.length} ${decisions.length === 1 ? "decision" : "decisions"}`,
        tone: "brand" as CanvasTone,
      },
      chip: "ledger",
    },
    sections,
  };
}

// Active reads calm-positive, a withdrawn/superseded row warns, anything else is
// neutral — so a stale decision doesn't read as load-bearing.
function lifecycleTone(lifecycle: string | undefined): CanvasTone {
  if (lifecycle === "active") return "ok";
  if (lifecycle === "superseded" || lifecycle === "stale" || lifecycle === "disputed")
    return "warn";
  return "neutral";
}

// One decision -> one card: summary as the title, type in the pill, provenance +
// lifecycle + recorded-date as fields, and a content excerpt on the reason line.
function cardFor(decision: DecisionItem) {
  const fields: { label: string; value: string }[] = [];
  if (decision.provenance) fields.push({ label: "provenance", value: decision.provenance });
  if (decision.lifecycle) fields.push({ label: "lifecycle", value: decision.lifecycle });
  const recorded = recordedDate(decision.createdAt);
  if (recorded) fields.push({ label: "recorded", value: recorded });

  const card: {
    title: string;
    dot: CanvasTone;
    pill: { label: string };
    fields?: { label: string; value: string }[];
    reason?: { label: string; text: string };
  } = {
    title: truncate(decision.summary, 120) || "(no summary)",
    dot: lifecycleTone(decision.lifecycle),
    pill: { label: (decision.type ?? "decision").trim() || "decision" },
    ...(fields.length > 0 ? { fields } : {}),
  };
  const excerpt = decision.content?.trim();
  if (excerpt) card.reason = { label: "context", text: truncate(excerpt, 200) };
  return card;
}

// The always-present capture verb: a form action collecting the one-line decision
// and its details, dispatched to onAction (which launches squad-decide).
function recordSection(): CanvasBoardView["sections"][number] {
  return {
    kind: "actions",
    title: "Record a decision",
    items: [
      {
        type: RECORD_DECISION_ACTION,
        label: "Record a decision",
        glyph: "✓",
        fields: [
          {
            name: "summary",
            label: "Decision",
            placeholder: "One line — what was decided",
            required: true,
          },
          {
            name: "content",
            label: "Details",
            placeholder: "Why, context, and any consequences",
            multiline: true,
            required: true,
          },
        ],
      },
    ],
  };
}

function coldStartSections(): CanvasBoardView["sections"] {
  return [
    {
      kind: "rows",
      items: [
        {
          glyph: "neutral",
          text: "No decisions recorded yet. Decisions are the squad's governed shared memory — record one to start the ledger.",
        },
      ],
    },
  ];
}

// The calendar date (YYYY-MM-DD) of an RFC3339 timestamp; "" when absent or
// unparseable, so a card just omits the field rather than rendering a bad value.
function recordedDate(createdAt: string | undefined): string {
  if (!createdAt) return "";
  const at = new Date(createdAt);
  return Number.isNaN(at.getTime()) ? "" : at.toISOString().slice(0, 10);
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}
