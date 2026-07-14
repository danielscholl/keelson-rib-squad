import type { CanvasBoardView, CanvasTone } from "@keelson/shared";
import type { CastProposalRecord } from "../cast.ts";
import { themeLabel } from "../casting/themes.ts";
import { identityToneForSlot } from "../types.ts";
import { charterDetail, charterDisplay } from "./coordinator.ts";

// The verbs the Proposed-squad board offers. Shared with onAction so the action
// types can't drift from their handlers. cast-propose lives on the roster
// cold-start (it carries the project/mission form); cast-pick/approve/discard act on
// the already-persisted proposal and carry its createdAt so a click aimed at a
// replaced cast is rejected rather than applied to different members.
export const CAST_PROPOSE_ACTION = "cast-propose";
export const CAST_PICK_ACTION = "cast-pick";
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
  const sections: Section[] = [benchSection(proposal)];
  if (proposal.notes.length > 0) {
    sections.push({
      kind: "rows",
      title: "Notes from the cast",
      items: proposal.notes.map((text) => ({ glyph: "warn" as CanvasTone, text })),
    });
  }
  sections.push(charterSection(proposal));
  sections.push(decideSection(proposal, picked.length));

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
    sections,
  };
}

// Absent means picked: a proposal written before subset approve, or by a scan that
// never sets the flag, is a full bench.
function isPicked(member: Member): boolean {
  return member.picked !== false;
}

// The bench. `grid` + `columns: 3` holds three tracks whatever the count, so the
// layout doesn't reflow as seats drop, and the cards keep a readable set size.
function benchSection(proposal: CastProposalRecord): Section {
  const anyPicked = proposal.members.some(isPicked);
  return {
    kind: "cards",
    title: anyPicked ? "The bench — click a seat to drop it" : "Click a seat to pick it back",
    grid: true,
    columns: 3,
    items: proposal.members.map((m) => cardFor(m, proposal.createdAt)),
  };
}

// One proposed member -> one card, mirroring the roster's member card so the seat
// being approved reads as the member it becomes: the identity it will keep for life
// as the dot, the role in a pill, capability/ensemble/model as fields. The card BODY
// is the pick toggle — `selected` draws the ring, `action` declares the desired next
// state (not a flip, so a double-click is idempotent). A dropped seat keeps its
// fields and its reason: they are what you'd re-read to pick it back.
function cardFor(member: Member, castAt: string) {
  const picked = isPicked(member);
  const name = member.name.trim() || "(unnamed)";
  const fields: { label: string; value: string }[] = [];
  const cast = castLabel(member);
  if (cast) fields.push({ label: "cast", value: cast });
  fields.push({
    label: "can",
    value: member.tools?.length ? member.tools.join(", ") : "text-only",
  });
  if (member.model) fields.push({ label: "model", value: member.model });
  else if (member.provider) fields.push({ label: "engine", value: member.provider });
  return {
    title: name,
    dot: picked ? identityToneForSlot(member.identitySlot) : ("neutral" as CanvasTone),
    pill: picked
      ? { label: member.role.trim() || "Member" }
      : { label: "dropped", tone: "warn" as CanvasTone },
    fields,
    reason: { label: "why cast:", text: reasonFor(member) },
    selected: picked,
    action: {
      type: CAST_PICK_ACTION,
      payload: { slug: member.slug, picked: !picked, castAt },
    },
  };
}

// The scan's own justification for the seat. Falls back to the charter's mission
// excerpt when the scan returned none — an optional field the model skipped is a
// prompt-adherence miss, not grounds to leave the card's one "what is this member
// for" line empty.
function reasonFor(member: Member): string {
  if (member.rationale?.trim()) return member.rationale.trim();
  const excerpt = charterExcerpt(member.name, member.charter);
  return excerpt || "The scan returned no reason for this seat.";
}

// The member's ensemble label, mirroring the roster card's fallback: the persisted
// themeLabel, else the catalog label for its themeId, else the raw id; undefined when
// the member was left uncast (a plain-name proposal).
function castLabel(member: Member): string | undefined {
  if (member.themeLabel) return member.themeLabel;
  if (member.themeId) return themeLabel(member.themeId) ?? member.themeId;
  return undefined;
}

// The full charters, disclosed. Cards carry no `detail`, and reading a charter in
// full is exactly how you decide whether to seat its member — so the rows the bench
// replaced stay on as an appendix rather than being lost.
function charterSection(proposal: CastProposalRecord): Section {
  return {
    kind: "rows",
    title: "Charters in full",
    items: proposal.members.map((m) => {
      const name = m.name.trim() || "(unnamed)";
      const detail = charterDetail(name, m.charter);
      return {
        glyph: (isPicked(m) ? identityToneForSlot(m.identitySlot) : "neutral") as CanvasTone,
        chip: { label: name, tone: identityToneForSlot(m.identitySlot) },
        text: `cast as ${m.role.trim() || "Member"}`,
        ...(isPicked(m) ? {} : { trailing: "dropped" }),
        ...(detail ? { detail } : {}),
      };
    }),
  };
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
