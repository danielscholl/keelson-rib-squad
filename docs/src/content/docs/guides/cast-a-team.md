---
title: Cast a team
description: Compose a squad's roster by authoring one member from a brief or auto-casting a whole team from a repository scan, then review, approve, or retire it.
sidebar:
  order: 3
---

A squad's roster starts empty. There are two ways to fill it: author one member
at a time from a brief, or point Squad at a project and let it scan the
repository and propose a whole team at once. Both paths end at the same place,
a directory of files under the squad's data home and a card on the Roster
board. This guide walks both, plus how to review an auto-cast proposal and how
to retire a member (or the whole roster) when you are done with it.

Everything here is scoped to whichever project is currently selected in the
Squad surface's project picker. Switching projects switches the roster you are
editing.

## Author one member from a brief

**Genesis** is a workflow, not an in-process function, so a run is
inspectable: one prompt turn reads your brief, decides a name and a short role
title, writes a Markdown charter, and calls a single write tool exactly once
to persist the result. There are two ways to start it.

From the roster's cold-start screen, pick a starter archetype or describe your
own:

| Archetype | Role | Good for |
|---|---|---|
| Lead | Tech Lead | Direction, scope, and trade-off calls |
| Engineer | Engineer | Implementation, debugging, and design |
| Reviewer | Reviewer | Correctness, clarity, and risk review |
| Tester | Tester | Coverage, edge cases, and regressions |

Each archetype is a pre-written brief, not a baked charter: picking "Reviewer"
launches genesis with a brief describing a code reviewer for this repo, and
the turn writes a fresh charter grounded in whatever it finds. "Describe &
author" takes a freeform brief instead (capped at 2,000 characters), for a
member the four archetypes do not cover.

From the CLI, run the workflow directly:

```bash
keelson workflow run squad-genesis --arguments "a security-minded reviewer who flags anything touching auth or secrets"
```

The turn ends by replying with exactly one line, `Authored <name> (<slug>)`.
The roster's own collector reflects the new member on its next run rather
than waiting for the surface's refresh cadence, so the card usually appears
within moments.

Genesis writes five files under `members/<slug>/`: `member.json` (the
roster record), `charter.md` (the founding identity the chat prompt is built
from), and seeded `memory.md`, `rules.md`, and `log.md` documents the member
fills in over time. A slug collision fails the run closed rather than
overwriting an existing member's charter. For what each file is for and how a
member's chat prompt is composed from them, see
[Cast and roster](../../concepts/cast-and-roster/).

Once a scope has at least one member, the cold-start archetypes and the "Cast
a squad" scan (below) both drop away: only "Add a member" (describe your own)
stays reachable. Re-casting an already-populated squad is confusing enough
that it is not offered; switching to an empty project is the way back to a
fresh cast.

## Auto-cast a team from a repository scan

Casting from a scan composes a whole team in one pass: it reads the selected
project's languages, frameworks, layout, docs, tests, and CI, then proposes a
small set of members suited to what it finds. Start it from the roster's
cold-start screen with "Cast a squad for the selected project", optionally
naming a mission to focus the team (also capped at 2,000 characters), or from
the CLI:

```bash
keelson workflow run squad-cast-scan --arguments "prioritize test coverage and CI reliability"
```

The scan itself is one confined, read-only agent turn: it can `Read`, `Glob`,
and `Grep` the project root, nothing else, so it cannot edit or run anything
in your repository. The turn is bounded to five minutes and aborts cleanly if
it runs long, rather than leaving the action hanging.

The proposal caps at six members. If the model proposes more, the extra
members are dropped and a note explaining the cap is attached to the
proposal, never silently. When the harness has more than one coding provider
registered, the scan also leans on that: it is told to pin planning and lead
roles toward a stronger reasoning model and coding and review roles toward a
strong coding model, favoring an overpowered pin over an underpowered one.
See [Mix providers](../mix-providers/) for how a pin like that behaves once
the member exists.

### Review the proposal

The scan publishes to the Proposed squad board, one card per proposed member:
a name, a role, the tools it would carry (or "text-only" if none), any
provider pin, and a charter excerpt so you can judge the member before it
becomes real. Nothing is written to the roster yet. From here you have two
choices:

- **Approve & scaffold** authors every proposed member as a real chat agent
  and clears the proposal. An existing member with the same name is kept,
  not overwritten, so approving twice is safe. Members are scaffolded from
  the same casting path genesis uses, so a themed name (if theming is
  active) and an identical file layout apply here too.
- **Discard proposal** drops the pending proposal without touching the
  roster. You can cast again from the roster afterward.

Both actions are confirm-guarded before they run.

## Retire a member, or the whole roster

Retiring a member is permanent: it deletes that member's directory, its
charter, and every file in it, then drops the card from the roster. There is
no soft "inactive" state reachable from the board, only the delete. Use
"Retire member…" on that member's card; the confirmation names the member and
states plainly that this permanently deletes it.

To clear a scope's roster in one action, use "Retire all" in the roster's
Manage section. The confirmation names the exact count of members about to be
deleted, so you know what you are committing to before you confirm.

## Related

- [Cast and roster](../../concepts/cast-and-roster/): why a member is shaped
  the way it is, and what genesis writes on disk.
- [Run a coordinator loop](../run-a-coordinator-loop/): what to do with a
  roster once it exists.
- [Mix providers](../mix-providers/): pinning a member to a specific model
  and provider, by hand or via an auto-cast proposal.
- [Surface](../../reference/surface/): the Roster and Proposed squad panels
  this guide drives.
