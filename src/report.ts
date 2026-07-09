import { DESIGN_TOKENS, designTokenCssBlock } from "@keelson/shared";
import { stripMd } from "./boards/coordinator.ts";
import type { CoordinatorEntry, CoordinatorLedger } from "./coordinator.ts";
import { formatTokens } from "./format.ts";
import { identityTonesByMember, type Member } from "./types.ts";

// Pure: an archived coordinator run ledger -> a self-contained styled HTML page
// (the `html`-canvas run report). Deterministic — every value is read from the
// ledger, no agent turn. All component color rides the design-token custom
// properties (never raw hex) so the host's live data-theme stamp rethemes the
// whole page; the identity palette is declared on <body data-palette-*> for the
// host's categorical-palette validation contract.

export interface RunReportOptions {
  runId: string;
  members?: readonly Member[];
  generatedAt?: string;
}

const SUMMARY_CAP = 160;
// DESIGN_TOKENS identity hues in the rib's fixed cast order (identity slot 0..4).
const IDENTITY_ORDER = ["blue", "amber", "teal", "rose", "olive"] as const;

export function identityPalette(mode: "dark" | "light"): string[] {
  return IDENTITY_ORDER.map((k) => DESIGN_TOKENS[mode].identity[k]);
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function fmtTime(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]}` : iso;
}

function truncate(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function statusClass(status: string): string {
  switch (status) {
    case "done":
      return "good";
    case "active":
      return "info";
    case "gave-up":
    case "max-rounds":
    case "max-tokens":
      return "warn";
    case "verification-failed":
    case "change-quality-failed":
      return "crit";
    default:
      return "mute";
  }
}

function hueVarFor(tone: string | undefined): string {
  return tone?.startsWith("id-") ? `var(--${tone})` : "var(--muted)";
}

interface MemberRow {
  name: string;
  hueVar: string;
  turns: number;
  tokens: number;
  providers: string[];
}

// Per-member aggregation over the transcript's work entries (the same slice the
// Minds board reads), ordered by cast order (identity slot); speakers with no
// roster record trail in first-appearance order wearing the muted hue.
function memberRows(ledger: CoordinatorLedger, members: readonly Member[]): MemberRow[] {
  const tones = identityTonesByMember(members);
  const castIndex = new Map<string, number>();
  const displayName = new Map<string, string>();
  [...members]
    .sort((a, b) => (a.identitySlot ?? members.length) - (b.identitySlot ?? members.length))
    .forEach((m, idx) => {
      const label = m.name.trim() || m.slug;
      castIndex.set(m.slug.toLowerCase(), idx);
      displayName.set(m.slug.toLowerCase(), label);
      const name = m.name.trim().toLowerCase();
      if (name && !castIndex.has(name)) {
        castIndex.set(name, idx);
        displayName.set(name, label);
      }
    });
  const agg = new Map<string, MemberRow & { order: number }>();
  for (const e of ledger.transcript) {
    if (e.kind !== "dispatch" && e.kind !== "code" && e.kind !== "workflow") continue;
    const speaker = e.speaker?.trim();
    if (!speaker) continue;
    const key = speaker.toLowerCase();
    const row = agg.get(key) ?? {
      name: displayName.get(key) ?? speaker,
      hueVar: hueVarFor(tones.get(key)),
      turns: 0,
      tokens: 0,
      providers: [],
      order: castIndex.get(key) ?? members.length + agg.size,
    };
    row.turns += 1;
    if (e.usage) row.tokens += e.usage.inputTokens + e.usage.outputTokens;
    if (e.provider && !row.providers.includes(e.provider)) row.providers.push(e.provider);
    agg.set(key, row);
  }
  return [...agg.values()].sort((a, b) => a.order - b.order);
}

function totalTokens(ledger: CoordinatorLedger): number {
  return ledger.transcript.reduce(
    (sum, e) => sum + (e.usage ? e.usage.inputTokens + e.usage.outputTokens : 0),
    0,
  );
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

export function reportSummaryLine(ledger: CoordinatorLedger): string {
  const workers = memberRows(ledger, []).length;
  return [
    ledger.status,
    plural(ledger.round, "round"),
    `${formatTokens(totalTokens(ledger))} tok`,
    plural(workers, "member"),
    plural(ledger.facts.length, "finding"),
  ].join(" · ");
}

// The identity custom properties designTokenCssBlock() does not carry, dark on
// :root and light on the data-theme override — the same polarity as the base
// block. Hex appears only here and in the base block; components use var().
function identityCssBlock(): string {
  const declare = (mode: "dark" | "light"): string =>
    IDENTITY_ORDER.map((k) => `--id-${k}: ${DESIGN_TOKENS[mode].identity[k]};`).join(" ");
  return `:root {\n  ${declare("dark")}\n}\n:root[data-theme="light"] {\n  ${declare("light")}\n}`;
}

const REPORT_CSS = `
* { box-sizing: border-box; margin: 0; }
body {
  background: var(--bg);
  color: var(--fg);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif;
  font-size: 14px;
  line-height: 1.55;
  max-width: 880px;
  margin: 0 auto;
  padding: 32px 24px 40px;
}
.mono {
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-variant-numeric: tabular-nums;
}
.eyebrow {
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 11px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--accent);
}
h1 {
  color: var(--fg-strong);
  font-size: 26px;
  line-height: 1.25;
  text-wrap: balance;
  margin: 6px 0 10px;
}
h2 { color: var(--fg-strong); font-size: 15px; margin: 0 0 10px; }
section { margin-top: 28px; }
.meta { display: flex; flex-wrap: wrap; gap: 10px 14px; align-items: center; color: var(--muted); font-size: 13px; }
.status {
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  border: 1px solid var(--border);
  background: var(--card);
}
.status.good { color: var(--good); }
.status.info { color: var(--info); }
.status.warn { color: var(--warn); }
.status.crit { color: var(--crit); }
.status.mute { color: var(--muted); }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
.tile { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
.tile .value {
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-variant-numeric: tabular-nums;
  font-size: 28px;
  color: var(--fg-strong);
}
.tile .label { font-size: 12px; color: var(--muted); margin-top: 2px; }
.member {
  display: grid;
  grid-template-columns: minmax(140px, 220px) 1fr minmax(56px, auto);
  gap: 12px;
  align-items: center;
  padding: 9px 0;
  border-bottom: 1px solid var(--border);
}
.member:last-child { border-bottom: 0; }
.member .who { display: flex; align-items: center; gap: 8px; min-width: 0; }
.member .dot { width: 10px; height: 10px; border-radius: 50%; flex: none; background: var(--hue); }
.member .name { font-weight: 600; color: var(--hue); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.member .sub { font-size: 12px; color: var(--muted); white-space: nowrap; }
.bar { position: relative; height: 12px; background: var(--card-2); border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
.bar i { position: absolute; top: 0; bottom: 0; left: 0; display: block; background: var(--hue); }
.tok {
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  color: var(--muted);
  text-align: right;
  white-space: nowrap;
}
.scroll { overflow-x: auto; border: 1px solid var(--border); border-radius: 10px; background: var(--card); }
table { border-collapse: collapse; width: 100%; min-width: 560px; font-size: 13px; }
th {
  text-align: left;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--muted);
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}
td { padding: 7px 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
tr:last-child td { border-bottom: 0; }
td.num {
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-variant-numeric: tabular-nums;
  text-align: right;
  color: var(--muted);
  white-space: nowrap;
}
td.round {
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
  white-space: nowrap;
}
td .speaker { font-weight: 600; white-space: nowrap; color: var(--hue); }
ul.list { list-style: none; padding: 0; display: flex; flex-direction: column; gap: 8px; }
ul.list li {
  background: var(--card);
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 13px;
}
ul.list li .badge { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; margin-right: 8px; }
ul.list li .badge.good { color: var(--good); }
ul.list li .badge.warn { color: var(--warn); }
footer {
  margin-top: 36px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
  color: var(--muted);
  font-size: 12px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px 16px;
}
`;

function statTiles(ledger: CoordinatorLedger, workerCount: number): string {
  const tiles: [string, string][] = [
    ["rounds", String(ledger.round)],
    ["total tokens", formatTokens(totalTokens(ledger))],
    ["members", String(workerCount)],
    ["findings", String(ledger.facts.length)],
  ];
  return `<section class="tiles">${tiles
    .map(
      ([label, value]) =>
        `<div class="tile"><div class="value">${escapeHtml(value)}</div><div class="label">${escapeHtml(label)}</div></div>`,
    )
    .join("")}</section>`;
}

function membersSection(rows: readonly MemberRow[]): string {
  if (rows.length === 0) return "";
  const max = Math.max(1, ...rows.map((r) => r.tokens));
  const items = rows
    .map((r) => {
      const pct = Math.round((r.tokens / max) * 100);
      const sub = [plural(r.turns, "turn"), ...(r.providers.length ? [r.providers.join("+")] : [])]
        .join(" · ")
        .trim();
      return [
        `<div class="member" style="--hue: ${r.hueVar}">`,
        `<div class="who"><span class="dot"></span><span class="name">${escapeHtml(r.name)}</span><span class="sub">${escapeHtml(sub)}</span></div>`,
        `<div class="bar" role="img" aria-label="${escapeHtml(`${r.tokens} tokens`)}"><i style="width: ${pct}%"></i></div>`,
        `<div class="tok">${escapeHtml(`${formatTokens(r.tokens)} tok`)}</div>`,
        "</div>",
      ].join("");
    })
    .join("\n");
  return `<section><h2>Members</h2>\n${items}\n</section>`;
}

function entryActor(e: CoordinatorEntry): string {
  const speaker = e.speaker?.trim();
  if (speaker) return speaker;
  return e.kind === "coordinator" ? "coordinator" : e.kind;
}

function timelineSection(ledger: CoordinatorLedger, members: readonly Member[]): string {
  if (ledger.transcript.length === 0) return "";
  const tones = identityTonesByMember(members);
  const rows = ledger.transcript
    .map((e) => {
      const actor = entryActor(e);
      const hue = e.speaker?.trim()
        ? hueVarFor(tones.get(e.speaker.trim().toLowerCase()))
        : e.kind === "coordinator"
          ? "var(--accent)"
          : "var(--muted)";
      const tokens = e.usage ? `${formatTokens(e.usage.inputTokens + e.usage.outputTokens)}` : "—";
      const summary = escapeHtml(truncate(stripMd(e.text), SUMMARY_CAP)) || "(no detail)";
      return [
        "<tr>",
        `<td class="round">r${e.round}</td>`,
        `<td><span class="speaker" style="--hue: ${hue}">${escapeHtml(actor)}</span></td>`,
        `<td>${summary}</td>`,
        `<td class="num">${escapeHtml(tokens)}</td>`,
        "</tr>",
      ].join("");
    })
    .join("\n");
  return [
    "<section><h2>Round timeline</h2>",
    '<div class="scroll"><table>',
    "<thead><tr><th>Round</th><th>Speaker</th><th>Summary</th><th>Tokens</th></tr></thead>",
    `<tbody>\n${rows}\n</tbody>`,
    "</table></div></section>",
  ].join("\n");
}

function findingsSection(ledger: CoordinatorLedger): string {
  if (ledger.facts.length === 0) return "";
  const items = ledger.facts
    .map((f) => `<li>${escapeHtml(stripMd(f)) || "(empty)"}</li>`)
    .join("\n");
  return `<section><h2>Findings</h2><ul class="list">\n${items}\n</ul></section>`;
}

function decisionsSection(ledger: CoordinatorLedger): string {
  const dispositions = ledger.dispositions ?? [];
  if (dispositions.length === 0) return "";
  const items = dispositions
    .map(
      (d) =>
        `<li><span class="badge ${d.disposition === "fixed" ? "good" : "warn"}">${escapeHtml(d.disposition)}</span>${escapeHtml(d.threadRef)} — ${escapeHtml(d.note)}</li>`,
    )
    .join("\n");
  return `<section><h2>Decisions</h2><ul class="list">\n${items}\n</ul></section>`;
}

export function buildRunReportHtml(run: CoordinatorLedger, opts: RunReportOptions): string {
  const members = opts.members ?? [];
  const rows = memberRows(run, members);
  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  const title = escapeHtml(stripMd(run.task)) || "(no task)";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Squad run report — ${escapeHtml(opts.runId)}</title>
<style>
${designTokenCssBlock()}
${identityCssBlock()}
${REPORT_CSS}</style>
</head>
<body data-palette-dark="${identityPalette("dark").join(",")}" data-palette-light="${identityPalette("light").join(",")}">
<header>
<p class="eyebrow">SQUAD RUN REPORT</p>
<h1>${title}</h1>
<p class="meta"><span class="status ${statusClass(run.status)}">${escapeHtml(run.status)}</span><span class="mono">${escapeHtml(fmtTime(run.createdAt))} → ${escapeHtml(fmtTime(run.updatedAt))}</span></p>
</header>
${statTiles(run, rows.length)}
${membersSection(rows)}
${timelineSection(run, members)}
${findingsSection(run)}
${decisionsSection(run)}
<footer><span class="mono">run ${escapeHtml(opts.runId)}</span><span class="mono">generated ${escapeHtml(generatedAt)}</span><span>composed deterministically from the run ledger</span></footer>
</body>
</html>
`;
}
