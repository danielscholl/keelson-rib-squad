---
title: Workflows
description: All 11 workflows the Squad rib contributes to the catalog, what triggers each one, and which board it publishes.
sidebar:
  order: 4
---

Squad contributes 11 workflows to the catalog, all defined in code in the rib's
`contributeWorkflows` hook, so there are no YAML files to edit. Six are
deterministic: four bash collectors that read the data home and publish a
board, plus one bash node paired with a declarative memory writeback. Five are
single prompt turns that call exactly one tool.

Each workflow ships a description in the `Use when / Triggers / Does / NOT
for` shape, so the catalog and the surface render it scannably and a reader
can tell at a glance what a workflow is for and what it is not.

## The 11

| Workflow | Kind | Snapshot key | Publishes a board |
|---|---|---|---|
| `squad-roster` | bash collector | `rib:squad:roster` | yes |
| `squad-cast` | bash collector | `rib:squad:cast` | yes |
| `squad-coordinator` | bash collector | `rib:squad:coordinator` | yes |
| `squad-runs` | bash collector | `rib:squad:runs` | yes |
| `squad-genesis` | prompt turn | none | no |
| `squad-cast-scan` | prompt turn | none | no |
| `squad-coordinate-run` | prompt turn | none | no |
| `squad-dispatch-run` | prompt turn | none | no |
| `squad-code-run` | prompt turn | none | no |
| `squad-decide` | bash + memory writeback | none | no |
| `squad-decisions` | memory recall + prompt turn | `rib:squad:decisions` | yes |

## The collectors

Four workflows are deterministic bash collectors. Each has a single `bash`
node (`collect`) that shells a `bin/collect-*.ts` script with the resolved
data home baked into the command, reads the data home off disk, and emits a
board on stdout. No agent turn runs, so a refresh is free. Each carries an
`output_schema` of `{ type: "object", required: ["view", "sections"] }`,
binds its output to a fixed snapshot key, and validates fail-closed with
`expectView(<key>, "board")`: a script that emits something that isn't a
`board` view fails the run rather than publishing junk.

| Workflow | Use when | Triggers | Does | NOT for |
|---|---|---|---|---|
| `squad-roster` | You want to see the members of the squad. | "show the roster", "list members", "who is on the team" | Reads the authored members from the Squad data home and publishes a roster board (one card per member) to the header. | Creating members (`squad-genesis`) or retiring one (a roster board action). |
| `squad-cast` | You want to review the squad a scan proposed for a project. | The roster's "Cast a squad" action, opening the Proposed squad panel. | Reads the pending cast proposal from the data home and publishes a "Proposed squad" board (one card per proposed member). | Scanning a project (`squad-cast-scan`) or scaffolding the members (the Approve action). |
| `squad-coordinator` | You want to watch the squad's coordinator run loop. | Opening the Run loop panel, after a `squad_coordinate` run. | Reads the persisted coordinator ledger from the data home and publishes a "Run loop" board (goal, plan, findings, abandoned steps, recent activity). | Starting a run (the `squad_coordinate` tool). |
| `squad-runs` | You want to see the squad's past coordinator runs. | Opening the Runs panel. | Reads the archived run ledgers for the selected scope and publishes a Runs board, newest first. | Starting a run (the Run loop "Coordinate on a task" action) or watching the current one (the Run loop panel). |

`squad-roster` binds `bindSnapshotKey: ROSTER_KEY`, `squad-cast` binds
`CAST_KEY`, `squad-coordinator` binds `COORDINATOR_KEY`, and `squad-runs`
binds `SQUAD_RUNS_KEY`. See [Snapshot keys](../snapshot-keys/) for the full
key list. On the surface each of these four carries a `cadenceMs` of
`120000`, so its panel re-collects every two minutes on its own; see
[Surface](../surface/) for the region-by-region cadence table.

## The prompt-turn workflows

Five workflows are a single `prompt` node that calls exactly one tool, all
launched from a surface action rather than run ad hoc. Each sets
`fail_on_tool_error: true`: a workflow prompt node has every rib tool off by
default, so each of these opts in to its one write seam by name via
`allowed_tools`, and a failed tool call fails the whole run instead of
reporting success with nothing done. None binds a snapshot key: each either
writes files that another workflow's collector reflects on its next run, or
calls a tool that refreshes its own panel directly.

| Workflow | Use when | Triggers | Does | NOT for |
|---|---|---|---|---|
| `squad-genesis` | You want to create a new squad member. | "add a member", "new teammate", `/workflow run squad-genesis <brief>` | One agent turn reads a brief, authors a charter, and persists the member by calling `squad_emit_member` exactly once. | Retiring a member or editing an existing one. |
| `squad-cast-scan` | You want to auto-compose a squad for the selected project. | The roster's "Cast a squad" action. | One agent turn calls `squad_propose_cast` to run a confined read-only repo scan and publish a proposal to approve or discard. | Authoring one member (`squad-genesis`) or approving a proposal (the Proposed squad board actions). |
| `squad-coordinate-run` | You want to hand the squad a task and watch it run the plan, delegate, observe loop. | The Run loop panel's "Coordinate on a task" action. | One agent turn calls `squad_coordinate` (rounds capped low, at 6, because this is a bounded surface-launched run) against the selected project; progress streams into the Run loop panel as it goes. | A single one-off question (`squad-dispatch-run`) or one direct code edit (`squad-code-run`). |
| `squad-dispatch-run` | You want to ask every squad member one question at once. | The Run loop panel's "Ask the team" action. | One agent turn calls `squad_dispatch` to fan the question out to the whole active roster and synthesize the replies. | A multi-step run (`squad-coordinate-run`) or editing the repo (`squad-code-run`). |
| `squad-code-run` | You want to assign a confined coding task to one code-capable member. | A roster card's "Assign a code task" action. | One agent turn calls `squad_code` so the named member edits the selected project directly (Read/Glob/Grep/Edit/Write/Bash, confined to the project root, no merge or force-push). | Text-only reasoning (`squad-dispatch-run`) or a whole multi-step run (`squad-coordinate-run`). |

`squad-genesis` writes a member's files under the data home; `squad-roster`
reflects the new member the next time its collector runs, not because
`squad-genesis` refreshed anything itself. `squad-cast-scan`,
`squad-coordinate-run`, `squad-dispatch-run`, and `squad-code-run` each call a
tool that refreshes its own panel (the Proposed squad board, or the Run loop
board round by round) as a side effect of the tool call, so none of these
four needs a `bindSnapshotKey` either.

## squad-decide and squad-decisions

These two workflows are the write and read sides of the same governed
decision ledger, and neither runs a full agent turn for its cheap half.

`squad-decide` is the write path. Its one `bash` node is a constant
`echo` (no paid turn, and the command body never interpolates the operator's
input, so a crafted summary can't reach the shell) paired with a declarative
`memory: { writeback }` block that the executor runs server-side after the
node, writing one `decision` row to the project's governed memory ledger from
two operator-supplied inputs, `summary` and `content`. The executor stamps
this write's provenance as `"generated"`; a rib can never mint a higher-trust
provenance than that for a memory row it did not personally witness.

`squad-decisions` is the read path. Its one node carries a declarative
`memory: { recall }` block that queries for team decisions and lessons
(capped at 50 items) and runs first, substituting the recalled rows into the
node's prompt; the prompt then renders them as a board. This is the one
collector-shaped workflow in the catalog that costs a paid agent turn on
every render, because turning recalled memory rows into a board is model
work, not a deterministic transform. That is why the Decisions region of the
surface carries no refresh cadence: a heartbeat would burn a turn every tick
while the panel sits open and idle. The client re-fetches it on open and on
focus instead.

| Workflow | Use when | Triggers | Does | NOT for |
|---|---|---|---|---|
| `squad-decide` | The squad reaches a decision worth remembering across sessions. | "record a decision", "we decided", the Decisions panel's Record action | Writes one governed `decision` row to the project memory ledger from `{ summary, content }` (server-side, evidence-default provenance). | A member's private note (`squad_remember`) or viewing the ledger (`squad-decisions`). |
| `squad-decisions` | You want to see the squad's governed decisions and lessons. | "show decisions", "what have we decided", opening the Decisions panel | Recalls decision and lesson rows from the project memory ledger and renders them as a board. | Recording a decision (`squad-decide`) or a member's private memory (`squad_remember`). |

`squad-decisions` binds `bindSnapshotKey: DECISIONS_KEY` and validates with
`expectView(DECISIONS_KEY, "board")`; `squad-decide` binds no key, since it
writes a ledger row rather than a board.

## A twelfth path that is not a bundled workflow

The coordinator loop can also delegate a step to a member with an
instruction to author a reusable Keelson workflow DAG, when the manager's
directive sets `mode: "workflow"`. That authored DAG is validated
structurally and persisted as a file under the data home for the operator to
inspect and run; it is not one of the 11 workflows above, it is an artifact
the coordinator produces, and every one of the 11 above ships with the rib
rather than being generated at run time. See
[The coordinator loop](../../concepts/the-coordinator-loop/) for how that
authoring option fits into a round.

## Related

- [Surface](../surface/): the region, cadence, and board every one of these workflows feeds.
- [Snapshot keys](../snapshot-keys/): the full `rib:squad:*` key list, including the ones bound above.
- [Tools and commands](../tools-and-commands/): the `squad_emit_member`, `squad_propose_cast`, `squad_coordinate`, `squad_dispatch`, and `squad_code` tools these prompt-turn workflows call.
- [The coordinator loop](../../concepts/the-coordinator-loop/): how a standing run decides between a dispatch, a code turn, and authoring a workflow.
