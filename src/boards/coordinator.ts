import type { CanvasBoardView, CanvasTone } from "@keelson/shared";
import type {
  CoordinatorEntry,
  CoordinatorLedger,
  InFlightTurn,
  VerificationRecord,
} from "../coordinator.ts";
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

// Identity hues draw only from non-status tones: a member must never hash into
// caution/ok/error and masquerade as a warning or a pass (status stays reserved
// for outcomes). Coordinator keeps brand.
const IDENTITY_TONES: readonly CanvasTone[] = ["accent", "info", "neutral", "brand"];

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
// strip them for row text. Deliberately conservative: only paired emphasis markers
// (** __), backticks, and heading hashes go — a single * or _ stays, so identifiers
// like foo_bar and glob args like --filter '*' survive. Detail bodies keep raw text.
export function stripMd(text: string): string {
  return text
    .replace(/```[a-zA-Z]*\n?/g, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
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

// One archived run rendered as its own drill-down board — the same sections the live
// Run-loop shows for that status, minus the task composer (a history drawer is for
// reading, not queuing work) and with every round of the ledger: this view IS the
// full record the live board's older-rounds stub points at. Absent ledger renders a
// calm not-found board.
export function buildRunDetailBoard(
  ledger: CoordinatorLedger | undefined,
  id: string,
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
  return {
    view: "board",
    title: "Run",
    header: { status: statusPill(ledger.status), chip: id },
    sections: sectionsFor(ledger, Number.POSITIVE_INFINITY),
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

function sectionsFor(ledger: CoordinatorLedger, ledgerRounds = LEDGER_ROUNDS_SHOWN): Section[] {
  switch (ledger.status) {
    case "active":
      return activeSections(ledger, ledgerRounds);
    case "done":
      return doneSections(ledger, ledgerRounds);
    case "max-rounds":
      return maxRoundsSections(ledger, ledgerRounds);
    case "verification-failed":
    case "change-quality-failed":
      return failedSections(ledger, ledgerRounds);
    case "gave-up":
      return gaveUpSections(ledger, ledgerRounds);
    default:
      return [
        {
          kind: "rows",
          items: [{ glyph: "warn", text: `Unrecognized run status: ${String(ledger.status)}` }],
        },
      ];
  }
}

function activeSections(ledger: CoordinatorLedger, ledgerRounds: number): Section[] {
  const sections: Section[] = [pulseSection(ledger)];
  pushIf(sections, roundRailSection(ledger));
  sections.push(goalSection(ledger.task));
  if (ledger.plan.length > 0) sections.push(planSection(ledger.plan));
  if (ledger.inFlight) sections.push(...nowSections(ledger.inFlight));
  if (ledger.facts.length > 0) sections.push(findingsSection(ledger.facts));
  if (ledger.verification) sections.push(verificationSection(ledger.verification));
  if (ledger.failedSteps?.length) sections.push(abandonedSection(ledger.failedSteps));
  if (ledger.teamGaps?.length) sections.push(teamGapsSection(ledger.teamGaps));
  pushIf(sections, gateHistorySection(ledger.transcript));
  pushIf(sections, mindsSection(ledger.transcript));
  sections.push(...ledgerSections(ledger.transcript, ledgerRounds));
  return sections;
}

function doneSections(ledger: CoordinatorLedger, ledgerRounds: number): Section[] {
  const sections: Section[] = [];
  if (ledger.summary?.trim()) sections.push(standupSection(ledger.summary));
  if (ledger.verification) sections.push(verificationSection(ledger.verification));
  pushIf(sections, gateHistorySection(ledger.transcript));
  pushIf(sections, mindsSection(ledger.transcript));
  if (ledger.facts.length > 0) sections.push(findingsSection(ledger.facts));
  sections.push(goalSection(ledger.task));
  sections.push(...ledgerSections(ledger.transcript, ledgerRounds));
  return sections;
}

function maxRoundsSections(ledger: CoordinatorLedger, ledgerRounds: number): Section[] {
  const tail = ledger.verification?.passed
    ? "The artifact is independently green; review and accept."
    : "Review where it stalled.";
  const sections: Section[] = [
    advisorySection("caution", `Needs you — the run hit its round budget. ${tail}`),
  ];
  if (ledger.verification) sections.push(verificationSection(ledger.verification));
  pushIf(sections, gateHistorySection(ledger.transcript));
  pushIf(sections, mindsSection(ledger.transcript));
  if (ledger.facts.length > 0) sections.push(findingsSection(ledger.facts));
  sections.push(...ledgerSections(ledger.transcript, ledgerRounds));
  return sections;
}

function failedSections(ledger: CoordinatorLedger, ledgerRounds: number): Section[] {
  const sections: Section[] = [];
  if (ledger.verification) sections.push(verificationSection(ledger.verification));
  sections.push(
    advisorySection(
      "error",
      "The done-gate came back red — the artifact does not pass; there is no accept path. Inspect the failures and re-dispatch.",
    ),
  );
  pushIf(sections, gateHistorySection(ledger.transcript));
  pushIf(sections, mindsSection(ledger.transcript));
  sections.push(...ledgerSections(ledger.transcript, ledgerRounds));
  return sections;
}

function gaveUpSections(ledger: CoordinatorLedger, ledgerRounds: number): Section[] {
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
  pushIf(sections, mindsSection(ledger.transcript));
  sections.push(...ledgerSections(ledger.transcript, ledgerRounds));
  return sections;
}

// The pulse `stats` strip: round (n or n/budget with escalating tone), the two loop
// counters, and — when entries carry usage — the run's token total. A zero count
// tones neutral so an early or calm run doesn't shout.
function pulseSection(ledger: CoordinatorLedger): Section {
  const toned = (n: number, tone: CanvasTone): CanvasTone => (n > 0 ? tone : "neutral");
  const tokens = ledger.transcript.reduce(
    (sum, e) => sum + (e.usage ? e.usage.inputTokens + e.usage.outputTokens : 0),
    0,
  );
  return {
    kind: "stats",
    items: [
      { label: "Round", value: roundStatValue(ledger), tone: roundStatTone(ledger) },
      { label: "Findings", value: ledger.facts.length, tone: toned(ledger.facts.length, "brand") },
      { label: "Stalls", value: ledger.stallCount, tone: toned(ledger.stallCount, "caution") },
      { label: "Re-plans", value: ledger.resetCount, tone: toned(ledger.resetCount, "caution") },
      ...(tokens > 0
        ? [{ label: "Tokens", value: formatTokens(tokens), tone: "info" as CanvasTone }]
        : []),
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
function roundRailSection(ledger: CoordinatorLedger): Section | undefined {
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
    cells.push({ label: `R${r}`, badge: roundBadge(entries) });
  }
  if (cells.length === 0) return undefined;
  return { kind: "grid", title: "Rounds", cells };
}

function roundBadge(entries: readonly CoordinatorEntry[]): { text: string; tone?: CanvasTone } {
  const gateRed = entries.some((e) => e.kind === "verify" && outcomeTone(e) === "error");
  if (gateRed) return { text: "gate ✕", tone: "error" };
  if (entries.some((e) => e.kind === "replan")) return { text: "re-plan", tone: "caution" };
  const code = entries.find((e) => e.kind === "code");
  if (code) return { text: code.speaker ? `${code.speaker} ⌥` : "code", tone: "accent" };
  const verified = entries.some((e) => e.kind === "verify" && outcomeTone(e) === "ok");
  if (verified) return { text: "verified ✓", tone: "ok" };
  const dispatch = entries.find((e) => e.kind === "dispatch" || e.kind === "workflow");
  if (dispatch) return { text: dispatch.speaker ?? "team", tone: "info" };
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
    items: facts.slice(-MAX_FINDINGS).map((fact) => ({
      glyph: "brand" as CanvasTone,
      text: stripMd(truncate(fact, STEP_CAP)) || "(no detail)",
      ...detailWhenTruncated(fact, STEP_CAP),
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

// "What's happening now": the one turn currently executing — its card, then (when the
// live relay has streamed any) the tail of its tool trace, so the operator watches the
// mind work instead of a frozen instruction. Active layout is the only caller.
function nowSections(inFlight: InFlightTurn): Section[] {
  const sections: Section[] = [
    {
      kind: "cards",
      title: "In flight",
      items: [
        {
          title: inFlight.speaker ?? "coordinator",
          dot: identityTone(inFlight.speaker),
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
function mindsSection(transcript: readonly CoordinatorEntry[]): Section | undefined {
  const bySpeaker = new Map<
    string,
    { turns: number; tokens: number; providers: Set<string>; last: CoordinatorEntry }
  >();
  for (const e of transcript) {
    if (e.kind !== "dispatch" && e.kind !== "code" && e.kind !== "workflow") continue;
    const speaker = e.speaker?.trim();
    if (!speaker) continue;
    const agg = bySpeaker.get(speaker) ?? {
      turns: 0,
      tokens: 0,
      providers: new Set<string>(),
      last: e,
    };
    agg.turns += 1;
    if (e.usage) agg.tokens += e.usage.inputTokens + e.usage.outputTokens;
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
      dot: identityTone(speaker),
      ...(agg.providers.size > 0 ? { pill: { label: [...agg.providers].join("+") } } : {}),
      fields: [
        { label: "turns", value: agg.turns },
        ...(agg.tokens > 0 ? [{ label: "tok", value: formatTokens(agg.tokens) }] : []),
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
      title: i === 0 ? `Ledger · R${r}${roundCaption(entries)}` : `R${r}${roundCaption(entries)}`,
      items: entries.map((e) => ledgerRow(e)),
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

function ledgerRow(e: CoordinatorEntry): RowItem {
  const speaker = e.speaker?.trim() || "coordinator";
  return {
    glyph: outcomeTone(e),
    chip: { label: speaker, tone: identityTone(e.speaker?.trim() || undefined) },
    text: stripMd(truncate(firstLine(e.text), LEDGER_ROW_CAP)) || "(no detail)",
    trailing: transcriptTrailing(e),
    ...entryDetail(e),
  };
}

// The expandable body behind a ledger row: the instruction the turn ran under, the
// full stored text, and the captured tool trace — everything the 200-char preview
// can't hold, straight from the durable entry.
function entryDetail(e: CoordinatorEntry): { detail: string } | Record<string, never> {
  const parts: string[] = [];
  if (e.instruction?.trim()) parts.push(`instruction: ${e.instruction.trim()}`);
  const body = e.text.trim();
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
  const preview = stripMd(truncate(firstLine(e.text), LEDGER_ROW_CAP));
  if (!detail || (stripMd(detail) === preview && !e.instruction && !e.tools?.length)) return {};
  return { detail: truncate(detail, DETAIL_CAP) };
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

function detailWhenTruncated(
  text: string,
  cap: number,
): { detail: string } | Record<string, never> {
  const t = text.trim();
  return t.length > cap ? { detail: truncate(t, DETAIL_CAP) } : {};
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
