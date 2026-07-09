import type { CanvasBoardView, CanvasTone } from "@keelson/shared";
import {
  type CoordinatorEntry,
  type CoordinatorLedger,
  type InFlightTurn,
  SHORT_ACKNOWLEDGMENT_RE,
  type VerificationRecord,
} from "../coordinator.ts";
import { formatTokens, formatUsageTail } from "../format.ts";
import type { ToolTrace } from "../turn-runner.ts";

// Pure: a coordinator run ledger -> a canvas `board` (the Run-loop panel). No ledger — no run
// yet, or a torn/unreadable file — renders a calm idle board. Validated against canvasViewSchema
// in tests; the collector never parses (validation lives at the binding edge via expectView).

type Section = CanvasBoardView["sections"][number];
type RowItem = Extract<Section, { kind: "rows" }>["items"][number];

// The two "assign work" verbs the Run-loop composer offers. Shared with onAction so
// the action types can't drift from their handlers. Coordinate runs the full
// plan→delegate→observe loop (watched in this panel); dispatch fans one question out
// to the whole roster and synthesizes.
export const COORDINATE_ACTION = "coordinate";
export const DISPATCH_ACTION = "dispatch";
export const STOP_COORDINATOR_ACTION = "stop-coordinate";
export const STEER_COORDINATOR_ACTION = "steer-coordinate";
export const ROLLBACK_RUN_ACTION = "rollback-run";
export const REPORT_RUN_ACTION = "squad-report";
// The teardown verb: return this scope's whole surface to the empty first moment.
// Shared with onAction so the action type can't drift from its handler.
export const RESET_SQUAD_ACTION = "reset-squad";

const GOAL_CAP = 280;
const STEP_CAP = 200;
const LEDGER_ROW_CAP = 200;
const DETAIL_CAP = 4000;
const VERIFY_SUMMARY_CAP = 120;
const MAX_FINDINGS = 12;
// Rounds rendered as full entry groups in the Ledger; older rounds compress to a stub.
const LEDGER_ROUNDS_SHOWN = 3;
// Grid cells in the round rail; a longer run shows its most recent window.
const MAX_RAIL_ROUNDS = 16;
const NOW_TRACE_SHOWN = 3;

// Speaker label → the member's persisted identity tone (id-blue…id-olive, from
// the record's identitySlot). Coordinator keeps brand; a speaker with no living
// member record (retired, multi-speaker labels, pre-slot ledgers) folds to
// neutral + name — never a hash, never a status hue.
export type IdentityTones = ReadonlyMap<string, CanvasTone>;

export function identityTone(speaker: string | undefined, tones?: IdentityTones): CanvasTone {
  if (!speaker || speaker === "coordinator") return "brand";
  return tones?.get(speaker.trim().toLowerCase()) ?? "neutral";
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
    case "probe":
      return "info";
    case "steer":
      return "brand";
    case "verify": {
      if (e.verdict === "block") return "error";
      if (e.verdict === "pass") return "ok";
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
  if (e.usage) trailing += ` · ${formatTokens(e.usage.inputTokens + e.usage.outputTokens)} tok`;
  if (e.touched && (e.touched.insertions || e.touched.deletions)) {
    trailing += ` · +${e.touched.insertions}/−${e.touched.deletions}`;
  }
  return trailing;
}

// Markdown control characters leak into one-line previews as noise (##, **, `code`);
// strip them for row text. Deliberately conservative: paired emphasis markers
// (** __), boundary-delimited _phrase_ spans, backticks, and heading hashes go —
// a bare _ inside a word stays, so identifiers like foo_bar and glob args like
// --filter '*' survive. Detail bodies keep raw text.
export function stripMd(text: string): string {
  return text
    .replace(/```[a-zA-Z]*\n?/g, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,;:!?])/gm, "$1$2")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

// A charter body ready for a board: markdown stripped, the member's own H1 name
// dropped from the head (a card never needs to re-introduce its own member), and
// the cast-provenance sentence removed — the board's cast field already says it.
export function charterDisplay(name: string, charter: string): string {
  let text = stripMd(charter);
  const trimmedName = name.trim();
  if (trimmedName) {
    const escaped = trimmedName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(`^${escaped}\\b[\\s.:—–-]*`, "i"), "");
  }
  return text.replace(/^Cast from [^.]{1,80}\.\s*/i, "");
}

// Like charterDisplay, but for a disclosure body: strips the same markdown markers
// while PRESERVING the charter's section/paragraph newlines, so "## Role" / "## Mission"
// / "## Voice" read as separated blocks under the row instead of collapsing to one
// run-on paragraph (the .cvb-row-detail renderer is pre-wrap). Same self-name and
// cast-provenance strip as charterDisplay.
export function charterDetail(name: string, charter: string): string {
  let text = charter
    .replace(/```[a-zA-Z]*\n?/g, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,;:!?])/gm, "$1$2")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[^\S\n]+/g, " ")
    .replace(/[^\S\n]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const trimmedName = name.trim();
  if (trimmedName) {
    const escaped = trimmedName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Consume the name AND its following blank line so the provenance strip below
    // still anchors at the start.
    text = text.replace(new RegExp(`^${escaped}\\b\\s*`, "i"), "");
  }
  return text.replace(/^Cast from [^.]{1,80}\.\s*/i, "").trim();
}

export function buildCoordinatorBoard(
  ledger: CoordinatorLedger | undefined,
  tones?: IdentityTones,
  scopeId?: string,
  hasMembers = false,
): CanvasBoardView {
  if (!ledger) return idleBoard(hasMembers);
  // Head every non-active board with the task composer so assigning work is one
  // field away; an ACTIVE run omits it (you're watching, not queuing another).
  const base = sectionsFor(ledger, undefined, tones, scopeId);
  // A terminal board leads with the composer and ends with the teardown verb; an
  // ACTIVE run omits both (you Stop a live run before resetting the scope).
  const sections =
    ledger.status === "active" ? base : [taskComposerSection(), ...base, resetSection()];
  return {
    view: "board",
    title: "Run loop",
    header: { status: statusPill(ledger.status), chip: `round ${ledger.round}` },
    sections,
  };
}

// One archived run rendered as its own drill-down board — the same sections the live
// Run-loop shows for that status, minus the task composer (a history drawer is for
// reading, not queuing work) and with every round of the ledger: this view IS the
// full record the live board's older-rounds stub points at. Absent ledger renders a
// calm not-found board.
export function buildRunDetailBoard(
  ledger: CoordinatorLedger | undefined,
  id: string,
  tones?: IdentityTones,
  scopeId?: string,
): CanvasBoardView {
  if (!ledger) {
    return {
      view: "board",
      title: "Run",
      header: { status: { label: "not found", tone: "neutral" as CanvasTone }, chip: id },
      sections: [
        {
          kind: "rows",
          items: [
            { glyph: "neutral" as CanvasTone, text: `No archived run '${id}' in this scope.` },
          ],
        },
      ],
    };
  }
  const body = sectionsFor(ledger, Number.POSITIVE_INFINITY, tones, scopeId);
  const detailBody = body[0]?.kind === "stats" ? body.slice(1) : body;
  const sections: Section[] = [runReportSection(id), pulseSection(ledger)];
  pushIf(sections, tokensPerRoundChartSection(ledger.transcript));
  sections.push(...detailBody);
  return {
    view: "board",
    title: "Run",
    header: { status: statusPill(ledger.status), chip: id },
    sections,
  };
}

// The one verb the history drawer carries: compose the deterministic styled run
// report for this archived ledger and open it. Read-only against the archive.
function runReportSection(id: string): Section {
  return {
    kind: "actions",
    items: [{ type: REPORT_RUN_ACTION, label: "Report", glyph: "▤", payload: { runId: id } }],
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

function sectionsFor(
  ledger: CoordinatorLedger,
  ledgerRounds = LEDGER_ROUNDS_SHOWN,
  tones?: IdentityTones,
  scopeId?: string,
): Section[] {
  switch (ledger.status) {
    case "active":
      return activeSections(ledger, ledgerRounds, tones, scopeId);
    case "done":
      return doneSections(ledger, ledgerRounds, tones);
    case "max-rounds":
      return maxRoundsSections(ledger, ledgerRounds, tones);
    case "max-tokens":
      return maxTokensSections(ledger, ledgerRounds, tones);
    case "verification-failed":
    case "change-quality-failed":
      return failedSections(ledger, ledgerRounds, tones, scopeId);
    case "gave-up":
      return gaveUpSections(ledger, ledgerRounds, tones);
    case "aborted":
      return abortedSections(ledger, ledgerRounds, tones, scopeId);
    default:
      return [
        {
          kind: "rows",
          items: [{ glyph: "warn", text: `Unrecognized run status: ${String(ledger.status)}` }],
        },
      ];
  }
}

function activeSections(
  ledger: CoordinatorLedger,
  ledgerRounds: number,
  tones?: IdentityTones,
  scopeId?: string,
): Section[] {
  const sections: Section[] = [
    pulseSection(ledger),
    steerSection(ledger, scopeId),
    stopSection(ledger, scopeId),
  ];
  const findings = visibleFindings(ledger);
  pushIf(sections, roundRailSection(ledger, tones));
  sections.push(goalSection(ledger.task));
  if (ledger.plan.length > 0) sections.push(planSection(ledger.plan));
  if (ledger.inFlight) sections.push(...nowSections(ledger.inFlight, tones));
  if (findings.length > 0) sections.push(findingsSection(findings));
  if (ledger.verification) sections.push(verificationSection(ledger.verification));
  if (ledger.failedSteps?.length) sections.push(abandonedSection(ledger.failedSteps));
  if (ledger.teamGaps?.length) sections.push(teamGapsSection(ledger.teamGaps));
  pushIf(sections, gateHistorySection(ledger.transcript));
  pushIf(sections, mindsSection(ledger.transcript, tones));
  sections.push(...ledgerSections(ledger.transcript, ledgerRounds, tones));
  return sections;
}

// Inject an operator instruction the live run folds into its facts and honors next round.
function steerSection(ledger: CoordinatorLedger, scopeId?: string): Section {
  return {
    kind: "actions",
    title: "Steer the run",
    items: [
      {
        type: STEER_COORDINATOR_ACTION,
        label: "Steer",
        glyph: "➤",
        payload: { scopeId: scopeId ?? ledger.scopeId ?? "default" },
        fields: [
          {
            name: "instruction",
            label: "Instruction",
            placeholder:
              'A fact or course-correction the next round folds in, e.g. "prefer the existing retry helper — don\'t add a new one"',
            multiline: true,
          },
        ],
      },
    ],
  };
}

// The caller's scopeId is authoritative (the collector knows which scope it rendered);
// ledger.scopeId only covers ledgers persisted before scopeId existed.
function stopSection(ledger: CoordinatorLedger, scopeId?: string): Section {
  return {
    kind: "actions",
    title: "Live run",
    items: [
      {
        type: STOP_COORDINATOR_ACTION,
        label: "Stop run",
        glyph: "■",
        tone: "warn",
        destructive: true,
        inline: true,
        payload: { scopeId: scopeId ?? ledger.scopeId ?? "default" },
        confirm: {
          title: "Stop this coordinator run?",
          body: `Round ${ledger.round} will be marked aborted. The transcript stays intact.`,
          confirmLabel: "Stop run",
        },
      },
    ],
  };
}

function rollbackSection(ledger: CoordinatorLedger, scopeId?: string): Section {
  return {
    kind: "actions",
    title: "Rollback",
    items: [
      {
        type: ROLLBACK_RUN_ACTION,
        label: "Rollback",
        glyph: "↶",
        tone: "warn",
        destructive: true,
        inline: true,
        payload: {
          run: runId(ledger.createdAt),
          confirm: false,
          scopeId: scopeId ?? ledger.scopeId ?? "default",
        },
        confirm: {
          title: "Preview rollback manifest?",
          body: "The first step calls squad_rollback without confirm:true to render the full C/M/D manifest before any mutation.",
          confirmLabel: "Preview rollback",
        },
      },
    ],
  };
}

// Return the scope's whole surface to the empty first moment: retire every member and
// clear run history, the current run loop, rollback records, and any pending proposal.
// Project decisions live in host memory and are kept. Rendered only on a terminal
// board — a live run is Stopped first — so it is reachable exactly when orphaned run
// state (a done squad that outlived its roster) needs clearing. Carries no scopeId
// payload: like retire-all, the handler acts on the selected scope (the same scope the
// selection-bound panels refresh), not a board-baked one.
function resetSection(): Section {
  return {
    kind: "actions",
    title: "Reset squad",
    items: [
      {
        type: RESET_SQUAD_ACTION,
        label: "Reset squad…",
        glyph: "⟲",
        tone: "warn",
        destructive: true,
        inline: true,
        confirm: {
          title: "Reset this squad?",
          body: "Retire every member and clear this scope's run history, current run loop, rollback records, and any pending proposal — returning the surface to its empty state. Project decisions are kept. This cannot be undone.",
          confirmLabel: "Reset squad",
          cancelLabel: "Cancel",
        },
      },
    ],
  };
}

function doneSections(
  ledger: CoordinatorLedger,
  ledgerRounds: number,
  tones?: IdentityTones,
): Section[] {
  const sections: Section[] = [];
  const findings = visibleFindings(ledger);
  if (ledger.summary?.trim()) sections.push(standupSection(ledger.summary));
  if (ledger.verification) sections.push(verificationSection(ledger.verification));
  pushIf(sections, gateHistorySection(ledger.transcript));
  pushIf(sections, mindsSection(ledger.transcript, tones));
  if (findings.length > 0) sections.push(findingsSection(findings));
  sections.push(goalSection(ledger.task));
  sections.push(...ledgerSections(ledger.transcript, ledgerRounds, tones));
  return sections;
}

function maxRoundsSections(
  ledger: CoordinatorLedger,
  ledgerRounds: number,
  tones?: IdentityTones,
): Section[] {
  const findings = visibleFindings(ledger);
  const tail = ledger.verification?.passed
    ? "The artifact is independently green; review and accept."
    : "Review where it stalled.";
  const sections: Section[] = [
    advisorySection("caution", `Needs you — the run hit its round budget. ${tail}`),
  ];
  if (ledger.verification) sections.push(verificationSection(ledger.verification));
  pushIf(sections, gateHistorySection(ledger.transcript));
  pushIf(sections, mindsSection(ledger.transcript, tones));
  if (findings.length > 0) sections.push(findingsSection(findings));
  sections.push(...ledgerSections(ledger.transcript, ledgerRounds, tones));
  return sections;
}

function maxTokensSections(
  ledger: CoordinatorLedger,
  ledgerRounds: number,
  tones?: IdentityTones,
): Section[] {
  const findings = visibleFindings(ledger);
  const sections: Section[] = [
    advisorySection("caution", "Needs you — the run hit its token budget."),
  ];
  if (ledger.verification) sections.push(verificationSection(ledger.verification));
  pushIf(sections, gateHistorySection(ledger.transcript));
  pushIf(sections, mindsSection(ledger.transcript, tones));
  if (findings.length > 0) sections.push(findingsSection(findings));
  sections.push(...ledgerSections(ledger.transcript, ledgerRounds, tones));
  return sections;
}

function failedSections(
  ledger: CoordinatorLedger,
  ledgerRounds: number,
  tones?: IdentityTones,
  scopeId?: string,
): Section[] {
  const sections: Section[] = [rollbackSection(ledger, scopeId)];
  if (ledger.verification) sections.push(verificationSection(ledger.verification));
  sections.push(
    advisorySection(
      "error",
      "The done-gate came back red — the artifact does not pass; there is no accept path. Inspect the failures and re-dispatch.",
    ),
  );
  pushIf(sections, gateHistorySection(ledger.transcript));
  pushIf(sections, mindsSection(ledger.transcript, tones));
  sections.push(...ledgerSections(ledger.transcript, ledgerRounds, tones));
  return sections;
}

function gaveUpSections(
  ledger: CoordinatorLedger,
  ledgerRounds: number,
  tones?: IdentityTones,
): Section[] {
  const sections: Section[] = [];
  if (ledger.summary?.trim()) {
    sections.push({
      kind: "rows",
      title: "Summary",
      items: [
        {
          glyph: "warn",
          text: stripMd(truncate(ledger.summary, GOAL_CAP)) || "(no summary)",
          ...detailWhenTruncated(ledger.summary, GOAL_CAP),
        },
      ],
    });
  }

  pushIf(sections, mindsSection(ledger.transcript, tones));
  sections.push(...ledgerSections(ledger.transcript, ledgerRounds, tones));
  return sections;
}

function abortedSections(
  ledger: CoordinatorLedger,
  ledgerRounds: number,
  tones?: IdentityTones,
  scopeId?: string,
): Section[] {
  const sections: Section[] = [
    rollbackSection(ledger, scopeId),
    advisorySection("neutral", "Stopped by the operator. The transcript is intact."),
  ];
  pushIf(sections, mindsSection(ledger.transcript, tones));
  sections.push(...ledgerSections(ledger.transcript, ledgerRounds, tones));
  return sections;
}

// The pulse `stats` strip: round (n or n/budget with escalating tone), the two loop
// counters, and — when entries carry usage — the run's token total. A zero count
// tones neutral so an early or calm run doesn't shout.
function pulseSection(ledger: CoordinatorLedger): Section {
  const toned = (n: number, tone: CanvasTone): CanvasTone => (n > 0 ? tone : "neutral");
  const findingsCount = visibleFindings(ledger).length;
  const tokens = ledger.transcript.reduce(
    (sum, e) => sum + (e.usage ? e.usage.inputTokens + e.usage.outputTokens : 0),
    0,
  );
  return {
    kind: "stats",
    items: [
      { label: "Round", value: roundStatValue(ledger), tone: roundStatTone(ledger) },
      { label: "Findings", value: findingsCount, tone: toned(findingsCount, "brand") },
      { label: "Stalls", value: ledger.stallCount, tone: toned(ledger.stallCount, "caution") },
      { label: "Re-plans", value: ledger.resetCount, tone: toned(ledger.resetCount, "caution") },
      ...(tokens > 0
        ? [{ label: "Tokens", value: formatTokens(tokens), tone: "info" as CanvasTone }]
        : []),
    ],
  };
}

function tokensPerRoundChartSection(transcript: readonly CoordinatorEntry[]): Section | undefined {
  const byRound = new Map<number, { input: number; output: number; hasUsage: boolean }>();
  for (const e of transcript) {
    const agg = byRound.get(e.round) ?? { input: 0, output: 0, hasUsage: false };
    if (e.usage) {
      agg.input += e.usage.inputTokens;
      agg.output += e.usage.outputTokens;
      agg.hasUsage = true;
    }
    byRound.set(e.round, agg);
  }
  if ([...byRound.values()].filter((round) => round.hasUsage).length < 2) return undefined;
  const rounds = [...byRound.entries()].sort(([a], [b]) => a - b);
  return {
    kind: "chart",
    title: "Tokens per round",
    yLabel: "tokens",
    series: [
      {
        label: "input",
        points: rounds.map(([round, agg]) => ({ x: round, y: agg.input })),
      },
      {
        label: "output",
        points: rounds.map(([round, agg]) => ({ x: round, y: agg.output })),
      },
    ],
  };
}

function roundStatValue(ledger: CoordinatorLedger): number | string {
  return ledger.roundBudget === undefined
    ? ledger.round
    : `${ledger.round} / ${ledger.roundBudget}`;
}

function roundStatTone(ledger: CoordinatorLedger): CanvasTone {
  if (ledger.round <= 0) return "neutral";
  const budget = ledger.roundBudget;
  if (budget === undefined || budget <= 0) return "info";
  return ledger.round / budget >= 0.8 ? "caution" : "info";
}

// The run's shape at a glance: one grid cell per round, its badge naming the round's
// dominant event and toned by outcome — a red gate stands out, the coding grind reads
// as a run of accent cells, the in-flight round marks itself. Absent until the
// transcript has at least one entry.
function roundRailSection(ledger: CoordinatorLedger, tones?: IdentityTones): Section | undefined {
  if (ledger.transcript.length === 0 && !ledger.inFlight) return undefined;
  const byRound = new Map<number, CoordinatorEntry[]>();
  for (const e of ledger.transcript) {
    const list = byRound.get(e.round) ?? [];
    list.push(e);
    byRound.set(e.round, list);
  }
  const last = Math.max(ledger.round, ...byRound.keys());
  const first = Math.max(0, last - MAX_RAIL_ROUNDS + 1);
  const cells: { label: string; badge: { text: string; tone?: CanvasTone } }[] = [];
  for (let r = first; r <= last; r++) {
    const entries = byRound.get(r) ?? [];
    if (ledger.inFlight && ledger.inFlight.round === r && ledger.status === "active") {
      cells.push({ label: `R${r}`, badge: { text: "▶ now", tone: "info" } });
      continue;
    }
    if (entries.length === 0) continue;
    cells.push({ label: `R${r}`, badge: roundBadge(entries, tones) });
  }
  if (cells.length === 0) return undefined;
  return { kind: "grid", title: "Rounds", cells };
}

function roundBadge(
  entries: readonly CoordinatorEntry[],
  tones?: IdentityTones,
): { text: string; tone?: CanvasTone } {
  const gateRed = entries.some((e) => e.kind === "verify" && outcomeTone(e) === "error");
  if (gateRed) return { text: "gate ✕", tone: "error" };
  if (entries.some((e) => e.kind === "replan")) return { text: "re-plan", tone: "caution" };
  // A member's rail cell wears that member's identity hue — who acted each
  // round, at a glance; red stays reserved for the gate above.
  const code = entries.find((e) => e.kind === "code");
  if (code) {
    return code.speaker
      ? { text: `${code.speaker} ⌥`, tone: identityTone(code.speaker, tones) }
      : { text: "code", tone: "accent" };
  }
  const verified = entries.some((e) => e.kind === "verify" && outcomeTone(e) === "ok");
  if (verified) return { text: "verified ✓", tone: "ok" };
  const dispatch = entries.find((e) => e.kind === "dispatch" || e.kind === "workflow");
  if (dispatch) {
    return dispatch.speaker
      ? { text: dispatch.speaker, tone: identityTone(dispatch.speaker, tones) }
      : { text: "team", tone: "info" };
  }
  return { text: "plan", tone: "neutral" };
}

function goalSection(task: string): Section {
  return {
    kind: "rows",
    title: "Goal",
    items: [
      {
        glyph: "info",
        text: stripMd(truncate(task, GOAL_CAP)) || "(no goal)",
        ...detailWhenTruncated(task, GOAL_CAP),
      },
    ],
  };
}

function standupSection(summary: string): Section {
  return {
    kind: "rows",
    title: "Standup",
    items: [
      {
        glyph: "brand",
        icon: "◆",
        text: stripMd(truncate(summary, GOAL_CAP)) || "(no summary)",
        ...detailWhenTruncated(summary, GOAL_CAP),
      },
    ],
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
    items: facts.slice(-MAX_FINDINGS).map((fact) => {
      const normalized = normalizeSpeakerPrefixes(fact);
      return {
        glyph: "brand" as CanvasTone,
        text: stripMd(truncate(normalized, STEP_CAP)) || "(no detail)",
        ...detailWhenTruncated(normalized, STEP_CAP),
      };
    }),
  };
}

function visibleFindings(ledger: CoordinatorLedger): string[] {
  const speakers = knownSpeakerLabels(ledger.transcript);
  return ledger.facts.filter((fact) => !isHiddenFinding(fact, speakers));
}

// A member often opens a turn with a self-intro ("Edie here.") before the narration;
// drop it so a preamble test anchors on the real first clause.
const SELF_INTRO_RE = /^\w+ here[.!]\s*/i;
// An "I'll …" / "I will …" intent lead — a turn preamble, not a finding. Deliberately
// narrower than the code arm's full opener set (which also matches "first,"/"now,"/
// "next,"): those legitimately lead real findings, and hiding a whole fact on them
// would drop real content. Pure standalone acknowledgments are caught end-anchored.
const INTENT_LEAD_RE = /^i['’]ll\b|^i will\b/i;

function narrationBody(text: string, speakers: ReadonlySet<string>): string {
  return stripKnownSpeakerLabels(normalizeSpeakerPrefixes(stripMd(text)), speakers).replace(
    SELF_INTRO_RE,
    "",
  );
}

function isNarrationOnly(body: string): boolean {
  return SHORT_ACKNOWLEDGMENT_RE.test(body) || INTENT_LEAD_RE.test(body);
}

function isHiddenFinding(fact: string, speakers: ReadonlySet<string>): boolean {
  const body = narrationBody(fact, speakers);
  return body === "(no synthesis)" || isNarrationOnly(body);
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

// "What's happening now": the one turn currently executing — its card, then (when the
// live relay has streamed any) the tail of its tool trace, so the operator watches the
// mind work instead of a frozen instruction. Active layout is the only caller.
function nowSections(inFlight: InFlightTurn, tones?: IdentityTones): Section[] {
  const sections: Section[] = [
    {
      kind: "cards",
      title: "In flight",
      items: [
        {
          title: inFlight.speaker ?? "coordinator",
          dot: identityTone(inFlight.speaker, tones),
          pill: { label: inFlight.action, tone: "accent" },
          fields: [
            { label: "round", value: `R${inFlight.round}` },
            ...(inFlight.startedAt
              ? [{ label: "started", value: shortTime(inFlight.startedAt) }]
              : []),
            ...(inFlight.tools?.length ? [{ label: "tools", value: inFlight.tools.length }] : []),
          ],
          ...(inFlight.instruction
            ? { reason: { label: "now", text: truncate(inFlight.instruction, STEP_CAP) } }
            : {}),
        },
      ],
    },
  ];
  if (inFlight.tools?.length) {
    sections.push({
      kind: "rows",
      items: inFlight.tools.slice(-NOW_TRACE_SHOWN).map((t, i, shown) => ({
        glyph: toolGlyph(t, i === shown.length - 1),
        icon: t.ok === false ? "✕" : t.ok === true ? "✓" : "⟳",
        text: t.target ? `${t.name} ${t.target}` : t.name,
        ...(i === shown.length - 1 && t.ok === undefined ? { trailing: "running" } : {}),
      })),
    });
  }
  return sections;
}

function toolGlyph(t: ToolTrace, isLast: boolean): CanvasTone {
  if (t.ok === false) return "error";
  if (t.ok === true) return "ok";
  return isLast ? "info" : "neutral";
}

// Verification and change-quality verdicts across the whole run, one line per event —
// the gate's history stays legible even after its entries scroll out of the ledger
// window's full groups.
function gateHistorySection(transcript: readonly CoordinatorEntry[]): Section | undefined {
  const gates = transcript.filter((e) => e.kind === "verify");
  if (gates.length === 0) return undefined;
  return {
    kind: "rows",
    title: "Gate history",
    items: gates.map((e) => {
      const tone = outcomeTone(e);
      return {
        glyph: tone,
        icon: tone === "error" ? "✕" : tone === "ok" ? "✓" : "·",
        text: stripMd(truncate(firstLine(e.text), STEP_CAP)),
        trailing: `R${e.round}`,
        ...entryDetail(e),
      };
    }),
  };
}

// One lane per mind: who worked, on what provider, how many turns, what it cost, and
// its latest act — the "Worked by" list grown into the identity panel the operator
// actually asks questions of. Coordinator/gate entries stay out (they're the harness).
function mindsSection(
  transcript: readonly CoordinatorEntry[],
  tones?: IdentityTones,
): Section | undefined {
  const bySpeaker = new Map<
    string,
    {
      turns: number;
      tokens: number;
      inputTokens: number;
      outputTokens: number;
      providers: Set<string>;
      last: CoordinatorEntry;
    }
  >();
  for (const e of transcript) {
    if (e.kind !== "dispatch" && e.kind !== "code" && e.kind !== "workflow") continue;
    const speaker = e.speaker?.trim();
    if (!speaker) continue;
    const agg = bySpeaker.get(speaker) ?? {
      turns: 0,
      tokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      providers: new Set<string>(),
      last: e,
    };
    agg.turns += 1;
    if (e.usage) {
      agg.tokens += e.usage.inputTokens + e.usage.outputTokens;
      agg.inputTokens += e.usage.inputTokens;
      agg.outputTokens += e.usage.outputTokens;
    }
    if (e.provider) agg.providers.add(e.provider);
    agg.last = e;
    bySpeaker.set(speaker, agg);
  }
  if (bySpeaker.size === 0) return undefined;
  return {
    kind: "cards",
    title: "Minds",
    items: [...bySpeaker.entries()].map(([speaker, agg]) => ({
      title: speaker,
      dot: identityTone(speaker, tones),
      ...(agg.providers.size > 0 ? { pill: { label: [...agg.providers].join("+") } } : {}),
      fields: [
        { label: "turns", value: agg.turns },
        ...(agg.tokens > 0
          ? [
              { label: "tok", value: formatTokens(agg.tokens) },
              {
                label: "in/out",
                value: formatUsageTail({
                  inputTokens: agg.inputTokens,
                  outputTokens: agg.outputTokens,
                }),
              },
            ]
          : []),
        ...(agg.last.touched && (agg.last.touched.insertions || agg.last.touched.deletions)
          ? [
              {
                label: "Δ",
                value: `+${agg.last.touched.insertions}/−${agg.last.touched.deletions}`,
              },
            ]
          : []),
      ],
      reason: { label: "last", text: stripMd(truncate(agg.last.text, STEP_CAP)) || "(no detail)" },
    })),
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
            glyph: check.passed ? ("ok" as CanvasTone) : ("error" as CanvasTone),
            icon: check.passed ? "✓" : "✕",
            text: truncate(check.command, STEP_CAP) || "verification",
            trailing: check.passed
              ? `passed · exit ${check.exitCode}`
              : `exit ${check.exitCode} · ${tailTruncate(check.summary, VERIFY_SUMMARY_CAP)}`,
            ...(check.passed || !check.summary.trim()
              ? {}
              : { detail: truncate(check.summary, DETAIL_CAP) }),
          }))
        : [
            {
              glyph: v.passed ? ("ok" as CanvasTone) : ("error" as CanvasTone),
              icon: v.passed ? "✓" : "✕",
              text: truncate(v.command, STEP_CAP) || "verification",
              trailing: v.passed
                ? `passed · exit ${v.exitCode}`
                : `exit ${v.exitCode} · ${truncate(v.summary, VERIFY_SUMMARY_CAP)}`,
              ...(v.passed || !v.summary.trim() ? {} : { detail: truncate(v.summary, DETAIL_CAP) }),
            },
          ],
  };
}

// The Ledger: the transcript grouped by round, newest first. The most recent rounds
// render every entry (expandable to the full stored text + instruction + tool trace);
// older rounds compress to a one-line stub instead of silently vanishing — the current
// board's worst honesty gap (r11 hid 17 of its 29 entries). The run-detail board
// passes Infinity so the archive drill-down really is the full record.
function ledgerSections(
  transcript: readonly CoordinatorEntry[],
  roundsShown = LEDGER_ROUNDS_SHOWN,
  tones?: IdentityTones,
): Section[] {
  if (transcript.length === 0) return [];
  const speakers = knownSpeakerLabels(transcript);
  const rounds: number[] = [];
  const byRound = new Map<number, CoordinatorEntry[]>();
  for (const e of transcript) {
    if (!byRound.has(e.round)) {
      byRound.set(e.round, []);
      rounds.push(e.round);
    }
    byRound.get(e.round)?.push(e);
  }
  rounds.sort((a, b) => b - a);
  const shown = rounds.slice(0, roundsShown);
  const older = rounds.slice(roundsShown);

  const sections: Section[] = shown.map((r, i) => {
    const entries = byRound.get(r) ?? [];
    return {
      kind: "rows",
      title: i === 0 ? `Ledger · R${r}${roundCaption(entries)}` : `R${r}${roundCaption(entries)}`,
      items: entries.map((e) => ledgerRow(e, speakers, tones)),
    };
  });

  if (older.length > 0) {
    const olderEntries = older.reduce((n, r) => n + (byRound.get(r)?.length ?? 0), 0);
    const span =
      older.length === 1
        ? `R${older[older.length - 1]}`
        : `R${older[older.length - 1]}–R${older[0]}`;
    sections.push({
      kind: "rows",
      items: [
        {
          glyph: "neutral",
          text: `${span} · ${olderEntries} earlier ${olderEntries === 1 ? "entry" : "entries"} — the full run is archived in Runs`,
        },
      ],
    });
  }
  return sections;
}

function roundCaption(entries: readonly CoordinatorEntry[]): string {
  const kinds = new Set(entries.map((e) => e.kind));
  const parts: string[] = [];
  if (kinds.has("code")) parts.push("code");
  if (kinds.has("dispatch")) parts.push("team");
  if (kinds.has("workflow")) parts.push("workflow");
  if (kinds.has("verify")) parts.push("gate");
  if (kinds.has("replan")) parts.push("re-plan");
  return parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
}

function ledgerRow(
  e: CoordinatorEntry,
  speakers: ReadonlySet<string>,
  tones?: IdentityTones,
): RowItem {
  const speaker = e.speaker?.trim() || "coordinator";
  const text = normalizeSpeakerPrefixes(e.text);
  return {
    glyph: isQuietLedgerEntry(e, speakers) ? "neutral" : outcomeTone(e),
    chip: { label: speaker, tone: identityTone(e.speaker?.trim() || undefined, tones) },
    text: stripMd(truncate(firstLine(text), LEDGER_ROW_CAP)) || "(no detail)",
    trailing: transcriptTrailing(e),
    ...entryDetail(e),
  };
}

function isQuietLedgerEntry(e: CoordinatorEntry, speakers: ReadonlySet<string>): boolean {
  if (e.kind !== "dispatch" && e.kind !== "code" && e.kind !== "workflow") return false;
  const body = narrationBody(e.text, speakers);
  return body === "(no synthesis)" || body.startsWith("(no synthesis) ") || isNarrationOnly(body);
}

// The expandable body behind a ledger row: the instruction the turn ran under, the
// full stored text (speaker prefixes normalized for display consistency with the
// preview), and the captured tool trace — everything the 200-char preview can't hold.
function entryDetail(e: CoordinatorEntry): { detail: string } | Record<string, never> {
  const parts: string[] = [];
  if (e.instruction?.trim()) parts.push(`instruction: ${e.instruction.trim()}`);
  const body = normalizeSpeakerPrefixes(e.text).trim();
  if (body) parts.push(body);
  if (e.tools?.length) {
    const lines = e.tools.map(
      (t) =>
        `${t.ok === false ? "✕" : t.ok === true ? "✓" : "·"} ${t.name}${t.target ? ` ${t.target}` : ""}`,
    );
    parts.push(`tools (${e.tools.length}):\n${lines.join("\n")}`);
  }
  const detail = parts.join("\n\n").trim();
  // A detail identical to (or shorter than) the preview adds a caret with nothing
  // behind it — only rows with more to show get the disclosure.
  const preview = stripMd(truncate(firstLine(normalizeSpeakerPrefixes(e.text)), LEDGER_ROW_CAP));
  if (!detail || (stripMd(detail) === preview && !e.instruction && !e.tools?.length)) return {};
  return { detail: truncate(detail, DETAIL_CAP) };
}

function normalizeSpeakerPrefixes(text: string): string {
  return text.replace(/(^|\n)((?:\[[^\]\n]{1,80}\]\s*)+)/g, (match, lineStart, prefixes) => {
    const names = [...String(prefixes).matchAll(/\[([^\]\n]{1,80})\]/g)]
      .map((m) => m[1]?.trim())
      .filter((name): name is string => !!name);
    const label = names.at(-1);
    return label ? `${lineStart}${label}: ` : match;
  });
}

// The labels that can legitimately prefix a fact or entry: the run's own transcript
// speakers plus the producer's wrapper labels. Restricting the strip to these keeps a
// colon-prefixed finding ("Risk: …", "src/foo.ts: …") from being mistaken for a
// speaker label and its body hidden as narration.
function knownSpeakerLabels(transcript: readonly CoordinatorEntry[]): Set<string> {
  const labels = new Set(["team", "coordinator", "gate", "verify"]);
  for (const e of transcript) {
    const speaker = e.speaker?.trim().toLowerCase();
    if (!speaker) continue;
    labels.add(speaker);
    for (const part of speaker.split(",")) {
      const token = part.trim();
      if (token) labels.add(token);
    }
  }
  return labels;
}

function stripKnownSpeakerLabels(text: string, speakers: ReadonlySet<string>): string {
  let body = text.trim();
  while (true) {
    const m = /^([^:\n]{1,80}):\s*/.exec(body);
    const label = m?.[1]?.trim().toLowerCase();
    if (!m || !label || !speakers.has(label)) return body;
    body = body.slice(m[0].length).trimStart();
  }
}

function firstLine(text: string): string {
  const idx = text.indexOf("\n");
  return idx === -1 ? text : `${text.slice(0, idx)} …`;
}

function shortTime(iso: string): string {
  const m = /T(\d{2}:\d{2})/.exec(iso);
  return m?.[1] ?? iso;
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
    case "max-tokens":
      return { label: "max tokens", tone: "caution" };
    case "verification-failed":
      return { label: "verification failed", tone: "error" };
    case "change-quality-failed":
      return { label: "change quality failed", tone: "error" };
    case "aborted":
      return { label: "aborted", tone: "neutral" };
    default:
      return { label: "unknown", tone: "neutral" };
  }
}

function pushIf(sections: Section[], section: Section | undefined): void {
  if (section) sections.push(section);
}

function detailWhenTruncated(
  text: string,
  cap: number,
): { detail: string } | Record<string, never> {
  const t = text.trim();
  return t.length > cap ? { detail: truncate(t, DETAIL_CAP) } : {};
}

function idleBoard(hasMembers: boolean): CanvasBoardView {
  return {
    view: "board",
    title: "Run loop",
    header: { status: { label: "idle", tone: "neutral" as CanvasTone }, chip: "coordinator" },
    sections: hasMembers ? [taskComposerSection()] : [],
  };
}

function truncate(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function runId(createdAt: string): string {
  return createdAt.replaceAll(/[:.]/g, "-");
}

function tailTruncate(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `…${t.slice(-(max - 1))}` : t;
}
