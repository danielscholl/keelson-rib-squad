---
title: Snapshot keys
description: Every rib:squad:* snapshot key, the workflow that publishes it, and what it renders.
sidebar:
  order: 3
---

Squad declares eight views, which split into two groups by how they are
published. **Five are workflow-bound**: each is the sole output of exactly one
workflow, and that workflow is the only writer for that key. Those five are the
regions of the Squad surface. **Three are registered imperatively** at boot and
written by a board action or a tool; they are drill-downs an operator opens on
top of the surface rather than regions laid out on it.

This page is the key contract on its own; for how the workflow-bound keys are
arranged into rows, and their refresh cadence, see [Surface](../surface/).

## The workflow-bound keys

| Key | Publishing workflow | Canvas title | Renders |
|---|---|---|---|
| `rib:squad:roster` | `squad-roster` | The Squad | One card per authored member: name, role, charter, status, pinned model/provider, and capability tags. |
| `rib:squad:cast` | `squad-cast` | Proposed squad | One card per member in the pending cast proposal, awaiting approve or discard. |
| `rib:squad:coordinator` | `squad-coordinator` | Run loop | The persisted coordinator ledger for the active run: goal, plan, findings, abandoned steps, and recent activity. |
| `rib:squad:runs` | `squad-runs` | Runs | One row per archived coordinator run in the selected scope, newest first. |
| `rib:squad:decisions` | `squad-decisions` | Decisions | The governed decision and lesson rows recalled from the project's memory ledger, capped at 50 items. |

## The imperatively registered keys

These three have no workflow behind them. `registerTools` is the only hook
handed the full rib context, so it registers their composers there and
unregisters them in `dispose`, which is what lets a re-boot rebind cleanly
against the new context's snapshot manager. Each composer reads module state
that a board action or tool set, and each writer returns an `open-canvas`
effect pointing at the key it just published. Before anything has written one,
its composer returns a valid empty view rather than failing.

| Key | Canvas kind | Written by | Renders |
|---|---|---|---|
| `rib:squad:run-detail` | `view` | the Runs board's `view-run` action | One archived run ledger, drilled into from the Runs list. |
| `rib:squad:report` | `html` | the `squad-report` action / the `squad_report` tool | The deterministic styled HTML report for one archived run, composed from the ledger with no agent turn. |
| `rib:squad:charter` | `view` | the Proposed squad card's `view-charter` action | One proposed seat's charter. A bench card carries the seat's purpose only, so the charter is what an operator reads to decide on the seat. |

`rib:squad:report` is the rib's only `html` canvas; the other seven are `view`
canvases rendering the board contract. It is read-only and ships no frame
actions, which is why any action arriving from a sandboxed canvas iframe is
rejected outright — see
[Tools and commands](../tools-and-commands/#board-action-verbs).

## Producer shape per key

The five workflow-bound keys split into two producer shapes: four
deterministic bash collectors, and one prompt-turn render fed by a memory
recall.

**`rib:squad:roster`, `rib:squad:cast`, `rib:squad:coordinator`,
`rib:squad:runs`** are each published by a bash node that reads a file
already on disk under the Squad data home and renders it as a board. None of
these nodes spends a paid agent turn. They differ only in what triggers a
refresh:

- `squad-roster` and `squad-runs` carry a cadence, so the surface polls them
  on a timer.
- `squad-cast` carries no cadence; it only changes when the
  `squad_propose_cast` tool or a board action (approve, discard) touches the
  proposal file, and those call sites republish it directly.
- `squad-coordinator` carries a cadence too, but it is also republished on
  every round by the `squad_coordinate` tool while a run is in progress, which
  is what lets the Run loop panel show a live freshness pulse mid-run.

**`rib:squad:decisions`** is published by `squad-decisions`, the one key on
this surface whose producer is not a bash collector. It has two nodes: a cheap
`members` bash node counts the seated roster first (so the render can gate its
cold-start shape), then a `render` node carries a declarative `memory: { recall }`
block (querying the project's governed ledger for "team decisions and lessons,"
capped at 50 items) and a prompt turn that renders the recalled rows into the
board. That recall-then-render shape
costs one paid agent turn per publish, which is why this key carries no
cadence on the surface: a heartbeat would spend a turn every cycle whether or
not anything changed.

## Writers versus this key

`rib:squad:decisions` is a read path only. Decisions are written to the
project's governed memory ledger by a separate workflow, `squad-decide`,
which performs a `memory: { writeback }` and publishes no snapshot key of its
own. Re-opening or refreshing the Decisions panel after a `squad-decide` run
is what surfaces the new row, since the panel has no cadence to pick it up on
its own.

## Related

- [Surface](../surface/): the layout that arranges the five workflow-bound keys
  into the Squad surface's header and rows, with cadence and collapsibility per
  region.
- [Workflows](../workflows/): the node-by-node shape of each publishing
  workflow listed above.
- [Tools and commands](../tools-and-commands/): the `squad_coordinate` and
  `squad_propose_cast` tools that republish `rib:squad:coordinator` and
  `rib:squad:cast` outside their normal cadence.
- [Governed memory](../../concepts/governed-memory/): why the decision
  read and write paths are split into two workflows instead of one.
