---
title: Surface
description: The exact layout of the Squad surface, the workflow behind every region, and why the run loop panel is promoted and live.
sidebar:
  order: 2
---

Squad is a Keelson rib. It contributes one nav surface and the snapshot keys
that fill it. This page is the contract for that surface: the header, every
row and column, the workflow bound to each, and its refresh cadence.

The surface has a stable identity:

| Field | Value |
|---|---|
| `id` | `squad` |
| `title` | `Squad` |
| `subtitle` | `Author members · cast a squad · assign work` |
| `projectScoped` | `true` |

Because the surface is project-scoped, the host renders its shared
project-picker chip in the surface header. Picking a project there dispatches
Squad's `select-project` action, which is the scope every panel and tool on
the surface keys on.

## Layout

The surface declares a header and three rows below it. Every region binds a
snapshot key and a workflow that produces it.

| Region | Key | Workflow | Cadence | Live | Collapsible |
|---|---|---|---|---|---|
| Header | `rib:squad:roster` | `squad-roster` | 120000 ms | no | no |
| Row 1, column 1 | `rib:squad:coordinator` | `squad-coordinator` | 120000 ms | yes | yes |
| Row 2, column 1 | `rib:squad:runs` | `squad-runs` | 120000 ms | no | yes |
| Row 2, column 2 | `rib:squad:cast` | `squad-cast` | none | no | yes |
| Row 3, column 1 | `rib:squad:decisions` | `squad-decisions` | none | no | yes |

Only the header (Crew) is always visible. The four content panels — Run loop,
Runs, Proposed squad, and Decisions — set `hideWhenEmpty: true`, so they collapse
away on a cold start when there is no seated squad and no ledger or proposal
content. Row 2 holds Runs and Proposed squad side by side when they have content.
Row 3 holds Decisions on its own.

### Header: Crew

`rib:squad:roster` is bound to `squad-roster`, a deterministic bash collector
that reads the members authored under the data home and publishes them as a
board. It carries a 120000 ms cadence so a freshly opened surface populates on
its own and stays current without an operator refresh. It is never
collapsible: the roster is the anchor for every other panel on the surface.

### Row 1: Run loop (promoted, live)

`rib:squad:coordinator` is bound to `squad-coordinator`, a deterministic bash
collector that renders the persisted coordinator ledger as a board (goal,
plan, findings, abandoned steps, recent activity). It is the only region in
its row, which promotes it to a lead panel: an operator hands the squad a task
from this panel's composer and watches the coordinator work without leaving
the surface.

Two things distinguish it from every other region:

- **It carries `cadenceMs: 120000` like the collectors**, so it auto-loads on
  open instead of sitting behind a manual "Load" placeholder.
- **It sets `live: true`.** While the `squad_coordinate` tool's loop is
  running, it republishes this key on every round; `live` tells the panel head
  to show a freshness pulse while frames are actively streaming, so an
  operator watching the surface can see the run is alive without reading the
  transcript. No other Squad region sets `live`, because no other region is
  fed by a long-running, round-by-round loop; the collectors behind the other
  panels each run once and return.

### Row 2: Runs and Proposed squad

`rib:squad:runs` is bound to `squad-runs`, a deterministic bash collector that
renders the archived coordinator run ledgers for the selected scope, newest
first. It carries the same 120000 ms cadence as the roster, so a run that just
finished appears in the history without a manual refresh.

`rib:squad:cast` is bound to `squad-cast`, a deterministic bash collector that
renders the pending cast-proposal file as a board. It carries **no cadence at
all**, because the proposal only changes on a propose, approve, or discard
action; a heartbeat here would poll a file that is idle between those actions.
The `squad_propose_cast` tool refreshes this key itself once a scan finishes,
so the panel is current the moment there is something new to show. It is
collapsible but starts expanded when content exists; with `hideWhenEmpty: true`,
an empty proposal does not clutter the row.

### Row 3: Decisions

`rib:squad:decisions` is bound to `squad-decisions`, which first runs a
declarative memory recall (querying the project's governed ledger for team
decisions and lessons, capped at 50 items) and then a prompt turn that renders
the recalled rows as a board. This panel carries **no cadence by design**: unlike
the bash collectors, rendering it costs one paid agent turn, and a heartbeat
would burn turns while the panel sits open and idle. The client re-fetches it
on open and on focus instead, so re-opening the panel after recording a
decision (via `squad-decide`) is what shows the new row.

## Why the run loop is the one live panel

Every other panel on the surface is backed by a cheap, deterministic
collector: it reads a file and returns immediately, so a fixed cadence is
enough to keep it fresh. The coordinator loop is different. `squad_coordinate`
can run for many rounds, delegating one step at a time to the roster and
republishing the ledger as it goes. Promoting it to its own row and marking it
`live` gives that one long-running process a panel that visibly reflects
"still working" versus "idle", which the on/off nature of the other boards
does not need.

## Related

- [Snapshot keys](../snapshot-keys/): the `rib:squad:*` keys behind every
  region on this surface.
- [Workflows](../workflows/): the node-by-node shape of `squad-roster`,
  `squad-coordinator`, and the other workflows bound above.
- [Tools and commands](../tools-and-commands/): the `squad_coordinate` tool
  that drives the Run loop panel's live updates.
- [The coordinator loop](../../concepts/the-coordinator-loop/): why the
  coordinator runs round by round instead of returning in one turn.
