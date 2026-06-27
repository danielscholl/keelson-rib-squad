import type { CanvasBoardView, CanvasTone } from "@keelson/shared";
import { themeLabel } from "../casting/themes.ts";
import { stableHash } from "../genesis.ts";
import { GENESIS_STARTERS } from "../starters.ts";
import type { Member } from "../types.ts";
import { CAST_PROPOSE_ACTION } from "./cast.ts";

// The full canvas tone ramp, used to give each member a deterministic identity dot
// hashed from its slug — a stable per-member hue, not a status.
const DOT_TONES = [
  "ok",
  "warn",
  "error",
  "info",
  "caution",
  "brand",
  "accent",
  "neutral",
] as const satisfies readonly CanvasTone[];

// stableHash returns a base-36 string; parsing it back at radix 36 recovers the
// integer to mod across the ramp, so distinct slugs spread across the tones.
function dotFor(slug: string): CanvasTone {
  return DOT_TONES[Number.parseInt(stableHash(slug), 36) % DOT_TONES.length]!;
}

// The Squad pulse, the optional `stats` section the roster leads with: the team
// size plus the active/inactive split. Computed from the members list (the
// collector builds it inline), so it stays a plain shape here (no store import).
export interface RosterPulse {
  members: number;
  active: number;
  inactive: number;
}

// Pure: a roster of members -> a canvas `board`. Zero members renders a cold-start
// launchpad (author the first member); >=1 renders one card per member (Enter
// inline, Set model + Retire alongside). `pulse`, when present, leads the board
// with a calm stats section. Validated against canvasViewSchema in tests; the
// producer never parses (validation lives at the binding edge).
export function buildRosterBoard(members: readonly Member[], pulse?: RosterPulse): CanvasBoardView {
  const sections: CanvasBoardView["sections"] =
    members.length === 0 ? coldStartSections() : [{ kind: "cards", items: members.map(cardFor) }];

  // The pulse leads the board so the team size + active split read first; calm by
  // design — a zero count tones neutral so an idle squad doesn't shout.
  if (pulse) sections.unshift(pulseSection(pulse));

  return {
    view: "board",
    title: "Roster",
    header: {
      status: {
        label: `${members.length} ${members.length === 1 ? "member" : "members"}`,
        tone: "brand" as CanvasTone,
      },
      chip: "roster",
    },
    sections,
  };
}

// The pulse `stats` section: the team size and the active/inactive split. Counts
// tone bright when non-zero and neutral when zero so an idle squad stays quiet.
function pulseSection(pulse: RosterPulse): CanvasBoardView["sections"][number] {
  const toned = (n: number, tone: CanvasTone): CanvasTone => (n > 0 ? tone : "neutral");
  return {
    kind: "stats",
    items: [
      { label: "Members", value: pulse.members, tone: toned(pulse.members, "brand") },
      { label: "Active", value: pulse.active, tone: toned(pulse.active, "ok") },
      { label: "Inactive", value: pulse.inactive, tone: toned(pulse.inactive, "neutral") },
    ],
  };
}

// One member -> one card: a hashed identity dot, the role in a single pill, the
// ensemble (when cast) + charter (and model when set) as fields, a personality
// sub-line on the reason row, and three actions — Enter (the primary verb, rendered
// inline), Set model, and Retire (destructive overflow with a confirm). The slug
// rides every action payload + the dot hash.
function cardFor(member: Member) {
  const fields: { label: string; value: string }[] = [];
  if (member.themeId) {
    fields.push({ label: "cast", value: themeLabel(member.themeId) ?? member.themeId });
  }
  fields.push({ label: "charter", value: truncate(member.charter) });
  if (member.model) fields.push({ label: "model", value: member.model });
  return {
    title: member.name,
    dot: dotFor(member.slug),
    pill: { label: member.role.trim() || "Member" },
    fields,
    // The character's personality as a sub-line, only when the member was cast.
    ...(member.personality
      ? { reason: { label: "personality", text: truncate(member.personality, 160) } }
      : {}),
    actions: [
      {
        type: "enter-member",
        label: `Enter ${member.name}`,
        glyph: "→",
        payload: { slug: member.slug },
      },
      {
        type: "set-model",
        label: "Set model…",
        glyph: "⚙",
        payload: { slug: member.slug },
        fields: [
          {
            name: "model",
            label: "Model",
            placeholder: member.model ?? "e.g. claude-opus-4.8 (blank to clear)",
          },
          {
            name: "provider",
            label: "Provider",
            placeholder: member.provider ?? "optional, e.g. anthropic",
          },
        ],
      },
      {
        type: "retire",
        label: "Retire member…",
        glyph: "✕",
        tone: "warn" as CanvasTone,
        destructive: true,
        payload: { slug: member.slug },
        confirm: {
          title: "Retire member",
          body: `Retire ${member.name}? This permanently deletes the member and its charter.`,
          confirmLabel: "Retire",
          cancelLabel: "Cancel",
        },
      },
    ],
  };
}

// The cold-start launchpad: an anchor sentence, a "Cast a squad" section (the
// defining capability — auto-compose the team from the project), an "Author a
// member" section (the manual escape hatch: archetypes + a describe-your-own
// brief), and a "what's next" line.
function coldStartSections(): CanvasBoardView["sections"] {
  return [
    {
      kind: "rows",
      items: [
        {
          glyph: "brand",
          text: "A Squad is a team of members tuned to your project. Cast one to auto-compose the team from the repo, or author members yourself — each becomes a chat agent you can talk to directly.",
        },
      ],
    },
    {
      kind: "actions",
      title: "Cast a squad",
      items: [
        {
          // The defining verb: scan a project and propose the team best suited to
          // it. Project is a free-text name resolved live against getProjects() at
          // action time (blank = the default / only project); mission is optional.
          type: CAST_PROPOSE_ACTION,
          label: "Cast a squad for a project",
          glyph: "✦",
          fields: [
            {
              name: "project",
              label: "Project",
              placeholder: "project name (blank = the default / only project)",
            },
            {
              name: "mission",
              label: "Mission (optional)",
              placeholder: 'What is this squad for? e.g. "ship the new search rib"',
              multiline: true,
            },
          ],
        },
      ],
    },
    {
      kind: "actions",
      title: "Author a member",
      items: [
        ...GENESIS_STARTERS.map((s) => ({
          type: "author-archetype",
          label: `${s.name} — ${s.tagline}`,
          glyph: "✦",
          payload: { slug: s.slug },
        })),
        {
          type: "describe-own",
          label: "Describe & author",
          glyph: "✎",
          fields: [
            {
              name: "brief",
              label: "Or describe your own",
              placeholder:
                'Who should this member be? e.g. "Atlas — a staff engineer who guards the architecture"',
              multiline: true,
            },
          ],
        },
      ],
    },
    {
      kind: "rows",
      items: [
        {
          glyph: "neutral",
          text: "Next: each member you author appears here as a card and as a chat agent you can enter.",
          trailing: "what's next",
        },
      ],
    },
  ];
}

function truncate(text: string, max = 120): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "(no charter)";
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}
