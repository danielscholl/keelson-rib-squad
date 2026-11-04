import type { CanvasBoardView, CanvasTone } from "@keelson/shared";
import {
  type CoordinatorEntry,
  type CoordinatorLedger,
  type InFlightTurn,
  SHORT_ACKNOWLEDGMENT_RE,
  type VerificationRecord,
} from "../coordinator.ts";
import { formatTokens } from "../format.ts";
import type { ToolTrace } from "../turn-runner.ts";

// Pure: a coordinator run ledger -> a canvas `board` (the Run-loop panel). No ledger — no run
// yet, or a torn/unreadable file — renders a calm idle board. Validated against canvasViewSchema
// in tests; the collector never parses (validation lives at the binding edge via expectView).

type Section = CanvasBoardView["sections"][number];
type RowItem = Extract<Section, { kind: "rows" }>["items"][number];
type Person = NonNullable<RowItem["person"]>;

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
const RUN_TITLE_CAP = 90;
const STEP_CAP = 200;
const LEDGER_ROW_CAP = 200;
const DETAIL_CAP = 4000;
const VERIFY_SUMMARY_CAP = 120;
const GATE_CAUSE_CAP = 90;
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

// The round is the ledger group's own title, and the provider rides the Minds lane, so a
// row's trailing carries only what is particular to that one turn.
export function transcriptTrailing(e: CoordinatorEntry): string | undefined {
  const parts: string[] = [];
  if (e.usage) parts.push(`${formatTokens(e.usage.inputTokens + e.usage.outputTokens)} tok`);
  if (e.touched && (e.touched.insertions || e.touched.deletions)) {
    const { insertions, deletions } = e.touched;
    parts.push(
      [insertions ? `+${insertions}` : "", deletions ? `−${deletions}` : ""]
        .filter(Boolean)
        .join(" "),
    );
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

// Who acted, as a face in the member's identity tone. The coordinator wears the brand
// diamond and the done-gate wears its verdict, so every ledger line leads with an actor.
export function personFor(speaker: string | undefined, tones?: IdentityTones): Person {
  const name = speaker?.trim() || "coordinator";
  if (name === "coordinator") return { name, tone: "brand", face: "◆" };
  const initial = /\p{L}|\p{N}/u.exec(name)?.[0]?.toUpperCase() ?? "·";
  return { name, tone: identityTone(name, tones), face: initial };
}

// A gate entry's stored text leads with its verdict and trails the full command and
// output; one-line views show only the verdict (and exit code), the rest is disclosed.
export function gateHeadline(e: CoordinatorEntry): string {
  const [first = "", ...rest] = e.text.split("\n");
  const line = first.trim();
  const colon = line.indexOf(": ");
  const head = (colon > 0 ? line.slice(0, colon) : line).replace(/\bFAILED\b/, "failed");
  const failed = /^verification FAILED: (.+?) \(exit (\d+)\)$/.exec(line);
  if (!failed || outcomeTone(e) !== "error") return head;
  const cause = rest.find((l) => l.trim())?.trim();
  const what = `${failed[1]} failed · exit ${failed[2]}`;
  return cause ? `${what} · ${truncate(cause, GATE_CAUSE_CAP)}` : what;
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
  const base = sectionsFor(ledger, undefined, tones, scopeId);
  // A settled board reads its result first, then offers the next task and the teardown
  // verb; an ACTIVE run omits both (you Stop a live run before resetting the scope).
  const sections =
    ledger.status === "active" ? base : [...base, taskComposerSection(), resetSection()];
  return {
    view: "board",
    title: "Run loop",
    header: {
      status: statusPill(ledger.status),
      ...(ledger.status === "active" ? { chip: `round ${ledger.round}` } : {}),
    },
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
  // The drawer's title already is the task, so its Goal row would only repeat it — unless
  // the title had to cut the task short.
  const titled = ledger.task.trim().length <= RUN_TITLE_CAP;
  const body = sectionsFor(ledger, Number.POSITIVE_INFINITY, tones, scopeId).filter(
    (s) => !(titled && s.kind === "rows" && s.title === "Goal"),
  );
  const detailBody: Section[] = body.filter((s) => s.kind !== "stats");
  const tokens = tokensPerRoundSection(ledger.transcript, tones);
  const ledgerAt = detailBody.findIndex((s) => s.kind === "rows" && s.title?.startsWith("Ledger"));
  if (tokens) detailBody.splice(ledgerAt < 0 ? detailBody.length : ledgerAt, 0, tokens);
  const sections: Section[] = [pulseSection(ledger), runReportSection(id), ...detailBody];
  return {
    view: "board",
    title: stripMd(truncate(ledger.task, RUN_TITLE_CAP)) || "Run",
    header: {
      status: statusPill(ledger.status),
      chip: runSpan(ledger.createdAt, ledger.updatedAt) ?? id,
    },
    sections,
  };
}

// The one verb the history drawer carries: compose the deterministic styled run
// report for this archived ledger and open it. Read-only against the archive.
function runReportSection(id: string): Section {
  return {
    kind: "actions",
    wrap: true,
    items: [
      {
        type: REPORT_RUN_ACTION,
        label: "Open report",
        glyph: "▤",
        hint: "The styled run report for this ledger",
        payload: { runId: id },
      },
    ],
  };
}

// The "give the squad a task" composer that heads the Run-loop board, so assigning
// work sits where its progress streams. Coordinate runs the full loop (watched in
// this panel); Ask the team fans one question out to the roster and synthesizes.
export function taskComposerSection(): Section {
  return {
    kind: "actions",
    title: "Give the squad a task",
    tabs: true,
    items: [
      {
        type: COORDINATE_ACTION,
        label: "Coordinate a task",
        glyph: "↻",
        hint: "Plan, delegate one step at a time, and verify until the goal is met",
        submitLabel: "Start run",
        submitTone: "brand",
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
        hint: "Put one question to every member and get a synthesis",
        submitLabel: "Ask",
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
    goalSection(ledger.task),
    pulseSection(ledger),
    liveControlsSection(ledger, scopeId),
  ];
  const findings = visibleFindings(ledger);
  pushIf(sections, roundRailSection(ledger, tones));
  if (ledger.inFlight) sections.push(...nowSections(ledger.inFlight, tones));
  if (ledger.plan.length > 0) sections.push(planSection(ledger.plan));
  if (findings.length > 0) sections.push(findingsSection(findings));
  if (ledger.failedSteps?.length) sections.push(abandonedSection(ledger.failedSteps));
  if (ledger.teamGaps?.length) sections.push(teamGapsSection(ledger.teamGaps));
  if (ledger.verification) sections.push(verificationSection(ledger.verification));
  pushIf(sections, gateHistorySection(ledgerEntries(ledger), ledger.verification, ledgerRounds));
  pushIf(sections, mindsSection(ledger.transcript, tones));
  sections.push(...ledgerSections(ledgerEntries(ledger), ledgerRounds, tones, true));
  return sections;
}

// The live run's two verbs on one strip: Steer opens its instruction form below the
// strip, Stop sits at the trailing edge. The caller's scopeId is authoritative (the
// collector knows which scope it rendered); ledger.scopeId only covers ledgers persisted
// before scopeId existed.
function liveControlsSection(ledger: CoordinatorLedger, scopeId?: string): Section {
  const scope = scopeId ?? ledger.scopeId ?? "default";
  return {
    kind: "actions",
    wrap: true,
    items: [
      {
        type: STEER_COORDINATOR_ACTION,
        label: "Steer the run",
        glyph: "➤",
        hint: "Add a fact or course-correction the next round folds in",
        payload: { scopeId: scope },
        fields: [
          {
            name: "instruction",
            label: "Instruction",
            placeholder:
              'A fact or course-correction the next round folds in, e.g. "prefer the existing retry helper — don\'t add a new one"',
            multiline: true,
          },
        ],
        submitLabel: "Steer",
      },
      {
        type: STOP_COORDINATOR_ACTION,
        label: "Stop run",
        glyph: "■",
        tone: "warn",
        destructive: true,
        inline: true,
        align: "end",
        payload: { scopeId: scope },
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
    wrap: true,
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
    wrap: true,
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
  const sections: Section[] = [goalSection(ledger.task), pulseSection(ledger)];
  const findings = visibleFindings(ledger);
  if (ledger.summary?.trim()) sections.push(standupSection(ledger.summary));
  if (findings.length > 0) sections.push(findingsSection(findings));
  if (ledger.verification) sections.push(verificationSection(ledger.verification));
  pushIf(sections, gateHistorySection(ledgerEntries(ledger), ledger.verification, ledgerRounds));
  pushIf(sections, mindsSection(ledger.transcript, tones));
  sections.push(...ledgerSections(ledgerEntries(ledger), ledgerRounds, tones));
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
  if (findings.length > 0) sections.push(findingsSection(findings));
  if (ledger.verification) sections.push(verificationSection(ledger.verification));
  pushIf(sections, gateHistorySection(ledgerEntries(ledger), ledger.verification, ledgerRounds));
  pushIf(sections, mindsSection(ledger.transcript, tones));
  sections.push(...ledgerSections(ledgerEntries(ledger), ledgerRounds, tones));
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
  if (findings.length > 0) sections.push(findingsSection(findings));
  if (ledger.verification) sections.push(verificationSection(ledger.verification));
  pushIf(sections, gateHistorySection(ledgerEntries(ledger), ledger.verification, ledgerRounds));
  pushIf(sections, mindsSection(ledger.transcript, tones));
  sections.push(...ledgerSections(ledgerEntries(ledger), ledgerRounds, tones));
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
  pushIf(sections, gateHistorySection(ledgerEntries(ledger), ledger.verification, ledgerRounds));
  pushIf(sections, mindsSection(ledger.transcript, tones));
  sections.push(...ledgerSections(ledgerEntries(ledger), ledgerRounds, tones));
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
  sections.push(...ledgerSections(ledgerEntries(ledger), ledgerRounds, tones));
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
  sections.push(...ledgerSections(ledgerEntries(ledger), ledgerRounds, tones));
  return sections;
}

// The pulse `stats` strip: round (n or n/budget with escalating tone), the two loop
// counters, and — when entries carry usage — the run's token total. A zero count
// tones neutral so an early or calm run doesn't shout.
// A settled run reports what happened, not how close it came to a budget or the
// stall and re-plan counters that stayed at zero.
function pulseSection(ledger: CoordinatorLedger): Section {
  const toned = (n: number, tone: CanvasTone): CanvasTone => (n > 0 ? tone : "neutral");
  const settled = ledger.status !== "active";
  const findingsCount = visibleFindings(ledger).length;
  const tokens = ledger.transcript.reduce(
    (sum, e) => sum + (e.usage ? e.usage.inputTokens + e.usage.outputTokens : 0),
    0,
  );
  return {
    kind: "stats",
    items: [
      settled
        ? {
            label: ledger.round === 1 ? "Round" : "Rounds",
            value: ledger.round,
            tone: "neutral" as CanvasTone,
          }
        : { label: "Round", value: roundStatValue(ledger), tone: roundStatTone(ledger) },
      {
        label: findingsCount === 1 ? "Finding" : "Findings",
        value: findingsCount,
        tone: "neutral" as CanvasTone,
      },
      ...(ledger.stallCount === 0
        ? []
        : [
            {
              label: ledger.stallCount === 1 ? "Stall" : "Stalls",
              value: ledger.stallCount,
              tone: toned(ledger.stallCount, "caution"),
            },
          ]),
      ...(settled && ledger.resetCount === 0
        ? []
        : [
            {
              label: ledger.resetCount === 1 ? "Re-plan" : "Re-plans",
              value: ledger.resetCount,
              tone: "neutral" as CanvasTone,
            },
          ]),
      ...(tokens > 0
        ? [{ label: "Tokens", value: formatTokens(tokens), tone: "neutral" as CanvasTone }]
        : []),
    ],
  };
}

function tokensPerRoundSection(
  transcript: readonly CoordinatorEntry[],
  tones?: IdentityTones,
): Section | undefined {
  const byRound = new Map<number, { total: number; hasUsage: boolean }>();
  for (const e of transcript) {
    const agg = byRound.get(e.round) ?? { total: 0, hasUsage: false };
    if (e.usage) {
      agg.total += e.usage.inputTokens + e.usage.outputTokens;
      agg.hasUsage = true;
    }
    byRound.set(e.round, agg);
  }
  if ([...byRound.values()].filter((round) => round.hasUsage).length < 2) return undefined;
  const badges = roundBadges(transcript, tones);
  const rounds = [...byRound.entries()].sort(([a], [b]) => a - b);
  const peak = Math.max(...rounds.map(([, agg]) => agg.total));
  return {
    kind: "bars",
    title: "Tokens per round",
    items: rounds.map(([round, agg]) => {
      const badge = badges.get(round);
      const memberTone = badge?.tone?.startsWith("id-") ? badge.tone : "brand";
      return {
        label: badge ? `R${round} · ${badge.text}` : `R${round}`,
        value: agg.total,
        total: peak,
        tone: memberTone as CanvasTone,
        trailing: agg.hasUsage ? `${formatTokens(agg.total)} tok` : "no usage",
      };
    }),
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
  const badges = roundBadges(ledger.transcript, tones);
  const last = Math.max(ledger.round, ...badges.keys());
  const first = Math.max(0, last - MAX_RAIL_ROUNDS + 1);
  const cells: { label: string; badge: RoundBadge }[] = [];
  for (let r = first; r <= last; r++) {
    if (ledger.inFlight && ledger.inFlight.round === r && ledger.status === "active") {
      cells.push({ label: `R${r}`, badge: { text: inFlightBadge(ledger.inFlight), tone: "info" } });
      continue;
    }
    const badge = badges.get(r);
    if (badge) cells.push({ label: `R${r}`, badge });
  }
  if (cells.length === 0) return undefined;
  return { kind: "grid", title: "Rounds", cells };
}

function inFlightBadge(turn: InFlightTurn): string {
  const event =
    turn.action === "coding"
      ? "code"
      : turn.action === "authoring a workflow"
        ? "workflow"
        : turn.action === "planning"
          ? "plan"
          : "team";
  const who = turn.speaker?.trim();
  return `▶ ${event}${who ? ` · ${who}` : ""}`;
}

type RoundBadge = { text: string; tone?: CanvasTone };

// Each round's rail label, in round order. A gate-only round names the member whose
// work it checked, so the badge needs the rounds before it.
function roundBadges(
  transcript: readonly CoordinatorEntry[],
  tones?: IdentityTones,
): Map<number, RoundBadge> {
  const byRound = new Map<number, CoordinatorEntry[]>();
  for (const e of transcript) {
    const list = byRound.get(e.round) ?? [];
    list.push(e);
    byRound.set(e.round, list);
  }
  const badges = new Map<number, RoundBadge>();
  let lastWorker: string | undefined;
  for (const r of [...byRound.keys()].sort((a, b) => a - b)) {
    const entries = byRound.get(r) ?? [];
    const badge = roundBadge(entries, lastWorker, tones);
    badges.set(r, badge);
    lastWorker = workOf(entries)?.speaker?.trim() || lastWorker;
  }
  return badges;
}

function workOf(entries: readonly CoordinatorEntry[]): CoordinatorEntry | undefined {
  return (
    entries.find((e) => e.kind === "code") ??
    entries.find((e) => e.kind === "dispatch" || e.kind === "workflow")
  );
}

function roundBadge(
  entries: readonly CoordinatorEntry[],
  lastWorker: string | undefined,
  tones?: IdentityTones,
): RoundBadge {
  const gates = entries.filter((e) => e.kind === "verify").map(outcomeTone);
  const gateRed = gates.includes("error");
  const mark = gateRed ? " ✕" : gates.includes("ok") ? " ✓" : "";
  const work = workOf(entries);
  const replan = entries.some((e) => e.kind === "replan");
  const who = work ? work.speaker?.trim() : gates.length > 0 ? lastWorker : "coordinator";
  const event = replan
    ? "re-plan"
    : work
      ? work.kind === "code"
        ? "code"
        : work.kind === "workflow"
          ? "workflow"
          : "team"
      : gates.length > 0
        ? "gate"
        : "plan";
  const text = `${event}${who ? ` · ${who}` : ""}${mark}`;
  // Red stays reserved for a failed gate; a member's round otherwise wears their hue.
  if (gateRed) return { text, tone: "error" };
  if (work) return { text, tone: who ? identityTone(who, tones) : "info" };
  if (gates.length > 0) return { text, tone: "ok" };
  return { text, tone: replan ? "caution" : "neutral" };
}

function goalSection(task: string): Section {
  return {
    kind: "rows",
    title: "Goal",
    items: [
      {
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
        glyph: "ok",
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
      icon: `${i + 1}`,
      text: truncate(step, STEP_CAP) || "(no detail)",
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
  const startedAt = clockAt(inFlight.startedAt);
  const sections: Section[] = [
    {
      kind: "cards",
      title: "In flight",
      items: [
        {
          title: inFlight.speaker ?? "coordinator",
          dot: identityTone(inFlight.speaker, tones),
          edge: identityTone(inFlight.speaker, tones),
          pill: { label: inFlight.action, tone: "info" },
          fields: [
            ...(startedAt
              ? [{ label: "started", clock: { at: startedAt, mode: "since" as const } }]
              : []),
            ...(inFlight.tools?.length
              ? [
                  {
                    label: inFlight.tools.length === 1 ? "tool call" : "tool calls",
                    value: inFlight.tools.length,
                  },
                ]
              : []),
          ],
          ...(inFlight.instruction
            ? { reason: { text: truncate(inFlight.instruction, STEP_CAP) } }
            : {}),
        },
      ],
    },
  ];
  if (inFlight.tools?.length) {
    sections.push({
      kind: "rows",
      items: inFlight.tools.slice(-NOW_TRACE_SHOWN).map((t, i, shown) => {
        const running = i === shown.length - 1 && t.ok === undefined;
        return {
          glyph: toolGlyph(t, i === shown.length - 1),
          text: t.target ? `${t.name} ${t.target}` : t.name,
          ...(running ? { trailing: "running" } : t.ok === false ? { trailing: "failed" } : {}),
        };
      }),
    });
  }
  return sections;
}

// A clock needs a real offset timestamp; a hand-edited or legacy value degrades to no clock.
function clockAt(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

function toolGlyph(t: ToolTrace, isLast: boolean): CanvasTone {
  if (t.ok === false) return "error";
  if (t.ok === true) return "ok";
  return isLast ? "info" : "neutral";
}

// Verification and change-quality verdicts across the whole run, one line per event —
// the gate's history stays legible even after its entries scroll out of the ledger
// window's full groups.
// Gates the board doesn't already show: not the one Verification reports, and not one
// in a Ledger round still on screen. It keeps a folded-away red gate from vanishing.
function gateHistorySection(
  transcript: readonly CoordinatorEntry[],
  verification: VerificationRecord | undefined,
  ledgerRounds: number,
): Section | undefined {
  const rounds = [...new Set(transcript.map((e) => e.round))].sort((a, b) => b - a);
  const visible = new Set(rounds.slice(0, ledgerRounds));
  const gates = transcript.filter(
    (e) => e.kind === "verify" && !visible.has(e.round) && e.round !== verification?.atRound,
  );
  if (gates.length === 0) return undefined;
  return {
    kind: "rows",
    title: "Gate history",
    items: gates.map((e) => {
      const tone = outcomeTone(e);
      return {
        glyph: tone,
        text: stripMd(truncate(gateHeadline(e), STEP_CAP)),
        trailing: `round ${e.round}`,
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
      rounds: Set<number>;
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
      rounds: new Set<number>(),
      last: e,
    };
    agg.turns += 1;
    agg.rounds.add(e.round);
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
    kind: "rows",
    title: "Minds",
    items: [...bySpeaker.entries()].map(([speaker, agg]) => {
      const rounds = [...agg.rounds].sort((a, b) => a - b);
      const meta = [
        ...[...agg.providers],
        ...(agg.tokens > 0
          ? [`${formatTokens(agg.inputTokens)} in · ${formatTokens(agg.outputTokens)} out`]
          : []),
      ];
      return {
        person: personFor(speaker, tones),
        text: `${agg.turns} ${agg.turns === 1 ? "turn" : "turns"} · ${rounds.length === 1 ? "round" : "rounds"} ${rounds.join(", ")}`,
        ...(meta.length > 0 ? { trailing: meta.join(" · ") } : {}),
      };
    }),
  };
}

function verificationSection(v: VerificationRecord): Section {
  const checks: readonly { command: string; passed: boolean; exitCode: number; summary: string }[] =
    v.checks && v.checks.length > 0 ? v.checks : [v];
  return {
    kind: "rows",
    title: Number.isFinite(v.atRound) ? `Verification · round ${v.atRound}` : "Verification",
    items: checks.map((check) => ({
      glyph: check.passed ? ("ok" as CanvasTone) : ("error" as CanvasTone),
      text: truncate(check.command, STEP_CAP) || "verification",
      trailing: check.passed
        ? "passed"
        : `exit ${check.exitCode} · ${tailTruncate(check.summary, VERIFY_SUMMARY_CAP)}`,
      ...(check.passed || !check.summary.trim()
        ? {}
        : { detail: truncate(check.summary, DETAIL_CAP) }),
    })),
  };
}

// The Ledger: the transcript grouped by round, newest first. The most recent rounds
// render every entry (expandable to the full stored text + instruction + tool trace);
// older rounds compress to a one-line stub instead of silently vanishing — the current
// board's worst honesty gap (r11 hid 17 of its 29 entries). The run-detail board
// passes Infinity so the archive drill-down really is the full record.
// The Verification section already reports its round's gate, so the Ledger leaves it out.
function ledgerEntries(ledger: CoordinatorLedger): readonly CoordinatorEntry[] {
  const at = ledger.verification?.atRound;
  if (at === undefined) return ledger.transcript;
  return ledger.transcript.filter((e) => !(e.kind === "verify" && e.round === at));
}

function ledgerSections(
  transcript: readonly CoordinatorEntry[],
  roundsShown = LEDGER_ROUNDS_SHOWN,
  tones?: IdentityTones,
  live = false,
): Section[] {
  if (transcript.length === 0) return [];
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
      title: i === 0 ? `Ledger · round ${r}` : `Round ${r}`,
      items: entries.map((e) => ledgerRow(e, tones)),
    };
  });

  if (older.length > 0) {
    const olderEntries = older.reduce((n, r) => n + (byRound.get(r)?.length ?? 0), 0);
    const span =
      older.length === 1
        ? `Round ${older[older.length - 1]}`
        : `Rounds ${older[older.length - 1]}–${older[0]}`;
    sections.push({
      kind: "rows",
      items: [
        {
          glyph: "neutral" as CanvasTone,
          text: `${span} · ${olderEntries} earlier ${olderEntries === 1 ? "entry" : "entries"}`,
          ...(live ? {} : { trailing: "full run in Runs" }),
          detail: truncate(
            older
              .flatMap((r) => (byRound.get(r) ?? []).map((e) => `R${r} · ${olderHeadline(e)}`))
              .join("\n"),
            DETAIL_CAP,
          ),
        },
      ],
    });
  }
  return sections;
}

function olderHeadline(e: CoordinatorEntry): string {
  if (e.kind === "verify") return gateHeadline(e);
  const who = e.speaker?.trim() || "coordinator";
  return `${who}: ${stripMd(truncate(firstLine(normalizeSpeakerPrefixes(e.text)), LEDGER_ROW_CAP))}`;
}

function ledgerRow(e: CoordinatorEntry, tones?: IdentityTones): RowItem {
  const text = normalizeSpeakerPrefixes(e.text);
  const trailing = transcriptTrailing(e);
  const gate = e.kind === "verify";
  const line = gate ? gateHeadline(e) : firstLine(text);
  return {
    ...(gate ? { glyph: outcomeTone(e) } : { person: personFor(e.speaker, tones) }),
    text: stripMd(truncate(line, LEDGER_ROW_CAP)) || "(no detail)",
    ...(trailing ? { trailing } : {}),
    ...entryDetail(e),
  };
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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "Nov 3, 14:10" from an ISO timestamp, read off the string itself (no timezone
// conversion) so the board matches the ledger it was rendered from.
function runSpan(from: string, to: string): string | undefined {
  const ms = Date.parse(to) - Date.parse(from);
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  const min = Math.round(ms / 60_000);
  if (min < 1) return "under a minute";
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

export function runWhen(iso: string): string | undefined {
  const m = /^\d{4}-(\d{2})-(\d{2})T(\d{2}:\d{2})/.exec(iso);
  const month = m ? MONTHS[Number(m[1]) - 1] : undefined;
  return m && month ? `${month} ${Number(m[2])}, ${m[3]}` : undefined;
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
