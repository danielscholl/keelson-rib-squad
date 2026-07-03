import type { CanvasBoardView, CanvasTone } from "@keelson/shared";
import type { CastProposalRecord } from "../cast.ts";
import { identityToneForSlot } from "../types.ts";
import { charterDisplay } from "./coordinator.ts";

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

  const sections: CanvasBoardView["sections"] = [membersSection(proposal)];
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

function membersSection(proposal: CastProposalRecord): CanvasBoardView["sections"][number] {
  return {
    kind: "rows",
    title: "Members",
    items: proposal.members.map(rowFor),
  };
}

function rowFor(member: CastProposalRecord["members"][number]) {
  const charter = charterDisplay(member.name, member.charter);
  const excerpt = charterExcerpt(member.name, member.charter);
  const tools = member.tools?.length ? member.tools.join(", ") : "text-only";
  const trailing = [member.role.trim() || "Member", tools, member.model]
    .filter(Boolean)
    .join(" · ");
  // The identity assigned at propose time is the identity the member keeps on
  // the roster and in the run boards — the seat the operator approves.
  const tone = identityToneForSlot(member.identitySlot);
  return {
    glyph: tone,
    chip: { label: member.name.trim() || "(unnamed)", tone },
    text: excerpt || "(no charter)",
    trailing,
    ...(charter ? { detail: charter } : {}),
  };
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
            text: "No proposal yet. Cast a squad from the roster; the proposed team appears here before anything is created.",
          },
        ],
      },
    ],
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
