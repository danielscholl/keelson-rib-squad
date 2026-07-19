---
title: Run a coordinator loop
description: Launch the coordinator against a real project, watch the run-loop panel stream, and read what it reports once the run stops
sidebar:
  order: 4
---

The coordinator is Squad's standing loop: a manager turn plans a step, hands it to
one arm (a text dispatch, a confined code edit, or workflow authoring), watches what
came back, and repeats until the goal is met or it gives up. This guide walks
launching one against a real project, reading the Run loop panel while it streams,
and understanding what it reports at the end. For why the loop is shaped this way,
see [The coordinator loop](../../concepts/the-coordinator-loop/).

The coordinator is not the only way to put a task to the squad. A single question
fanned out to the whole roster runs through the Run loop panel's **Ask the team**
action (the `squad_dispatch` tool); a single confined edit assigned to one
code-capable member runs through the `squad_code` tool, which you reach by entering
that member (**Enter** on its roster card) or through the `squad-code-run` workflow.
Both are one-shot: no plan, no re-plan, no done gate. Reach for the coordinator when
the task needs more than one step decided as it goes.

## Point it at a project

Squad's surface is project scoped: the header carries the shared project picker
chip, and picking a project persists the scope every panel and tool key on
(roster, proposed squad, Run loop, Runs). The coordinator itself does not require
a project: omitting `project` falls back to whatever project is currently
selected in the surface, and only runs a fully reasoning-only loop when nothing
is selected at all. Reasoning-only means every step is a text dispatch, and any
manager request for `mode:"code"` is silently downgraded to a dispatch, because
there is no confined repository to edit. Point it at a real
[project](https://danielscholl.github.io/keelson/docs/concepts/projects/) (or
select one in the surface) when you want the coordinator to actually change
code, open a draft pull request, or run your test suite as part of the done
gate.

## Launch from the Squad surface

The **Run loop** panel is the promoted lead panel on the Squad surface, row one, a
single column beneath the roster header. Give it a task through the **Coordinate
on a task** action and it launches the `squad-coordinate-run` workflow, which calls
`squad_coordinate` once against whatever project is currently selected. This launch
keeps you on the Squad surface instead of jumping to the Workflows tab, so you can
watch the panel stream the run in place.

Surface-launched runs are deliberately short: `squad-coordinate-run` fixes
`maxRounds` at 6. It is a bounded, on-demand run kicked off from a board, not an
unbounded background job. For a longer leash, call the tool directly from chat with
an explicit `maxRounds`.

While a run is active, the panel head shows a live pulse so you can tell at a
glance that frames are still arriving, on top of its normal two-minute refresh
cadence.

## Launch from chat

Squad registers no slash commands, so there is no shortcut like `/coordinate`.
Call the tool directly:

```ts
squad_coordinate({
  task: "fix the flaky retry test and open a draft pull request",
  project: "keelson-rib-squad",
  maxRounds: 30,
})
```

| Field | Type | Default | Notes |
|---|---|---|---|
| `task` | string | required | The goal, in prose. |
| `project` | string | current selection | Id or name. Omit to fall back to the current selection; with nothing selected, the run is reasoning-only. An unresolvable name errors rather than running unscoped. |
| `members` | string[] | all active members | Restricts the team to these slugs. |
| `managerProvider` | string | harness default | Pins the manager's own planning turns to a provider. |
| `managerModel` | string | none | Only takes effect when `managerProvider` is also set. |
| `maxRounds` | number, 1 to 100 | 24 | The hard round ceiling. |
| `maxStall` | number, 1 to 20 | 3 | Consecutive stalled rounds before a re-plan. |
| `maxResets` | number, 1 to 20 | 2 | Re-plans allowed before the loop gives up. |
| `verify` | string[], up to 8 | auto-detected | Commands the done gate runs before it accepts `done`. |

If you omit `verify` and a project is bound, the tool reads that project's
`package.json` once, before the run starts, and runs whichever of `check`,
`typecheck`, `test` exist as scripts, via `bun run` if a bun lockfile is present or
`npm run` otherwise. Resolving the list up front means a code step can't edit
`package.json` mid-run to dodge the check. No `package.json`, no matching scripts,
or no project bound at all resolve to no verify commands: the gate is open, not
closed, when there is nothing to check.

The full schema for `squad_coordinate`, alongside `squad_dispatch` and
`squad_code`, lives in [Tools and commands](../../reference/tools-and-commands/).

## Watch it stream

Whichever way you launched it, the Run loop panel and the tool's own progress
render the same durable ledger. While a run is active, in order:

- **Pulse**: round, findings, stalls, and re-plans, as a stat strip — plus
  **Tokens**, the run's cumulative usage, once any has been recorded.
- **Goal**: the task text.
- **Plan**: the coordinator's current numbered plan, once it has one.
- **Findings**: the most recent accumulated facts.
- **Verification**: appears only once a done-gate command check has actually run.
- **Abandoned, do not resume**: steps swept off a plan the last time it re-planned, if any.
- **Team gaps, consider casting**: roster capability gaps the manager flagged, if any.
- **Minds**: one lane per member that has worked — its provider, how many turns
  it has taken, what they cost, and its latest act. Harness-side coordinator and
  gate entries stay out of it.
- **In flight**: a single card that appears only while a step is actively
  executing, naming the member, the action (`coding`, `authoring a workflow`, or
  `working`), and the instruction. It disappears the instant the step returns.
- **Transcript**: the most recent rounds, each tagged with what happened: a
  `dispatch` (plain text), a `code` (an edit, with file and line counts), a
  `workflow` (an authored DAG), or a `replan`/`verify` entry recording a gate
  decision.

A round only edits code or authors a workflow when the manager names a member with
the matching capability; anything else runs as a plain-text dispatch. Expect
several `verify` and `replan` entries in a coding run before a `done`: once code
has changed, the next `done` attempt has to clear an adversarial review and, if
configured, your verify commands before the loop is allowed to stop. A blocked
review or a failing check does not fail the run outright, it loops the manager back
for another round instead.

## Read the outcome

When the run reaches a terminal state, both the tool's chat reply and the panel
converge on the same summary. A finished run reads roughly like this:

```text
Coordinator: done after 5 round(s)

Summary: Fixed the flaky retry test by seeding the RNG and opened
a draft pull request.

Worked by: atlas (claude) coded · vera (copilot) contributed

Verification: passed, bun run check

Plan:
1. Reproduce the flaky failure
2. Seed the RNG in the test setup
3. Open a draft pull request

Steps:
- R1 atlas [code]: seeded the RNG in the retry test setup (touched 1 file, +4 -1)
- R2 vera: confirmed the fix reproduces cleanly across three consecutive runs
```

- **Summary** is the manager's own closing narrative.
- **Worked by** lists who actually produced code or dispatch output, by provider,
  and only appears once at least one step resolved a provider. Authoring a
  workflow is not credited here, only dispatch and code steps are.
- **Verification** only appears if a verify command ran at the done gate; a
  failing one names the command and its exit code instead of "passed".
- **Plan** is the coordinator's plan as of the moment it stopped.
- **Team gaps (consider casting a specialist)** lists any capability the manager
  flagged as missing from the roster during the run. It is a recommendation only:
  nothing here casts a member automatically. Follow up in
  [Cast a team](../cast-a-team/).
- **Steps** is the round-by-round trace of every dispatch, code, or workflow step
  that ran.

The status on the first line is one of seven terminal outcomes:

| Status | Means |
|---|---|
| `done` | The goal was met, and, for a coding run, review and verification both cleared. |
| `gave-up` | The loop exhausted its re-plan budget without resolving. |
| `max-rounds` | It hit the round ceiling before finishing. |
| `max-tokens` | Cumulative usage crossed the run's token budget. |
| `verification-failed` | A verify command kept failing at the done gate past its retry ceiling. |
| `change-quality-failed` | A change kept tripping the done gate's regression checks (a net-deleted test, a suppressed lint or type error) past its retry ceiling. |
| `aborted` | The run was stopped — by the operator, or by reconciling a ledger whose driver died without writing a verdict. |

`aborted` is a real verdict, not an absence of one: a stopped run has settled,
and it archives like any other terminal status.

The one outcome that is *not* terminal is `error`, when a manager turn itself
throws rather than reaching a verdict. It leaves the ledger active. Launching the
identical task against the identical project again resumes it from where it left
off, rather than starting over, as long as nothing has since finished or reset it.

## Where archived runs go

All seven terminal statuses above get archived, `aborted` included; only an
errored run stays as the live, resumable ledger instead. Archiving writes the entire ledger,
facts, transcript, plan, verification record, everything, as one JSON file under
the scope's data home, keyed by the run's creation time. Re-finishing a resumed run
overwrites that same file rather than piling up duplicates.

The **Runs** panel (row two of the Squad surface) and the `squad_runs` tool both
read that directory, but they only show a coarse index: id, status, round, task,
and when it last updated, one line per run, newest first. The full facts and
transcript stay in the archived file itself; open it directly if you need more than
the index gives you. [Data on disk](../../reference/data-on-disk/) has the exact
paths.

## Related

- [The coordinator loop](../../concepts/the-coordinator-loop/): why the loop is shaped as plan, delegate, gate, repeat.
- [Tools and commands](../../reference/tools-and-commands/): the full `squad_coordinate` schema alongside `squad_dispatch` and `squad_code`.
- [Data on disk](../../reference/data-on-disk/): where the ledger and archived runs live on disk.
- [Cast a team](../cast-a-team/): build the roster the coordinator draws from.
