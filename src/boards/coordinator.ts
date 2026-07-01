import type { CanvasBoardView, CanvasTone } from "@keelson/shared";
import {
  type CoordinatorEntry,
  type CoordinatorLedger,
  type InFlightTurn,
  provenanceLines,
  type VerificationRecord,
} from "../coordinator.ts";

// Pure: a coordinator run ledger -> a canvas `board` (the Run-loop panel). No ledger — no run
// yet, or a torn/unreadable file — renders a calm idle board. Validated against canvasViewSchema
// in tests; the collector never parses (validation lives at the binding edge via expectView).

type Section = CanvasBoardView["sections"][number];

// The two "assign work" verbs the Run-loop composer offers. Shared with onAction so
// the action types can't drift from their handlers. Coordinate runs the full
// plan→delegate→observe loop (watched in this panel); dispatch fans one question out
// to the whole roster and synthesizes.
export const COORDINATE_ACTION = "coordinate";
export const DISPATCH_ACTION = "dispatch";

const GOAL_CAP = 280;
const STEP_CAP = 200;
const TRANSCRIPT_CAP = 200;
const VERIFY_SUMMARY_CAP = 120;
const MAX_FINDINGS = 12;
const MAX_TRANSCRIPT = 12;

const IDENTITY_TONES: readonly CanvasTone[] = ["accent", "info", "caution", "ok", "brand"];

export function identityTone(speaker: string | undefined): CanvasTone {
  if (!speaker || speaker === "coordinator") return "brand";
  let hash = 0;
  for (let i = 0; i < speaker.length; i++) {
    hash = (hash * 31 + speaker.charCodeAt(i)) | 0;
  }
  return IDENTITY_TONES[Math.abs(hash) % IDENTITY_TONES.length] ?? "brand";
}

export function outcomeTone(e: CoordinatorEntry): CanvasTone {
  switch (e.kind) {
    case "coordinator":
      return "brand";
    case "dispatch":
    case "code":
    case "workflow":
      return "accent";
    case "replan":
      return "caution";
    case "failed":
      return "warn";
    case "verify": {
      const t = e.text.toLowerCase();
      const exemptClean =
        /\bno\s+block\b|\bno\s+blocking\b|\bnothing\s+failed\b|\bno\s+failures?\b/.test(t);
      const failBlock = /\b(block|blocked|fail|failed|failing|failure|red)\b/.test(t);
      if (failBlock && !exemptClean) return "error";
      if (/\b(pass|passed|clean|green|verified)\b/.test(t)) return "ok";
      return "info";
    }
  }
}

export function transcriptTrailing(e: CoordinatorEntry): string {
  let trailing = `R${e.round}`;
  if (e.provider) trailing += ` · ${e.provider}`;
  if (e.touched && (e.touched.insertions || e.touched.deletions)) {
    trailing += ` · +${e.touched.insertions}/−${e.touched.deletions}`;
  }
  return trailing;
}

export function buildCoordinatorBoard(ledger: CoordinatorLedger | undefined): CanvasBoardView {
  if (!ledger) return idleBoard();
  // Head every non-active board with the task composer so assigning work is one
  // field away; an ACTIVE run omits it (you're watching, not queuing another).
  const base = sectionsFor(ledger);
  const sections = ledger.status === "active" ? base : [taskComposerSection(), ...base];
  return {
    view: "board",
    title: "Run loop",
    header: { status: statusPill(ledger.status), chip: `round ${ledger.round}` },
    sections,
  };
}

// The "give the squad a task" composer that heads the Run-loop board, so assigning
// work sits where its progress streams. Coordinate runs the full loop (watched in
// this panel); Ask the team fans one question out to the roster and synthesizes.
export function taskComposerSection(): Section {
  return {
    kind: "actions",
    title: "Give the squad a task",
    items: [
      {
        type: COORDINATE_ACTION,
        label: "Coordinate on a task",
        glyph: "↻",
        fields: [
          {
            name: "task",
            label: "Task",
            placeholder:
              'What should the squad accomplish? e.g. "add retry/backoff to the sync client and verify"',
            multiline: true,
          },
        ],
      },
      {
        type: DISPATCH_ACTION,
        label: "Ask the team",
        glyph: "✦",
        fields: [
          {
            name: "task",
            label: "Question",
            placeholder:
              'Ask every member at once, e.g. "what are the top risks in this migration?"',
            multiline: true,
          },
        ],
      },
    ],
  };
}

function sectionsFor(ledger: CoordinatorLedger): Section[] {
  switch (ledger.status) {
    case "active":
      return activeSections(ledger);
    case "done":
      return doneSections(ledger);
    case "max-rounds":
      return maxRoundsSections(ledger);
    case "verification-failed":
    case "change-quality-failed":
      return failedSections(ledger);
    case "gave-up":
      return gaveUpSections(ledger);
    default:
      return [
        {
          kind: "rows",
          items: [{ glyph: "warn", text: `Unrecognized run status: ${String(ledger.status)}` }],
        },
      ];
  }
}

function activeSections(ledger: CoordinatorLedger): Section[] {
  const sections: Section[] = [pulseSection(ledger), goalSection(ledger.task)];
  if (ledger.plan.length > 0) sections.push(planSection(ledger.plan));
  if (ledger.facts.length > 0) sections.push(findingsSection(ledger.facts));
  if (ledger.verification) sections.push(verificationSection(ledger.verification));
  if (ledger.failedSteps?.length) sections.push(abandonedSection(ledger.failedSteps));
  if (ledger.teamGaps?.length) sections.push(teamGapsSection(ledger.teamGaps));
  pushIf(sections, provenanceSection(ledger.transcript));
  if (ledger.inFlight) sections.push(inFlightSection(ledger.inFlight));
  pushIf(sections, transcriptSection(ledger.transcript));
  return sections;
}

// "What's happening now": the one turn currently executing, rendered only while the run is
// active (the active layout is the only caller). The completed turn then lives in the Transcript.
function inFlightSection(inFlight: InFlightTurn): Section {
  return {
    kind: "cards",
    title: "In flight",
    items: [
      {
        title: inFlight.speaker ?? "coordinator",
        dot: identityTone(inFlight.speaker),
        pill: { label: inFlight.action, tone: "accent" },
        fields: [{ label: "round", value: `R${inFlight.round}` }],
        ...(inFlight.instruction
          ? { reason: { label: "now", text: truncate(inFlight.instruction, STEP_CAP) } }
          : {}),
      },
    ],
  };
}

function doneSections(ledger: CoordinatorLedger): Section[] {
  const sections: Section[] = [];
  if (ledger.summary?.trim()) sections.push(standupSection(ledger.summary));
  if (ledger.verification) sections.push(verificationSection(ledger.verification));
  pushIf(sections, provenanceSection(ledger.transcript));
  if (ledger.facts.length > 0) sections.push(findingsSection(ledger.facts));
  sections.push(goalSection(ledger.task));
  pushIf(sections, transcriptSection(ledger.transcript));
  return sections;
}

function maxRoundsSections(ledger: CoordinatorLedger): Section[] {
  const tail = ledger.verification?.passed
    ? "The artifact is independently green; review and accept."
    : "Review where it stalled.";
  const sections: Section[] = [
    advisorySection("caution", `Needs you — the run hit its round budget. ${tail}`),
  ];
  if (ledger.verification) sections.push(verificationSection(ledger.verification));
  pushIf(sections, provenanceSection(ledger.transcript));
  if (ledger.facts.length > 0) sections.push(findingsSection(ledger.facts));
  pushIf(sections, transcriptSection(ledger.transcript));
  return sections;
}

function failedSections(ledger: CoordinatorLedger): Section[] {
  const sections: Section[] = [];
  if (ledger.verification) sections.push(verificationSection(ledger.verification));
  sections.push(
    advisorySection(
      "error",
      "The done-gate came back red — the artifact does not pass; there is no accept path. Inspect the failures and re-dispatch.",
    ),
  );
  pushIf(sections, provenanceSection(ledger.transcript));
  pushIf(sections, transcriptSection(ledger.transcript));
  return sections;
}

function gaveUpSections(ledger: CoordinatorLedger): Section[] {
  const sections: Section[] = [];
  if (ledger.summary?.trim()) {
    sections.push({
      kind: "rows",
      title: "Summary",
      items: [{ glyph: "warn", text: truncate(ledger.summary, GOAL_CAP) || "(no summary)" }],
    });
  }
  pushIf(sections, provenanceSection(ledger.transcript));
  pushIf(sections, transcriptSection(ledger.transcript));
  return sections;
}

// The pulse `stats` strip: round, findings, and the two loop counters. A zero count tones
// neutral so an early or calm run doesn't shout.
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

function goalSection(task: string): Section {
  return {
    kind: "rows",
    title: "Goal",
    items: [{ glyph: "info", text: truncate(task, GOAL_CAP) || "(no goal)" }],
  };
}

function standupSection(summary: string): Section {
  return {
    kind: "rows",
    title: "Standup",
    items: [{ glyph: "brand", icon: "◆", text: truncate(summary, GOAL_CAP) || "(no summary)" }],
  };
}

function advisorySection(tone: CanvasTone, text: string): Section {
  return { kind: "rows", title: "Advisory", items: [{ glyph: tone, text }] };
}

function planSection(plan: readonly string[]): Section {
  return {
    kind: "rows",
    title: "Plan",
    items: plan.map((step, i) => ({
      glyph: "neutral" as CanvasTone,
      text: `${i + 1}. ${truncate(step, STEP_CAP)}`,
    })),
  };
}

function findingsSection(facts: readonly string[]): Section {
  return {
    kind: "rows",
    title: "Findings",
    items: facts.slice(-MAX_FINDINGS).map((fact) => ({
      glyph: "brand" as CanvasTone,
      text: truncate(fact, STEP_CAP) || "(no detail)",
    })),
  };
}

function abandonedSection(failedSteps: readonly string[]): Section {
  return {
    kind: "rows",
    title: "Abandoned — do not resume",
    items: failedSteps.map((step) => ({
      glyph: "warn" as CanvasTone,
      text: truncate(step, STEP_CAP) || "(no detail)",
    })),
  };
}

function teamGapsSection(teamGaps: readonly string[]): Section {
  return {
    kind: "rows",
    title: "Team gaps — consider casting",
    items: teamGaps.map((gap) => ({
      glyph: "caution" as CanvasTone,
      text: truncate(gap, STEP_CAP) || "(no detail)",
    })),
  };
}

// "Worked by": served-provider provenance — which vendor produced each member's work unit.
// Makes a mixed-provider run legible at a glance (the squad's flagship over Copilot-locked squad).
function provenanceSection(transcript: readonly CoordinatorEntry[]): Section | undefined {
  const lines = provenanceLines(transcript);
  if (lines.length === 0) return undefined;
  return {
    kind: "rows",
    title: "Worked by",
    items: lines.map((l) => {
      const who = l.who || "team";
      return {
        glyph: identityTone(who),
        chip: { label: who, tone: identityTone(who) },
        text: l.verb,
        trailing: l.provider,
      };
    }),
  };
}

function verificationSection(v: VerificationRecord): Section {
  const checks = v.checks;
  return {
    kind: "rows",
    boxed: true,
    title: "Verification",
    items:
      checks && checks.length > 0
        ? checks.map((check) => ({
            glyph: check.passed ? "ok" : "error",
            icon: check.passed ? "✓" : "✕",
            text: truncate(check.command, STEP_CAP) || "verification",
            trailing: check.passed
              ? `passed · exit ${check.exitCode}`
              : `exit ${check.exitCode} · ${tailTruncate(check.summary, VERIFY_SUMMARY_CAP)}`,
          }))
        : [
            {
              glyph: v.passed ? "ok" : "error",
              icon: v.passed ? "✓" : "✕",
              text: truncate(v.command, STEP_CAP) || "verification",
              trailing: v.passed
                ? `passed · exit ${v.exitCode}`
                : `exit ${v.exitCode} · ${truncate(v.summary, VERIFY_SUMMARY_CAP)}`,
            },
          ],
  };
}

function transcriptSection(transcript: readonly CoordinatorEntry[]): Section | undefined {
  const recent = transcript.slice(-MAX_TRANSCRIPT);
  if (recent.length === 0) return undefined;
  return {
    kind: "rows",
    title: "Transcript",
    items: recent.map((e) => ({
      glyph: outcomeTone(e),
      chip: { label: e.speaker || "coordinator", tone: identityTone(e.speaker) },
      text: truncate(e.text, TRANSCRIPT_CAP) || "(no detail)",
      trailing: transcriptTrailing(e),
    })),
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
      return { label: "verification failed", tone: "error" };
    case "change-quality-failed":
      return { label: "change quality failed", tone: "error" };
    default:
      return { label: "unknown", tone: "neutral" };
  }
}

function pushIf(sections: Section[], section: Section | undefined): void {
  if (section) sections.push(section);
}

function idleBoard(): CanvasBoardView {
  return {
    view: "board",
    title: "Run loop",
    header: { status: { label: "idle", tone: "neutral" as CanvasTone }, chip: "coordinator" },
    sections: [
      taskComposerSection(),
      {
        kind: "rows",
        items: [
          {
            glyph: "neutral" as CanvasTone,
            text: "No coordinator run yet — give the squad a task above. The loop's plan, findings, abandoned steps, and progress stream here.",
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

function tailTruncate(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `…${t.slice(-(max - 1))}` : t;
}
