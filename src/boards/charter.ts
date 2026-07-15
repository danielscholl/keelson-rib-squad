import type { CanvasBoardView, CanvasTone } from "@keelson/shared";
import type { CastProposalRecord } from "../cast.ts";
import { identityToneForSlot } from "../types.ts";
import { capabilityField } from "./cast.ts";
import { charterDetail, charterDisplay, stripMd } from "./coordinator.ts";

type Member = CastProposalRecord["members"][number];
type Section = CanvasBoardView["sections"][number];

// Pure: one proposed seat -> the drill-down board behind the bench card's Charter
// button. The Proposed-squad card carries only the seat's purpose; reading the charter
// in full is how you decide whether to seat its member, and a card has no `detail` to
// disclose it into. Published under CHARTER_KEY by the view-charter action, which hands
// the SPA an open-canvas effect pointing at it — the same shape as the run drill-down.
export function buildCharterBoard(
  member: Member | undefined,
  projectName: string,
): CanvasBoardView {
  if (!member) return idleBoard();
  const picked = member.picked !== false;
  const name = member.name.trim() || "(unnamed)";
  return {
    view: "board",
    title: "Charter",
    header: {
      status: {
        label: picked ? "picked" : "dropped",
        tone: (picked ? "brand" : "warn") as CanvasTone,
      },
      chip: projectName.trim() || "cast",
    },
    sections: [seatSection(member, name, picked), charterSection(member, name)],
  };
}

// The seat, restated: the same dot / title / role pill the bench card wears, so the
// panel reads as that card's back rather than as a different member. This is also where
// the scan's argument for the seat lands — the card spends its one prose slot on what
// the seat is FOR, so "why this seat?" is answered here, beside the charter it argues for.
function seatSection(member: Member, name: string, picked: boolean): Section {
  const rationale = member.rationale?.trim();
  return {
    kind: "cards",
    items: [
      {
        title: name,
        dot: picked ? identityToneForSlot(member.identitySlot) : ("neutral" as CanvasTone),
        pill: picked
          ? { label: member.role.trim() || "Member" }
          : { label: "dropped", tone: "warn" as CanvasTone },
        fields: [capabilityField(member)],
        ...(rationale ? { reason: { label: "why cast:", text: rationale } } : {}),
      },
    ],
  };
}

// The charter itself. A panel whose only job is showing a charter must not hide it
// behind a caret, so the prose rides `text` (rows aren't monospace and `text` has no
// cap, unlike a card field); `detail` re-hangs the structure only for a body that has
// some, so a one-paragraph section renders no disclosure at all.
function charterSection(member: Member, name: string): Section {
  const items = charterChunks(member.charter).flatMap((chunk) => {
    // charterDisplay strips a leading self-name — right for the preamble (the charter's
    // own `# Mal` head and its cast-provenance line), wrong for a section body, where
    // "Mal holds the line." would lose its subject.
    const preamble = !chunk.heading;
    const text = preamble ? charterDisplay(name, chunk.body) : stripMd(chunk.body);
    if (!text) return [];
    const detail = structured(chunk.body)
      ? capDetail(charterDetail(preamble ? name : "", chunk.body))
      : "";
    return [
      {
        ...(chunk.heading ? { chip: { label: chunk.heading } } : {}),
        text,
        ...(detail ? { detail } : {}),
      },
    ];
  });
  return {
    kind: "rows",
    title: "Charter",
    items:
      items.length > 0
        ? items
        : [{ glyph: "warn" as CanvasTone, text: "This seat was proposed without a charter." }],
  };
}

// The charter's own `##` sections are its shape (Role / Mission / Voice, over a preamble
// the themed cast folds in). Everything before the first heading is the preamble.
function charterChunks(charter: string): { heading?: string; body: string }[] {
  const out: { heading?: string; body: string }[] = [];
  let heading: string | undefined;
  let buf: string[] = [];
  const flush = () => {
    const body = buf.join("\n").trim();
    if (body) out.push({ ...(heading ? { heading } : {}), body });
    buf = [];
  };
  for (const line of charter.split("\n")) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      flush();
      heading = m[1];
      continue;
    }
    buf.push(line);
  }
  flush();
  return out;
}

// Paragraph breaks or list markers are structure worth re-hanging; a single paragraph
// already reads whole in `text`, and a caret onto the same words is noise.
function structured(body: string): boolean {
  return /\n\s*\n/.test(body.trim()) || /^\s*([-*+]|\d+\.)\s/m.test(body);
}

// rows.detail is capped at 4000 by the contract and a charter is unbounded — the scan
// writes it and castMemberSchema sets no max — so an oversized section would take this
// board down through the snapshot rather than degrading.
const DETAIL_CAP = 4000;

function capDetail(text: string): string {
  return text.length > DETAIL_CAP ? `${text.slice(0, DETAIL_CAP - 1)}…` : text;
}

function idleBoard(): CanvasBoardView {
  return {
    view: "board",
    title: "Charter",
    header: { status: { label: "no seat", tone: "neutral" as CanvasTone }, chip: "cast" },
    sections: [],
  };
}
