import type { CanvasBoardView, CanvasTone } from "@keelson/shared";
import type { CastProposalRecord } from "../cast.ts";
import type { LiveRunElsewhere } from "../live-runs.ts";
import type { PendingGenesis } from "../pending-genesis.ts";
import { GENESIS_STARTERS } from "../starters.ts";
import { IDENTITY_SLOT_COUNT, identityToneForSlot, type Member } from "../types.ts";
import {
  CAST_PROPOSE_ACTION,
  capabilityField,
  castLabel,
  charterExcerpt,
  modelLabel,
} from "./cast.ts";
import { stripMd } from "./coordinator.ts";

type Section = CanvasBoardView["sections"][number];

// The scope verb: the host's projectScoped surface chip dispatches this to persist
// the operator's project selection — the scopeId every scoped data path keys on.
// Shared with onAction so the type can't drift from its handler.
export const SELECT_PROJECT_ACTION = "select-project";
// Retire every member in the selected scope — the "remove the squad" verb. There is
// no squad object; a squad IS its scoped roster, so removing it retires each member.
// Shared with onAction so the type can't drift from its handler.
export const RETIRE_ALL_ACTION = "retire-all";

// The selected project, as much of it as an out-of-process collector can resolve.
// `name` falls back to the projects.json snapshot; `rootPath` has no fallback at all
// (the snapshot carries only { id, name }), so both are optional and both degrade to
// silence rather than to a stand-in.
export interface RosterProject {
  name?: string;
  rootPath?: string;
}

// Pure: a roster of members -> a canvas `board`. Cold start (empty scope) shows the
// launchpad — Cast a whole team from the repo, or author the first member (archetype
// quick-starts + describe). A populated roster shows the member cards over a single
// Hire verb: hiring is always reachable, but Cast and the archetype quick-picks are
// cold-start scaffolding — re-casting a live squad is confusing, and once a scope has
// members you almost always want a specific member (switch the project chip to an empty
// scope to cast again). Squad teardown is NOT here: retire-all is a head verb on the
// surface region, so it can't be gated on anything this function knows.
// Identity rides the host head as a roster peek (with the collapse hint) once seated;
// project selection lives in the host's surface chip (projectScoped), not a board
// section. Validated against canvasViewSchema in tests.
//
// The moment-carrier rule: exactly one thing owns the operator's next move. A genesis
// in flight → the boot card. A proposal awaiting review → the Proposed-squad panel
// (the roster offers no authoring verbs, so a second cast can't start mid-review).
// Neither → the launchpad (cold start) or the steady-state Hire verb.
export function buildRosterBoard(
  members: readonly Member[],
  pending?: PendingGenesis | null,
  now: number = Date.now(),
  proposal?: CastProposalRecord | null,
  liveRunsElsewhere: readonly LiveRunElsewhere[] = [],
  project?: RosterProject,
): CanvasBoardView {
  const sections: Section[] = [];
  const hoisted = hoistedEnsemble(members);

  if (liveRunsElsewhere.length > 0) sections.push(liveRunsStrip(liveRunsElsewhere));

  if (members.length === 0 && !pending) {
    if (proposal) {
      sections.push(awaitingSection(proposal.members.length));
    } else {
      sections.push(introSection(project?.rootPath));
      sections.push(castSection(project?.name));
      sections.push(authorSection());
    }
  } else {
    // A genesis in flight takes the next free seat as a boot card; the seated cards
    // compose around it. While a genesis is pending the steady-state Hire verb is
    // withheld — the boot card carries the moment.
    const bootItems = pending ? [bootCard(pending, nextFreeSlot(members), now)] : [];
    sections.push({
      kind: "cards",
      // The bench's own shape: three tracks whatever the count, so the cards keep a
      // readable set size instead of stretching to fill the row.
      grid: true,
      columns: 3,
      items: [...members.map((m) => cardFor(m, !hoisted)), ...bootItems],
    });
    if (!pending) {
      if (proposal) {
        sections.push(awaitingSection(proposal.members.length));
      } else {
        sections.push(hireSection());
      }
    }
  }

  const chip = hoisted ?? (members.length === 0 ? project?.name?.trim() || undefined : undefined);

  return {
    view: "board",
    title: "The Squad",
    header: {
      status: {
        label: `${members.length} ${members.length === 1 ? "member" : "members"}`,
        tone: "brand" as CanvasTone,
      },
      // The ensemble is the roster's subject only when every seat wears it — so it is
      // said once here instead of on all five cards. An empty roster has no ensemble to
      // hoist, so the slot names the project the cast is about to read instead: the two
      // can never collide, because a hoist needs a seated member and the project chip
      // needs none.
      ...(chip ? { chip } : {}),
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

// One member -> one card, in the bench's anatomy so an approved seat reads as the member
// it became rather than as a different object: the persisted identity tone as the dot,
// the role in a single pill, its capability above the reason's rule and its PURPOSE
// below, the character's personality as the footnote, and its verbs — Enter, the model
// picker, and Retire (destructive overflow with a confirm). The slug rides every action
// payload + the dot hash. The ensemble rides the card only when the header didn't hoist it.
function cardFor(member: Member, showCast: boolean) {
  const fields: { label?: string; value: string; tone?: CanvasTone }[] = [];
  const cast = showCast ? castLabel(member) : undefined;
  if (cast) fields.push({ label: "cast", value: cast });
  fields.push(capabilityField(member));
  // stripMd can empty a personality that was only markup, so the footnote is decided on
  // what would actually render, not on whether the field is set.
  const voice = truncate(stripMd(member.personality ?? ""), 160);
  return {
    title: member.name.trim() || "(unnamed)",
    dot: identityToneForSlot(member.identitySlot),
    pill: { label: member.role.trim() || "Member" },
    fields,
    reason: { text: purposeFor(member) },
    // The character's voice, only when the member was cast. The one line that
    // distinguishes a cast roster from a list of job titles.
    ...(voice ? { footnote: voice } : {}),
    actions: [
      {
        type: "enter-member",
        label: "Enter",
        glyph: "→",
        payload: { slug: member.slug },
      },
      // A lone modelPicker field is the host's solo-picker fast path: the button opens
      // the catalog popover and a pick dispatches straight through, no form. It also
      // makes the pin structural — setMemberModel rejects a model with no provider, and
      // two free-text boxes invited exactly that. The pin reads off the label, the
      // at-rest indicator now the card carries no model field.
      {
        type: "set-model",
        label: `Model — ${modelLabel(member)}`,
        glyph: "⚙",
        payload: { slug: member.slug },
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
// A cast scan legitimately runs to its 300s timeout (cast.ts DEFAULT_SCAN_TIMEOUT_MS),
// so the squad-cast boot card stalls later — past the scan timeout plus grace.
const CAST_STALL_S = 330;

// The seat being taken while a genesis runs — the squad casting boot screen in keelson's
// ink: stacked mono lines (the card's `stacked` presentation), each a dim `>` prompt with
// the readout on the green `ok` tone. Squad assigns the member's name from the cast theme
// during the turn, so the name (and the theme) stay "calibrating…" here and land with the
// real card; only the role is honest, and only when a starter archetype was authored. Past
// the stall window it flips to a warn card with a Dismiss. A `kind: "cast"` marker seats
// the whole-squad variant (scan liturgy, longer stall); a marker carrying `error` flips
// to the failed card at once — a known failure never waits out the stall.
function bootCard(pending: PendingGenesis, slot: number, now: number) {
  const isCast = pending.kind === "cast";
  if (pending.error) {
    return {
      title: "Casting",
      dot: "warn" as CanvasTone,
      pill: { label: "failed", tone: "warn" as CanvasTone },
      fields: [{ value: truncate(pending.error, 200) || "casting failed without a message." }],
      actions: [
        { type: "dismiss-genesis", label: "Dismiss", glyph: "✕", tone: "warn" as CanvasTone },
      ],
    };
  }
  const stallS = isCast ? CAST_STALL_S : GENESIS_STALL_S;
  const started = Date.parse(pending.startedAt);
  // An unparseable startedAt (a hand-edited marker) has no honest elapsed — present it as
  // stalled so it always carries a Dismiss, never a stuck "NaNs" card.
  const elapsedS = Number.isFinite(started)
    ? Math.max(0, Math.floor((now - started) / 1000))
    : stallS;
  if (elapsedS >= stallS) {
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
  if (isCast) {
    return {
      title: "Casting a squad…",
      dot: identityToneForSlot(slot),
      pill: { label: "casting", tone: "brand" as CanvasTone },
      stacked: true,
      fields: [
        line("scanning the repo…"),
        line("team: calibrating…"),
        line(`cast: calibrating… · ${elapsedS}s`),
      ],
    };
  }
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

// The hand-off row while a proposal awaits review: the Proposed-squad panel below
// carries Approve/Discard, so the roster says where the moment lives and offers
// nothing that could fork it.
function awaitingSection(count: number): Section {
  return {
    kind: "rows",
    items: [
      {
        glyph: "brand",
        text: `A proposed squad of ${count} member${count === 1 ? "" : "s"} awaits review below — Approve & scaffold to seat it, or Discard to cast again.`,
      },
    ],
  };
}

function liveRunsStrip(runs: readonly LiveRunElsewhere[]): Section {
  const displayNames = runs.map((run) => run.name ?? run.scopeId);
  return {
    kind: "actions",
    title: `● ${runs.length} live run${runs.length === 1 ? "" : "s"} in ${displayNames.join(", ")}`,
    items: runs.map((run) => {
      const displayName = run.name ?? run.scopeId;
      return {
        type: SELECT_PROJECT_ACTION,
        label: `Switch to ${displayName}`,
        glyph: "→",
        tone: "info" as CanvasTone,
        payload: { scopeId: run.scopeId },
      };
    }),
  };
}

// The framing line above the hero: copy belongs here, not on the action label —
// the button stays a verb. The root rides `trailing` when the selection carries one:
// a cast is a read of someone's repository, and this row is the last prose before the
// verb that starts it. No fallback — projects.json has no roots, so a selection without
// one (the literal DEFAULT_SCOPE_ID sentinel) says nothing rather than guessing.
function introSection(rootPath?: string): Section {
  const root = rootPath?.trim();
  return {
    kind: "rows",
    items: [
      {
        glyph: "brand",
        text: "One scan of the repo composes the team — you approve before anything is created.",
        ...(root ? { trailing: root } : {}),
      },
    ],
  };
}

// The defining verb: scan the SELECTED project and propose the team best suited to
// it. Scope follows the project picker — casting always targets the selected project,
// so the team lands in the same scope a no-arg run reads. The title names that project
// because the host's picker chip sits in the surface header, a different element in the
// opposite corner: without this the panel never says which repository it will read.
// `expanded` opens the mission inline — it is the one input that steers every seat the
// scan composes, and behind a disclosure click the default cast is always the missionless
// one, not because anyone chose that but because they never saw the box.
function castSection(projectName?: string): Section {
  const target = projectName?.trim();
  return {
    kind: "actions",
    title: target ? `Cast a squad from ${target}` : "Cast a squad from this repo",
    items: [
      {
        type: CAST_PROPOSE_ACTION,
        label: "Cast a squad",
        glyph: "✦",
        tone: "brand" as CanvasTone,
        expanded: true,
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
//
// NO identity tone rides a preset. The hue is not the role's, it is the member's, and
// it is assigned at WRITE time from cast order — squad_emit_member hands themedRecord
// `existing.length`, so on an empty roster every preset lands on slot 0 (id-blue) no
// matter which one was clicked. A per-preset hue here would be a promise the write path
// breaks on the first click, and it would outlive the click: identitySlot is persisted.
//
// `tabs`, not `wrap`: a wrap strip gives an OPEN form flex-basis:100%, dropping the chip
// that carries it onto its own row. A tabs form takes `order: 1` instead — the chips hold
// one row and the form opens full-width below the whole strip, so describe-own's position
// is reading order, not layout. The tagline rides `hint`, a hover tooltip.
function authorSection(): Section {
  return {
    kind: "actions",
    title: "or hire a member yourself",
    tabs: true,
    items: [
      ...GENESIS_STARTERS.map((s) => ({
        type: "author-archetype",
        label: s.name,
        glyph: "＋",
        hint: s.tagline,
        payload: { slug: s.slug },
      })),
      {
        type: "describe-own",
        label: "Describe…",
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

// The steady-state create verb, and the only one the board keeps: the one verb that
// GROWS the roster, against a teardown that lives in the region head's ⋯. It stays here
// rather than joining it because head verbs are menu-only by contract and this one's
// whole payload is the brief. `wrap` keeps the button compact at rest — a fields-carrying
// action only stretches once its form is open — so the foot costs one chip, not a bar.
// The archetype quick-starts and Cast live on the cold-start launchpad only: a populated
// squad grows one deliberate member at a time.
function hireSection(): Section {
  return {
    kind: "actions",
    wrap: true,
    items: [
      {
        type: "describe-own",
        label: "Hire a member…",
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

// Clamp only — no fallback. The one caller that wanted "(no charter)" was the charter
// field this pass deleted; the survivors each have their own honest empty case, and a
// charter-specific stand-in would be a lie on any of them.
function truncate(text: string, max = 120): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

// The ensemble label every seat shares, or undefined. Keyed on castLabel — exactly the
// string a card would render — because a roster can span two ensembles (themeSelectionOrder
// rolls to the next when the active one runs dry) and can gain a hand-authored member
// wearing none. An all-uncast roster folds to undefined through the same guard: its one
// label IS undefined.
function hoistedEnsemble(members: readonly Member[]): string | undefined {
  const labels = new Set(members.map(castLabel));
  return labels.size === 1 ? [...labels][0] : undefined;
}

// What the member is FOR. reason.text is min(1), so an empty excerpt would take the whole
// board down through expectView rather than degrading — the fallback is the line, not a
// missing key.
function purposeFor(member: Member): string {
  return (
    charterExcerpt(member.name, member.charter) ||
    "This member's charter doesn't say what it's for."
  );
}
