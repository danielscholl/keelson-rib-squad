import type { CanvasBoardView, CanvasTone } from "@keelson/shared";
import { type CoordinatorEntry, type CoordinatorLedger, provenanceLines } from "../coordinator.ts";

// Pure: a coordinator run ledger -> a canvas `board` (the Run-loop panel). No ledger — no run
// yet, or a torn/unreadable file — renders a calm idle board. Validated against canvasViewSchema
// in tests; the collector never parses (validation lives at the binding edge via expectView).

type Section = CanvasBoardView["sections"][number];

const GOAL_CAP = 280; // the goal/outcome line
const STEP_CAP = 200; // a plan step / finding / abandoned step / activity line
const MAX_FINDINGS = 12; // most-recent findings shown
const MAX_ACTIVITY = 10; // most-recent transcript rows shown

// The transcript-kind -> status-dot tone mapping, so each activity row reads its kind at a glance.
const ACTIVITY_TONE: Record<CoordinatorEntry["kind"], CanvasTone> = {
  coordinator: "info",
  dispatch: "neutral",
  code: "accent",
  workflow: "accent",
  replan: "caution",
  failed: "warn",
  verify: "info",
};

export function buildCoordinatorBoard(ledger: CoordinatorLedger | undefined): CanvasBoardView {
  if (!ledger) return idleBoard();

  const sections: Section[] = [pulseSection(ledger)];
  sections.push({
    kind: "rows",
    title: "Goal",
    items: [{ glyph: "info" as CanvasTone, text: truncate(ledger.task, GOAL_CAP) }],
  });
  if (ledger.status === "done" && ledger.summary?.trim()) {
    sections.push({
      kind: "rows",
      title: "Outcome",
      items: [{ glyph: "ok" as CanvasTone, text: truncate(ledger.summary, GOAL_CAP) }],
    });
  }
  if (ledger.verification) {
    const v = ledger.verification;
    sections.push({
      kind: "rows",
      title: "Verification",
      items: [
        {
          glyph: (v.passed ? "ok" : "warn") as CanvasTone,
          text: truncate(
            v.passed
              ? `passed — ${v.command}`
              : `FAILED — ${v.command} (exit ${v.exitCode}): ${v.summary}`,
            STEP_CAP,
          ),
        },
      ],
    });
  }
  if (ledger.plan.length > 0) {
    sections.push({
      kind: "rows",
      title: "Plan",
      items: ledger.plan.map((step, i) => ({
        glyph: "neutral" as CanvasTone,
        text: `${i + 1}. ${truncate(step, STEP_CAP)}`,
      })),
    });
  }
  if (ledger.facts.length > 0) {
    sections.push({
      kind: "rows",
      title: "Findings",
      items: ledger.facts.slice(-MAX_FINDINGS).map((fact) => ({
        glyph: "brand" as CanvasTone,
        text: truncate(fact, STEP_CAP),
      })),
    });
  }
  if (ledger.failedSteps && ledger.failedSteps.length > 0) {
    sections.push({
      kind: "rows",
      title: "Abandoned — do not resume",
      items: ledger.failedSteps.map((step) => ({
        glyph: "warn" as CanvasTone,
        text: truncate(step, STEP_CAP),
      })),
    });
  }
  if (ledger.teamGaps && ledger.teamGaps.length > 0) {
    sections.push({
      kind: "rows",
      title: "Team gaps — consider casting",
      items: ledger.teamGaps.map((gap) => ({
        glyph: "caution" as CanvasTone,
        text: truncate(gap, STEP_CAP),
      })),
    });
  }
  const provenance = provenanceSection(ledger.transcript);
  if (provenance) sections.push(provenance);
  const activity = activitySection(ledger.transcript);
  if (activity) sections.push(activity);

  return {
    view: "board",
    title: "Run loop",
    header: { status: statusPill(ledger.status), chip: `round ${ledger.round}` },
    sections,
  };
}

// The pulse `stats` strip: round, findings, and the two loop counters. A zero count tones
// neutral so an early or calm run doesn't shout; a non-zero stall/re-plan tones caution.
function pulseSection(ledger: CoordinatorLedger): Section {
  const toned = (n: number, tone: CanvasTone): CanvasTone => (n > 0 ? tone : "neutral");
  return {
    kind: "stats",
    items: [
      { label: "Round", value: ledger.round, tone: toned(ledger.round, "info") },
      { label: "Findings", value: ledger.facts.length, tone: toned(ledger.facts.length, "brand") },
      { label: "Stalls", value: ledger.stallCount, tone: toned(ledger.stallCount, "caution") },
      { label: "Re-plans", value: ledger.resetCount, tone: toned(ledger.resetCount, "caution") },
    ],
  };
}

function statusPill(status: CoordinatorLedger["status"]): { label: string; tone: CanvasTone } {
  switch (status) {
    case "active":
      return { label: "active", tone: "info" };
    case "done":
      return { label: "done", tone: "ok" };
    case "gave-up":
      return { label: "gave up", tone: "warn" };
    case "max-rounds":
      return { label: "max rounds", tone: "caution" };
    case "verification-failed":
      return { label: "verification failed", tone: "warn" };
  }
}

// "Worked by": served-provider provenance — which vendor produced each member's work unit.
// Makes a mixed-provider run legible at a glance (the squad's flagship over Copilot-locked squad).
function provenanceSection(transcript: readonly CoordinatorEntry[]): Section | undefined {
  const lines = provenanceLines(transcript);
  if (lines.length === 0) return undefined;
  return {
    kind: "rows",
    title: "Worked by",
    items: lines.map((l) => ({
      glyph: "brand" as CanvasTone,
      text: truncate(`${l.who} (${l.provider}) ${l.verb}`, STEP_CAP),
    })),
  };
}

function activitySection(transcript: readonly CoordinatorEntry[]): Section | undefined {
  const recent = transcript.slice(-MAX_ACTIVITY);
  if (recent.length === 0) return undefined;
  return {
    kind: "rows",
    title: "Recent activity",
    items: recent.map((e) => {
      const line = `${e.speaker ? `${e.speaker}: ` : ""}${e.text}`.trim() || "(no detail)";
      return {
        glyph: ACTIVITY_TONE[e.kind],
        text: truncate(line, STEP_CAP),
        trailing: `r${e.round}`,
      };
    }),
  };
}

function idleBoard(): CanvasBoardView {
  return {
    view: "board",
    title: "Run loop",
    header: { status: { label: "idle", tone: "neutral" as CanvasTone }, chip: "coordinator" },
    sections: [
      {
        kind: "rows",
        items: [
          {
            glyph: "neutral" as CanvasTone,
            text: "No coordinator run yet. Give the squad a goal with squad_coordinate; the loop's plan, findings, abandoned steps, and progress show here.",
          },
        ],
      },
    ],
  };
}

function truncate(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
