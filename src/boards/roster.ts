import type { CanvasBoardView, CanvasTone } from "@keelson/shared";
import { themeLabel } from "../casting/themes.ts";
import type { PendingGenesis } from "../pending-genesis.ts";
import { GENESIS_STARTERS } from "../starters.ts";
import { IDENTITY_SLOT_COUNT, identityToneForSlot, type Member } from "../types.ts";
import { CAST_PROPOSE_ACTION } from "./cast.ts";
import { charterDisplay, stripMd } from "./coordinator.ts";

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

// Pure: a roster of members -> a canvas `board`. Cold start (empty scope) shows the
// launchpad — Cast a whole team from the repo, or author the first member (archetype
// quick-starts + describe). A populated roster shows the member cards, a single "Add
// a member" (describe-your-own), and the retire-all verb: adding a member is always
// reachable, but Cast and the archetype quick-picks are cold-start scaffolding — re-
// casting a live squad is confusing, and once a scope has members you almost always
// want a specific member (switch the project chip to an empty scope to cast again).
// Identity rides the host head as a roster peek (with the collapse hint) once seated;
// project selection lives in the host's surface chip (projectScoped), not a board
// section. Validated against canvasViewSchema in tests.
export function buildRosterBoard(
  members: readonly Member[],
  pending?: PendingGenesis | null,
  now: number = Date.now(),
): CanvasBoardView {
  const sections: Section[] = [];

  if (members.length === 0 && !pending) {
    sections.push(introSection());
    sections.push(castSection());
    sections.push(authorSection());
    sections.push(journeySection());
  } else {
    // A genesis in flight takes the next free seat as a boot card; the seated cards
    // compose around it. While a genesis is pending the steady-state Add-a-member +
    // retire-all verbs are withheld — the boot card carries the moment.
    const bootItems = pending ? [bootCard(pending, nextFreeSlot(members), now)] : [];
    sections.push({ kind: "cards", items: [...members.map(cardFor), ...bootItems] });
    if (!pending) {
      sections.push(addMemberSection());
      sections.push(manageSection(members.length));
    }
  }

  return {
    view: "board",
    title: "Roster",
    header: {
      status: {
        label: `${members.length} ${members.length === 1 ? "member" : "members"}`,
        tone: "brand" as CanvasTone,
      },
      // Once members are seated, feed the host head its roster peek (an identity dot
      // per member, names on hover) and the collapse hint so the panel folds to its
      // head strip — the host collapses once, a manual toggle wins after. Cold start
      // emits neither, so the cast launchpad stays open.
      ...(members.length > 0
        ? {
            people: members.map((m) => ({
              name: m.name.trim() || "(unnamed)",
              tone: identityToneForSlot(m.identitySlot),
            })),
            defaultCollapsed: true,
          }
        : {}),
    },
    sections,
  };
}

// One member -> one card: the member's persisted identity tone as the dot, the role in a single pill, the
// ensemble (when cast) + charter (and model when set) as fields, a personality
// sub-line on the reason row, and its verbs — Enter (the primary, inline), an
// "Assign a code task…" for code-capable members, Set model, and Retire (destructive
// overflow with a confirm). The slug rides every action payload + the dot hash.
function cardFor(member: Member) {
  const fields: { label: string; value: string }[] = [];
  if (member.themeId) {
    fields.push({
      label: "cast",
      value: member.themeLabel ?? themeLabel(member.themeId) ?? member.themeId,
    });
  }
  fields.push({ label: "charter", value: rosterCharterExcerpt(member) });
  if (member.model) fields.push({ label: "model", value: member.model });
  return {
    title: member.name.trim() || "(unnamed)",
    dot: identityToneForSlot(member.identitySlot),
    pill: { label: member.role.trim() || "Member" },
    fields,
    // The character's personality as a sub-line, only when the member was cast.
    ...(member.personality
      ? { reason: { label: "personality", text: truncate(stripMd(member.personality), 160) } }
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

// The genesis stall window (seconds): past it, a pending genesis is presumed wedged
// (the workflow failed without clearing the marker), so the boot card offers a Dismiss.
const GENESIS_STALL_S = 180;

// The seat being taken while a genesis runs — the squad casting boot screen in keelson's
// ink: stacked mono lines (the card's `stacked` presentation), each a dim `>` prompt with
// the readout on the green `ok` tone. Squad assigns the member's name from the cast theme
// during the turn, so the name (and the theme) stay "calibrating…" here and land with the
// real card; only the role is honest, and only when a starter archetype was authored. Past
// the stall window it flips to a warn card with a Dismiss.
function bootCard(pending: PendingGenesis, slot: number, now: number) {
  const started = Date.parse(pending.startedAt);
  // An unparseable startedAt (a hand-edited marker) has no honest elapsed — present it as
  // stalled so it always carries a Dismiss, never a stuck "NaNs" card.
  const elapsedS = Number.isFinite(started)
    ? Math.max(0, Math.floor((now - started) / 1000))
    : GENESIS_STALL_S;
  if (elapsedS >= GENESIS_STALL_S) {
    return {
      title: "Casting",
      dot: "warn" as CanvasTone,
      pill: { label: "stalled", tone: "warn" as CanvasTone },
      fields: [
        {
          value: `casting has not landed in ${Math.floor(elapsedS / 60)}m — the workflow may have failed.`,
        },
      ],
      actions: [
        { type: "dismiss-genesis", label: "Dismiss", glyph: "✕", tone: "warn" as CanvasTone },
      ],
    };
  }
  const line = (text: string) => ({ label: ">", value: text, tone: "ok" as CanvasTone });
  return {
    title: "Casting…",
    dot: identityToneForSlot(slot),
    pill: { label: "authoring", tone: "brand" as CanvasTone },
    stacked: true,
    fields: [
      line("selecting cast…"),
      line(`seat: ${pending.role ?? "calibrating…"}`),
      line("name: calibrating…"),
      line(`charter: calibrating… · ${elapsedS}s`),
    ],
  };
}

// The first identity slot (0..4) no seated member wears, in ramp order — the seat the
// boot card takes. Past the five hues it folds to the neutral tone (slot ==
// IDENTITY_SLOT_COUNT), mirroring how an unreserved member's card dot folds.
function nextFreeSlot(members: readonly Member[]): number {
  const taken = new Set<number>();
  for (const m of members) {
    const slot = m.identitySlot;
    if (typeof slot === "number" && slot >= 0 && slot < IDENTITY_SLOT_COUNT) taken.add(slot);
  }
  for (let slot = 0; slot < IDENTITY_SLOT_COUNT; slot++) {
    if (!taken.has(slot)) return slot;
  }
  return IDENTITY_SLOT_COUNT;
}

// The framing line above the hero: copy belongs here, not on the action label —
// the button stays a verb.
function introSection(): Section {
  return {
    kind: "rows",
    items: [
      {
        glyph: "brand",
        text: "One scan of the repo composes the team — you approve before anything is created.",
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
    title: "Cast a squad from this repo",
    items: [
      {
        type: CAST_PROPOSE_ACTION,
        label: "Cast a squad",
        glyph: "✦",
        tone: "brand" as CanvasTone,
        inline: true,
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
// a describe-your-own brief. Each launches the squad-genesis workflow. Every preset
// wears the identity seat it will occupy (Lead→id-blue … Tester→id-rose, describe→
// id-olive): the hue is assigned by slot at cast/author, so the launchpad previews the
// five seats to fill rather than a flat row of status-neutral buttons.
function authorSection(): Section {
  return {
    kind: "actions",
    title: "or seat one member yourself",
    items: [
      ...GENESIS_STARTERS.map((s, i) => ({
        type: "author-archetype",
        label: `${s.name} — ${s.tagline}`,
        glyph: "＋",
        tone: identityToneForSlot(i),
        payload: { slug: s.slug },
      })),
      {
        type: "describe-own",
        label: "Describe & author",
        glyph: "✎",
        tone: identityToneForSlot(GENESIS_STARTERS.length),
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

function journeySection(): Section {
  return {
    kind: "journey",
    items: [
      {
        title: "Cast",
        text: "The scan proposes a team; you approve or discard it.",
      },
      {
        title: "Meet",
        text: "Each member becomes a chat agent you can enter and talk to.",
      },
      {
        title: "Run",
        text: "Give the squad a task — the loop's rounds and findings stream here.",
      },
    ],
  };
}

function truncate(text: string, max = 120): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "(no charter)";
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function rosterCharterExcerpt(member: Member): string {
  return truncate(charterDisplay(member.name, member.charter));
}
