import type { CanvasBoardView, CanvasTone } from "@keelson/shared";
import type { CastProposalRecord } from "../cast.ts";

// The verbs the Proposed-squad board offers. Shared with onAction so the action
// types can't drift from their handlers. cast-propose lives on the roster
// cold-start (it carries the project/mission form); approve/discard act on the
// already-persisted proposal, so they carry no payload.
export const CAST_PROPOSE_ACTION = "cast-propose";
export const APPROVE_CAST_ACTION = "approve-cast";
export const DISCARD_CAST_ACTION = "discard-cast";

// Pure: a pending cast proposal -> a canvas `board`. No proposal renders a calm
// idle board (cast a squad from the roster); a proposal renders one card per
// proposed member plus the Approve & scaffold / Discard verbs. Validated against
// canvasViewSchema in tests; the collector never parses (validation lives at the
// binding edge via expectView).
export function buildCastBoard(proposal: CastProposalRecord | undefined): CanvasBoardView {
  if (!proposal) return idleBoard();

  const sections: CanvasBoardView["sections"] = [
    { kind: "cards", items: proposal.members.map(cardFor) },
  ];
  if (proposal.notes.length > 0) {
    sections.push({
      kind: "rows",
      items: proposal.notes.map((text) => ({ glyph: "warn" as CanvasTone, text })),
    });
  }
  sections.push(decideSection());

  const count = proposal.members.length;
  return {
    view: "board",
    title: "Proposed squad",
    header: {
      status: {
        label: `${count} ${count === 1 ? "member" : "members"}`,
        tone: "brand" as CanvasTone,
      },
      chip: proposal.projectName,
    },
    sections,
  };
}

// One proposed member -> one card: name as the title, role in the pill, the
// capability tags and charter as fields, and a charter excerpt on the reason line.
// The tags are the load-bearing #14 detail — they ride the card so the operator
// sees how each member would be routed before approving.
function cardFor(member: CastProposalRecord["members"][number]) {
  const fields: { label: string; value: string }[] = [
    { label: "tools", value: member.tools?.length ? member.tools.join(", ") : "text-only" },
  ];
  if (member.model) fields.push({ label: "model", value: member.model });
  const card: {
    title: string;
    pill: { label: string };
    fields: { label: string; value: string }[];
    reason?: { label: string; text: string };
  } = {
    title: member.name,
    pill: { label: member.role.trim() || "Member" },
    fields,
  };
  const excerpt = charterExcerpt(member.charter);
  if (excerpt) card.reason = { label: "charter", text: excerpt };
  return card;
}

// The Approve/Discard verbs. Approve scaffolds the proposed members (collision-safe);
// Discard drops the proposal. Approve confirms because it writes the whole roster.
function decideSection(): CanvasBoardView["sections"][number] {
  return {
    kind: "actions",
    title: "Cast this squad?",
    items: [
      {
        type: APPROVE_CAST_ACTION,
        label: "Approve & scaffold",
        glyph: "✓",
        tone: "ok" as CanvasTone,
        confirm: {
          title: "Scaffold the squad",
          body: "Author every proposed member as a chat agent? Existing members with the same name are kept, not overwritten.",
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
        confirm: {
          title: "Discard proposal",
          body: "Discard this proposed squad? You can cast again from the roster.",
          confirmLabel: "Discard",
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
    sections: [
      {
        kind: "rows",
        items: [
          {
            glyph: "neutral",
            text: 'No squad proposed yet. Use "Cast a squad" on the roster to inspect a project and auto-compose the team best suited to it.',
          },
        ],
      },
    ],
  };
}

// A charter preview for the card. Prefers the first line of the "## Mission"
// section (higher signal — what the member is FOR) over the charter's first
// substantive line, which is the one-word "## Role" body. Falls back to the first
// non-heading line when there's no Mission section.
function charterExcerpt(charter: string, max = 200): string {
  const lines = charter.split("\n").map((l) => l.trim());
  const missionIdx = lines.findIndex((l) => /^##\s+mission\b/i.test(l));
  const line =
    (missionIdx >= 0
      ? lines.slice(missionIdx + 1).find((l) => l.length > 0 && !l.startsWith("#"))
      : undefined) ?? lines.find((l) => l.length > 0 && !l.startsWith("#"));
  if (!line) return "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
