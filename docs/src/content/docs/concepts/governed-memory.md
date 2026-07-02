---
title: Governed memory
description: Squad keeps two separate memory stores, a shared decision ledger that is evidence-default and reviewable, and each member's own private notes, tied together by a reflection pass that turns a finished run into a durable decision.
sidebar:
  order: 5
---

A dev squad needs two different kinds of memory, and Squad keeps them apart on
purpose. A member needs to remember how it personally does its job: its own
notes on a project, its own habits, without those private notes leaking into
what every other member or every future run treats as team knowledge. And the
team needs one shared record of what it actually decided, trustworthy enough
to recall into the next run, but never trustworthy enough to auto-inject as a
standing instruction without a human looking at it first. Squad keeps these as
two entirely separate stores, and there is no code path between them: writing
to one never touches the other.

## The shared decision ledger

The ledger is the same governed memory store the Keelson harness exposes to
every rib, not something Squad invents. See [Memory and
state](https://danielscholl.github.io/keelson/docs/concepts/memory-and-state/)
for how the host stores it and how review works in general; this page covers
only what Squad does with that seam.

Squad reads and writes the ledger scoped to the currently selected project, in
two different ways:

- **Through a workflow, on demand.** The Decisions panel on the Squad surface
  renders by running a workflow that recalls up to 50 recent team decisions
  and lessons and turns them into a board. The Record a decision action on
  that same panel, a one-line summary plus the fuller context, runs a second
  workflow that writes one new row to the ledger.
- **Directly, from inside a coordinator run.** A run loop recalls from the
  ledger before it plans its first round, and writes back to it once, at the
  end, through the reflection pass described below. That path doesn't go
  through either workflow above; it calls the same underlying memory seam
  straight from the rib's own code.

:::note[Same ceiling, either path]
It doesn't matter which of these two paths writes the row: every write Squad
makes into the ledger is stamped evidence, not instruction. It always arrives
with `generated` provenance and a `pending` review status, and the host store
enforces that ceiling itself regardless of what the write claims. Nothing
Squad writes can be auto-injected into a future turn or treated as a standing
instruction until a human promotes it through the harness's own review queue.
A decision the ledger holds is always available to recall, but it never
becomes something an agent is compelled to obey just because Squad wrote it.
:::

Squad does not expose a tool that reads the ledger on demand. The only way to
see what's in it is to open the Decisions panel, or run its workflow yourself,
and that costs one paid agent turn to render, which is why the panel carries
no refresh cadence. The client just re-fetches it when you open or focus it.

## A member's private memory

Each member also keeps its own memory, and it is nothing like the ledger: a
handful of plain markdown files on disk, one directory per member, never
touching the SQLite-backed ledger, its provenance model, or its review queue.
A member's directory holds its charter, a rules document, a working
`memory.md`, and a running `log.md`. (See [Data on
disk](../../reference/data-on-disk/) for the exact layout.)

You, or the member itself mid-turn, write to this store with the
`squad_remember` tool, which takes a member's slug, some text, and a target:
`log` appends one timestamped line and is the default, `memory` overwrites the
member's working-memory document wholesale. The write fails closed: an unsafe
slug, a member that doesn't exist, or text over the size cap leaves the prior
file untouched rather than partially applying. There's no provenance tag, no
review status, and no lifecycle on any of it; the rib's own size cap is the
only guard in front of it. This store is explicitly not a substitute for the
ledger: recording something through `squad_remember` doesn't put it anywhere
the rest of the squad can recall it from.

Reading it back costs nothing. Every turn a member runs, whether you enter it
for a direct chat, dispatch it a task, or assign it code, composes that
member's system prompt from the same charter, `memory.md`, `rules.md`, and
recent `log.md`, so a member doesn't start each turn amnesiac about its own
prior work.

| | Shared decision ledger | A member's private memory |
|---|---|---|
| Storage | Host-owned SQLite memory store | Plain markdown files under the rib's data directory |
| Scope | The selected project, visible to every member and every run | One member, visible only to that member |
| Provenance and review | Always `generated`, always `pending`; evidence, never an auto-injected instruction | None; there is no review concept for this store |
| How it grows | The Record a decision action, or the coordinator's own reflection pass | The `squad_remember` tool, or editing the files directly |
| Read cost | Rendering it is a paid agent turn | Free; folded into the system prompt of every turn that member runs |

## The reflection pass: a run becomes a decision

Reflection is what turns a finished coordinator run into that one ledger row
you'll see on a future recall, and it only fires when a run ends in genuine
completion, not when it gave up or a change-quality check failed. When it does
fire, it runs two passes, strictly in this order.

**First, the shared decision.** A dedicated scribe turn looks at the run's
outcome against the lessons the ledger already holds for this project, and
decides one of three things: record one new, distilled decision (a short
headline and a fuller lesson, written so it doesn't just repeat what the
ledger already said); write nothing at all, because the run didn't produce
anything worth generalizing (this abstain path exists on purpose, since a
confused or thrashing run would otherwise pollute the memory the next run
recalls from); or, if that scribe turn itself fails or times out, fall back to
recording the run's own summary and its most recent findings directly, so a
completed run still leaves some trace even without a working distillation
step. Every write here is deduplicated against the exact same task and
outcome, so re-running the same thing twice doesn't double the ledger.
Whatever happened, the run's own transcript gets a one-line note, something
like "recorded a distilled decision" or "run yielded no durable decision," so
you can see what reflection did without opening the ledger at all.

**Second, private reflection, one turn per member.** Only after the shared
write is decided does Squad look at every member that actually did
substantive work in the run, dispatched a task or assigned code (authoring a
reusable workflow doesn't count; minting a DAG isn't the member learning a
fact about its own work). Each such member gets one more turn that looks at
what it just did against what it already remembered, and rewrites its own
`memory.md` if it has something worth keeping. If that turn fails, times out,
or comes back empty, the member's existing memory is left exactly as it was
rather than erased. This half never touches the shared ledger; it's the same
private store described above, just written automatically by the coordinator
when the run closes, rather than by you or the member calling
`squad_remember` yourself.

Why recalling from the ledger changes what the next run does, rather than the
ledger just being a growing log, is covered in [Memory that
compounds](../../design/memory-that-compounds/); this page stops at what gets
written and where.

## How you interact with each

- **To read team decisions,** open the Decisions panel on the Squad surface,
  or run its workflow yourself.
- **To record one by hand,** use the Record a decision action on that same
  panel: a one-line summary and the fuller context. Squad has no
  slash-command shortcut for this, it registers no slash commands at all, so
  the board action and a direct workflow run are the two ways in.
- **To let the ledger grow on its own,** run a coordinator loop from the Run
  loop panel; reflection happens for you at the end without a separate step.
- **To read or shape a member's own memory,** call the `squad_remember` tool
  in a turn with that member, or open its `memory.md` and `log.md` files
  directly. There's no board action for this, since it's the member's own
  notes rather than something the surface curates.

## Related

- [The coordinator loop](../the-coordinator-loop/): the loop that recalls
  from the ledger before it plans and reflects into it when it's done.
- [Memory that compounds](../../design/memory-that-compounds/): why recall,
  not storage, is the point of the ledger.
- [Tools and commands](../../reference/tools-and-commands/): the exact
  `squad_remember` and `squad_coordinate` contracts.
- [Data on disk](../../reference/data-on-disk/): the exact files and paths
  each memory layer uses.
