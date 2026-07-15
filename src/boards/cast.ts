import type { CanvasBoardView, CanvasTone } from "@keelson/shared";
import { type CastProposalRecord, MAX_CAST_MEMBERS, type ScanReceipt } from "../cast.ts";
import { themeLabel } from "../casting/themes.ts";
import { identityToneForSlot } from "../types.ts";
import { charterDisplay } from "./coordinator.ts";

// The verbs the Proposed-squad board offers. Shared with onAction so the action
// types can't drift from their handlers. cast-propose lives on the roster
// cold-start (it carries the project/mission form); the rest act on the
// already-persisted proposal and carry its createdAt so a click aimed at a
// replaced cast is rejected rather than applied to different members.
export const CAST_PROPOSE_ACTION = "cast-propose";
export const CAST_PICK_ACTION = "cast-pick";
export const CAST_MODEL_ACTION = "cast-model";
export const VIEW_CHARTER_ACTION = "view-charter";
export const APPROVE_CAST_ACTION = "approve-cast";
export const DISCARD_CAST_ACTION = "discard-cast";

type Section = CanvasBoardView["sections"][number];
type Member = CastProposalRecord["members"][number];

// Pure: a pending cast proposal -> a canvas `board`. No proposal renders a calm idle
// board (cast a squad from the roster); a proposal renders the bench it is about to
// become — one card per proposed member, the card body itself the pick toggle — plus
// the Approve/Discard verbs. Validated against canvasViewSchema in tests; the
// collector never parses (validation lives at the binding edge via expectView).
export function buildCastBoard(proposal: CastProposalRecord | undefined): CanvasBoardView {
  if (!proposal) return idleBoard();

  const picked = proposal.members.filter(isPicked);
  // An all-dropped bench still has an ensemble; judge it on the seats that exist.
  const ensemble = ensembleFor(picked.length > 0 ? picked : proposal.members, proposal.projectName);
  return {
    view: "board",
    title: "Proposed squad",
    header: {
      status: {
        label: `${picked.length} of ${proposal.members.length} picked`,
        tone: (picked.length === 0 ? "warn" : "brand") as CanvasTone,
      },
      chip: proposal.projectName,
    },
    sections: [
      briefSection(proposal, picked.length, ensemble.title),
      provenanceSection(proposal),
      benchSection(proposal, !ensemble.hoisted),
      decideSection(proposal, picked.length),
    ],
  };
}

// The ensemble is the briefing card's subject only when every picked seat wears it:
// themeSelectionOrder reuses the active ensemble WHILE IT HAS CAPACITY then rolls to
// the next, and assignThemedIdentity leaves a seat uncast when they all run dry — so a
// cast can span two ensembles, or name none. Keyed on castLabel, not themeId, so the
// guard decides on exactly the string the title and the card field would render.
function ensembleFor(members: Member[], projectName: string): { title: string; hoisted: boolean } {
  const labels = new Set(members.map(castLabel));
  const only = labels.size === 1 ? [...labels][0] : undefined;
  if (only) return { title: `${only} ensemble`, hoisted: true };
  const named = [...labels].filter((l): l is string => Boolean(l));
  if (named.length >= 2) return { title: `${named.length} ensembles`, hoisted: false };
  // readProposal admits an empty projectName, and card titles are min(1).
  return { title: projectName.trim() || "Proposed squad", hoisted: false };
}

// The scan's claim, as a card: the same anatomy as the seats it proposes, so the board
// reads as one grammar — the squad's card, then its members'. The ask rides as the
// footnote; its ABSENCE is the signal worth toning, so that gets a provenance row.
function briefSection(proposal: CastProposalRecord, pickedCount: number, title: string): Section {
  const mission = proposal.mission?.trim();
  const thesis = proposal.summary?.trim();
  return {
    kind: "cards",
    items: [
      {
        title,
        pill: { label: `${pickedCount} of ${MAX_CAST_MEMBERS} seats` },
        ...(mission ? { footnote: `your ask: ${mission}` } : {}),
        ...(thesis ? { reason: { text: thesis } } : {}),
      },
    ],
  };
}

// The counterweight to the cards' claims. Those are what the model WROTE; this is what
// the harness itself counted off the turn's tool_use chunks, the one thing here a
// confabulation can't produce — so it wears bare lines, not a card. A card is an
// assertion; a line is a fact.
function provenanceSection(proposal: CastProposalRecord): Section {
  const items: { glyph?: CanvasTone; text: string; trailing?: string; detail?: string }[] = [];
  if (!proposal.mission?.trim()) {
    items.push({
      glyph: "warn" as CanvasTone,
      text: "cast from the repo alone — you gave no brief",
    });
  }
  for (const text of proposal.notes) items.push({ glyph: "warn" as CanvasTone, text });
  items.push(receiptRow(proposal.read));
  return { kind: "rows", items };
}

// A scan that opened almost nothing can still produce a confident-sounding team; the
// count is what separates the two, so a thin read is toned rather than just printed.
const THIN_SCAN_FILES = 10;

function receiptRow(read: ScanReceipt | undefined) {
  if (!read) {
    return {
      glyph: "neutral" as CanvasTone,
      text: "This provider didn't report what the scan opened, so there's no receipt to show. Judge the seats on their charters.",
    };
  }
  const thin = read.files.length < THIN_SCAN_FILES;
  const files = `${read.files.length} file${read.files.length === 1 ? "" : "s"} read`;
  const searches = `${read.searches} search${read.searches === 1 ? "" : "es"} (glob / grep)`;
  const detail = fileListDetail(read.files);
  return {
    glyph: (thin ? "warn" : "ok") as CanvasTone,
    // A yellow dot alone doesn't say a 3-file cast is a 3-file cast, and rows carry no hint.
    text: `${thin ? "Thin scan — " : ""}${files} · ${searches}`,
    trailing: durationLabel(read.ms),
    // detail is min(1): an empty capture would fail the board rather than degrade.
    ...(detail ? { detail } : {}),
  };
}

// rows.detail is capped at 4000 by the contract, and a thorough scan of a large repo
// would breach it — taking the WHOLE board down through expectView rather than
// degrading. The healthy case must not be the dangerous one, so the list is capped and
// says what it dropped.
const FILE_LIST_CAP = 60;

function fileListDetail(files: readonly string[]): string {
  const shown = files.slice(0, FILE_LIST_CAP);
  const rest = files.length - shown.length;
  return rest > 0 ? `${shown.join("\n")}\n…and ${rest} more` : shown.join("\n");
}

function durationLabel(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

// Absent means picked: a proposal written before subset approve, or by a scan that
// never sets the flag, is a full bench.
function isPicked(member: Member): boolean {
  return member.picked !== false;
}

// The bench. `grid` + `columns: 3` holds three tracks whatever the count, so the
// layout doesn't reflow as seats drop, and the cards keep a readable set size.
function benchSection(proposal: CastProposalRecord, showCast: boolean): Section {
  const anyPicked = proposal.members.some(isPicked);
  return {
    kind: "cards",
    title: anyPicked ? "The bench — click a seat to drop it" : "Click a seat to pick it back",
    grid: true,
    columns: 3,
    items: proposal.members.map((m) => cardFor(m, proposal.createdAt, showCast)),
  };
}

// One proposed member -> one card, mirroring the roster's member card so the seat
// being approved reads as the member it becomes: the identity it will keep for life
// as the dot, the role in a pill, its capability and its purpose either side of the
// reason's rule. The card BODY is the pick toggle — `selected` draws the ring, `action`
// declares the desired next state (not a flip, so a double-click is idempotent). A
// dropped seat keeps its fields and its purpose: they are what you'd re-read to pick it
// back. The ensemble only rides the card when the bench spans more than one.
function cardFor(member: Member, castAt: string, showCast: boolean) {
  const picked = isPicked(member);
  const name = member.name.trim() || "(unnamed)";
  const fields: { label?: string; value: string; tone?: CanvasTone }[] = [];
  const cast = showCast ? castLabel(member) : undefined;
  if (cast) fields.push({ label: "cast", value: cast });
  fields.push(capabilityField(member));
  return {
    title: name,
    dot: picked ? identityToneForSlot(member.identitySlot) : ("neutral" as CanvasTone),
    pill: picked
      ? { label: member.role.trim() || "Member" }
      : { label: "dropped", tone: "warn" as CanvasTone },
    fields,
    reason: { text: reasonFor(member) },
    selected: picked,
    action: {
      type: CAST_PICK_ACTION,
      payload: { slug: member.slug, picked: !picked, castAt },
    },
    actions: cardActions(member, castAt),
  };
}

// `code` is the seat's permission to modify the repository — the one thing on this card
// the governance floor exists to bound, so it is the only capability marked, and the
// read-only case carries no tone at all. Exported: the charter board repeats this line.
export function capabilityField(member: Member): { value: string; tone?: CanvasTone } {
  const tools = member.tools ?? [];
  if (tools.includes("code"))
    return { value: `✎ ${tools.join(", ")}`, tone: "caution" as CanvasTone };
  return { value: tools.length > 0 ? tools.join(", ") : "text-only" };
}

function cardActions(member: Member, castAt: string) {
  return [
    // A lone modelPicker field is the host's solo-picker fast path: the button opens the
    // catalog popover and a pick dispatches straight through, no form. The pin reads off
    // the label — the at-rest indicator, since the card carries no model field.
    {
      type: CAST_MODEL_ACTION,
      label: `Model — ${modelLabel(member)}`,
      glyph: "⚙",
      payload: { slug: member.slug, castAt },
      fields: [
        {
          name: "model",
          label: "Model",
          placeholder: "default (inherit)",
          modelPicker: {
            providerField: "provider",
            ...(member.provider ? { providerDefault: member.provider } : {}),
          },
          ...(member.model ? { defaultValue: member.model } : {}),
        },
      ],
    },
    {
      type: VIEW_CHARTER_ACTION,
      label: "▤",
      hint: "Charter",
      payload: { slug: member.slug, castAt },
    },
  ];
}

// validateProviderPin admits a provider with no model (that vendor's own default), and
// this label is the only place that pin is visible now — "default" alone would read as
// the harness default and hide it.
function modelLabel(member: Member): string {
  if (member.model) return member.model;
  return member.provider ? `${member.provider} default` : "default";
}

// What the seat is FOR — what you re-read when deciding whether to seat it. The scan's
// argument for the seat is a one-time read; it moves to the charter board and only
// stands in here when the charter says nothing.
function reasonFor(member: Member): string {
  const excerpt = charterExcerpt(member.name, member.charter);
  if (excerpt) return excerpt;
  return member.rationale?.trim() || "This seat's charter doesn't say what it's for.";
}

// The member's ensemble label, mirroring the roster card's fallback: the persisted
// themeLabel, else the catalog label for its themeId, else the raw id; undefined when
// the member was left uncast (a plain-name proposal).
function castLabel(member: Member): string | undefined {
  if (member.themeLabel) return member.themeLabel;
  if (member.themeId) return themeLabel(member.themeId) ?? member.themeId;
  return undefined;
}

// The Approve/Discard verbs. Approve is the board's one filled button: it is the
// move the panel exists to offer, and leaving it tonally quieter than the discard
// beside it would make the destructive verb the only coloured thing here. Its label
// counts what it will actually seat, and it gates (with a reason) rather than
// vanishing when there is nothing to seat.
function decideSection(proposal: CastProposalRecord, pickedCount: number): Section {
  const dropped = proposal.members.length - pickedCount;
  return {
    kind: "actions",
    title: "Cast this squad?",
    wrap: true,
    items: [
      {
        type: APPROVE_CAST_ACTION,
        label: pickedCount === 0 ? "Approve & scaffold" : `Approve ${pickedCount} & scaffold`,
        glyph: "✓",
        tone: "brand" as CanvasTone,
        payload: { castAt: proposal.createdAt },
        ...(pickedCount === 0
          ? {
              disabled: true,
              reason: "Every seat is dropped — click a card to pick one back before scaffolding.",
            }
          : {}),
        confirm: {
          title: "Scaffold the squad",
          body: `Author ${pickedCount} proposed member${pickedCount === 1 ? "" : "s"} as chat agent${
            pickedCount === 1 ? "" : "s"
          }?${
            dropped > 0
              ? ` The ${dropped} dropped seat${dropped === 1 ? "" : "s"} won't be created.`
              : ""
          } Existing members with the same name are kept, not overwritten.`,
          confirmLabel: "Scaffold",
          cancelLabel: "Cancel",
        },
      },
      {
        type: DISCARD_CAST_ACTION,
        label: "Discard proposal",
        glyph: "✕",
        tone: "warn" as CanvasTone,
        destructive: true,
        payload: { castAt: proposal.createdAt },
        confirm: {
          title: "Discard proposal",
          body: "Casting again runs a fresh read-only repo scan — a new model turn, up to five minutes — and proposes a different team, not this one minus your objection. To change the team and keep this scan, drop the seats you don't want instead.",
          confirmLabel: "Discard anyway",
          cancelLabel: "Cancel",
        },
      },
    ],
  };
}

function idleBoard(): CanvasBoardView {
  return {
    view: "board",
    title: "Proposed squad",
    header: { status: { label: "no proposal", tone: "neutral" as CanvasTone }, chip: "cast" },
    sections: [],
  };
}

// A charter preview for the card. Prefers the first line of the "## Mission"
// section (higher signal — what the member is FOR) over the charter's first
// substantive line, which is the one-word "## Role" body. Falls back to the first
// non-heading line when there's no Mission section. Candidate lines get the same
// charterDisplay cleanup as the detail body, so a provenance-only or self-name
// line never becomes the excerpt.
function charterExcerpt(name: string, charter: string, max = 200): string {
  const lines = charter.split("\n").map((l) => l.trim());
  const missionIdx = lines.findIndex((l) => /^##\s+mission\b/i.test(l));
  const scoped = missionIdx >= 0 ? lines.slice(missionIdx + 1) : [];
  for (const line of [...scoped, ...lines]) {
    if (line.length === 0 || line.startsWith("#")) continue;
    const text = charterDisplay(name, line);
    if (text) return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }
  return "";
}
