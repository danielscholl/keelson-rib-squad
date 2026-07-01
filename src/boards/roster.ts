import type { CanvasBoardView, CanvasTone } from "@keelson/shared";
import { themeLabel } from "../casting/themes.ts";
import { stableHash } from "../genesis.ts";
import { GENESIS_STARTERS } from "../starters.ts";
import type { Member } from "../types.ts";
import { CAST_PROPOSE_ACTION } from "./cast.ts";

type Section = CanvasBoardView["sections"][number];

// The scope verb: the host's projectScoped surface chip dispatches this to persist
// the operator's project selection — the scopeId every scoped data path keys on.
// Shared with onAction so the type can't drift from its handler.
export const SELECT_PROJECT_ACTION = "select-project";
// Retire every member in the selected scope — the "remove the squad" verb. There is
// no squad object; a squad IS its scoped roster, so removing it retires each member.
// Shared with onAction so the type can't drift from its handler.
export const RETIRE_ALL_ACTION = "retire-all";
// Assign a confined coding task to one code-capable member straight from its card —
// launches the squad-code-run workflow with the member's slug. Shared with onAction.
export const ASSIGN_CODE_ACTION = "assign-code";

// Mirrors code.ts CODE_CAPABILITY, kept local so the out-of-process roster collector
// need not import the agent-turn machinery just to gate one card action.
const CODE_CAPABILITY = "code";
function memberCanCode(member: Member): boolean {
  return (member.tools ?? []).includes(CODE_CAPABILITY);
}

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
// size, the active/inactive split, and how many members can code. Computed from the
// members list (the collector builds it inline), so it stays a plain shape here.
export interface RosterPulse {
  members: number;
  active: number;
  inactive: number;
  codeCapable: number;
}

// Pure: a roster of members -> a canvas `board`. Cold start (empty scope) shows the
// launchpad — Cast a whole team from the repo, or author the first member (archetype
// quick-starts + describe). A populated roster shows the member cards, a single "Add
// a member" (describe-your-own), and a Manage (retire-all) verb: adding a member is
// always reachable, but Cast and the archetype quick-picks are cold-start scaffolding
// — re-casting a live squad is confusing, and once a scope has members you almost
// always want a specific member (switch the project chip to an empty scope to cast
// again). `pulse`, when present, leads with a calm stats section. Project selection
// lives in the host's surface chip (projectScoped), not a board section. Validated
// against canvasViewSchema in tests.
export function buildRosterBoard(members: readonly Member[], pulse?: RosterPulse): CanvasBoardView {
  const sections: Section[] = [];

  if (pulse) sections.push(pulseSection(pulse));

  if (members.length === 0) {
    sections.push(anchorSection());
    sections.push(castSection());
    sections.push(authorSection());
    sections.push(whatsNextSection());
  } else {
    sections.push({ kind: "cards", items: members.map(cardFor) });
    sections.push(addMemberSection());
    sections.push(manageSection(members.length));
  }

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

// The pulse `stats` section: team size, the active/inactive split, and the
// code-capable count (who can run a code turn). A zero count tones neutral so an
// idle squad stays quiet.
function pulseSection(pulse: RosterPulse): Section {
  const toned = (n: number, tone: CanvasTone): CanvasTone => (n > 0 ? tone : "neutral");
  return {
    kind: "stats",
    items: [
      { label: "Members", value: pulse.members, tone: toned(pulse.members, "brand") },
      { label: "Active", value: pulse.active, tone: toned(pulse.active, "ok") },
      { label: "Inactive", value: pulse.inactive, tone: toned(pulse.inactive, "neutral") },
      { label: "Code-capable", value: pulse.codeCapable, tone: toned(pulse.codeCapable, "info") },
    ],
  };
}

// One member -> one card: a hashed identity dot, the role in a single pill, the
// ensemble (when cast) + charter (and model when set) as fields, a personality
// sub-line on the reason row, and its verbs — Enter (the primary, inline), an
// "Assign a code task…" for code-capable members, Set model, and Retire (destructive
// overflow with a confirm). The slug rides every action payload + the dot hash.
function cardFor(member: Member) {
  const fields: { label: string; value: string }[] = [];
  if (member.themeId) {
    fields.push({ label: "cast", value: themeLabel(member.themeId) ?? member.themeId });
  }
  fields.push({ label: "charter", value: truncate(member.charter) });
  if (member.model) fields.push({ label: "model", value: member.model });
  return {
    title: member.name.trim() || "(unnamed)",
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
      // Direct code assignment for members who carry the "code" capability — the
      // one-click path to squad_code from the roster (gated so text-only members
      // don't offer a write verb they can't run).
      ...(memberCanCode(member)
        ? [
            {
              type: ASSIGN_CODE_ACTION,
              label: "Assign a code task…",
              glyph: "⌗",
              payload: { slug: member.slug },
              fields: [
                {
                  name: "task",
                  label: "Code task",
                  placeholder: `What should ${member.name.trim() || "this member"} implement? e.g. "add a --json flag to the status command"`,
                  multiline: true,
                },
              ],
            },
          ]
        : []),
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
        // Surface it as a visible (still confirm-guarded) button, not tucked in the
        // card's ⋯ overflow — retiring one member should be an obvious verb.
        inline: true,
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

// The anchor line for a cold-start roster: one calm sentence naming the two ways to
// build a squad. Distinct from the persistent create sections below it.
function anchorSection(): Section {
  return {
    kind: "rows",
    items: [
      {
        glyph: "brand",
        text: "A Squad is a team of members tuned to your project. Cast one to auto-compose the team from the repo, or author members yourself — each becomes a chat agent you can talk to directly.",
      },
    ],
  };
}

// The defining verb: scan the SELECTED project and propose the team best suited to
// it. Scope follows the project picker — casting always targets the selected project,
// so the team lands in the same scope a no-arg run reads. Mission is optional.
function castSection(): Section {
  return {
    kind: "actions",
    title: "Cast a squad",
    items: [
      {
        type: CAST_PROPOSE_ACTION,
        label: "Cast a squad for the selected project",
        glyph: "✦",
        fields: [
          {
            name: "mission",
            label: "Mission (optional)",
            placeholder: 'What is this squad for? e.g. "ship the new search rib"',
            multiline: true,
          },
        ],
      },
    ],
  };
}

// The manual escape hatch: author one member at a time — the starter archetypes plus
// a describe-your-own brief. Each launches the squad-genesis workflow.
function authorSection(): Section {
  return {
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
  };
}

// The steady-state create verb: one "describe the member you want" action for a
// squad that already exists. The archetype quick-starts and Cast live on the
// cold-start launchpad only — a populated squad grows one deliberate member at a time.
function addMemberSection(): Section {
  return {
    kind: "actions",
    title: "Add a member",
    items: [
      {
        type: "describe-own",
        label: "Describe & author",
        glyph: "✎",
        fields: [
          {
            name: "brief",
            label: "Who should this member be?",
            placeholder: 'e.g. "Atlas — a staff engineer who guards the architecture"',
            multiline: true,
          },
        ],
      },
    ],
  };
}

// Squad-level teardown: retire every member in the selected scope. The confirm names
// the count so the operator sees the blast radius before the roster is cleared.
function manageSection(count: number): Section {
  return {
    kind: "actions",
    title: "Manage",
    items: [
      {
        type: RETIRE_ALL_ACTION,
        label: "Retire the whole squad…",
        glyph: "✕",
        tone: "warn" as CanvasTone,
        destructive: true,
        confirm: {
          title: "Retire the whole squad",
          body: `Retire all ${count} member${count === 1 ? "" : "s"} in this scope? This permanently deletes every member and its charter.`,
          confirmLabel: "Retire all",
          cancelLabel: "Cancel",
        },
      },
    ],
  };
}

function whatsNextSection(): Section {
  return {
    kind: "rows",
    items: [
      {
        glyph: "neutral",
        text: "Next: each member you author appears here as a card and as a chat agent you can enter.",
        trailing: "what's next",
      },
    ],
  };
}

function truncate(text: string, max = 120): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "(no charter)";
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}
