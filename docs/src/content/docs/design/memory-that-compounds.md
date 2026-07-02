---
title: Memory that compounds
description: Why the coordinator recalls prior decisions into every run before it works, and why it writes new ones only once, at a run's close, instead of continuously
sidebar:
  order: 4
---

A ledger nothing ever reads back is not memory, it is a log. It can tell you what
happened after the fact, but it cannot change what happens next. The coordinator's
governed decision ledger is built to be read back: every run opens by pulling prior
decisions into its own plan and into the instructions its members execute, and it
closes by adding, at most, one new considered thing to that same ledger. Recall
first, then work, then one write. That ordering is the whole design.

## Decision

The coordinator recalls before it plans, and reflects only once, at the close of a
run that actually finished. `recallGrounding` runs at the very top of the loop,
before the first round starts: it pulls up to eight of the project's most recent
governed decisions and lessons and folds their content into the manager's own
plan-and-decide prompt, then prefixes that same recalled set onto every instruction
sent to a dispatched or code-capable member. Nothing is re-queried mid-run; the
whole run works from one stable snapshot of what the team already knows.

Reflection runs at the opposite end, and only when the run reaches a genuine
completion, not a give-up and not a change-quality failure. One turn distills the
run into a single durable decision (or explicitly abstains), and only after that
shared write is settled does each member that did real work get its own turn to
fold what it learned into its private memory. Both halves are fail-soft: a memory
hiccup degrades to no memory, never to a broken run.

## Recall has to reach the hands, not just the plan

A recalled decision that only reaches the manager is nearly as inert as no recall
at all, because the manager delegates and a dispatched or coding member never sees
the manager's own context, only the instruction it was handed. So the same recalled
set lands in two places: once in `coordinatorPrompt`, framed as "prior decisions and
lessons, honor them," and once prefixed onto every member instruction via
`withTeamMemory`, framed as "the team's memory, honor and build on it, don't
re-derive or contradict it." The plan gets shaped by what earlier runs worked out,
and so does the work itself.

Recall also surfaces the recalled item's actual content, not just its `summary`
headline, up to a generous per-item excerpt. A headline announces that a decision
exists; the content is what makes a decision actually usable at the point it is
supposed to change behavior. Recall is capped at eight items precisely so this
fuller excerpt fits a turn without crowding out the task itself.

## Store-only memory never compounds

A system that only ever appends decisions and never recalls them is easy to build:
write a row when something notable happens, done. But nothing about the next run
changes because of it. The next run has no way to prefer a prior answer over
rediscovering the same fact from a blank slate, so the ledger becomes an audit
trail, a place to check after the fact, not an input the coordinator's own plan
depends on. Squad's ledger is deliberately not that. The recall-then-work-then-write
loop means a decision recorded on one pass measurably changes what the next pass
does: the manager plans around it, the members execute with it in view, and the
distillation turn at the next close is explicitly told what is already known so it
records a delta instead of restating the same thing again. Memory that is never
recalled just accumulates. Memory that is recalled compounds.

## Reflection happens once, not continuously

Reflecting after every turn would spend a paid turn per turn instead of one per
completed run, and it would reason over a run that has not finished making up its
mind: a decision distilled from round three of a run that keeps replanning through
round nine is not yet the run's actual outcome. Closing the loop once, when the
task is genuinely done, lets the distillation turn look at the whole arc: the final
summary, the run's recent findings, and what the team already knew going in, and
ask the narrower and more durable question of what a *different*, future run on
this project should be told. That is a smaller, better-considered set than anything
a mid-run checkpoint could produce, and it costs exactly one turn regardless of how
many rounds the run took to get there.

The gate is also outcome-aware. Reflection is skipped entirely on a give-up or a
change-quality failure. A run that did not land is not a source of durable lessons
about the project, it is a source of noise about a bad attempt, and letting it write
to the same ledger the next run recalls would ground that next run in a failure
rather than in knowledge.

## The pollution gate: distillation first, abstain is a legitimate answer

At close, the coordinator does not write the run's raw summary straight to the
ledger. It first runs one confined, text-only turn (a dedicated "scribe" prompt,
separate from the manager's own voice) that is shown the task, the final summary,
the run's most recent findings, and what is already recalled in memory, and is told
plainly that it curates shared team memory, it does not summarize the run. That
turn ends with exactly one instruction: record one decontextualized decision or
lesson, or skip.

Skip is not a failure mode, it is the intended outcome for a run that thrashed,
stayed shallow, or simply produced nothing generalizable. Writing something from
every run regardless of whether it taught the team anything would pollute the exact
ledger the next run grounds itself in, so an honest abstain leaves memory unchanged
on purpose. Only when the distillation turn itself is unavailable (it failed,
timed out, or returned nothing parseable) does the coordinator fall back to writing
the run's raw outcome and its most recent findings as the decision, so a completed
run still records something even when the scribe pass could not run. A malformed
"record" directive (an empty headline or lesson) is treated the same as
unavailable, not as an abstain: uncertainty falls back to the raw write, only an
explicit skip suppresses one.

Every write, distilled or raw, is content-addressed: the write's idempotency key is
derived from a hash of its own content, scoped to the project. An identical
task-and-outcome re-run dedupes at the ledger instead of adding a duplicate row, so
the compounding is genuine accumulation of new knowledge, not noise from repeated
runs landing the same lesson twice.

## Two closes, deliberately ordered

A run's close touches two entirely different stores, and the order between them is
not incidental. The shared governed decision, the one every future run on the
project can recall, is distilled and written first. Only after that write has
settled does each member that contributed real work get its own reflection turn
over its own private `memory.md`. Sequencing it this way means the member half's
abort check, which runs after the shared distillation turn, still correctly
suppresses per-member reflection when a shutdown lands mid-distill: an aborted run
never leaves half its close committed and half dropped in an order that would be
hard to reason about later. Both halves independently fail closed: a member
reflection that errors, times out, or comes back empty simply leaves that member's
prior memory standing, rather than risking a bad turn overwriting hard-won private
memory. The shared and private stores are covered on their own terms in
[Governed memory](../../concepts/governed-memory/); this page is about the timing
that makes recalling from either of them worth doing at all.

## Rejected alternatives

**Recall continuously, re-querying every round.** A run's own coordinator loop
never adds new decisions to the shared ledger mid-run, only at close, so a fresh
query partway through a run would return the same set the run already opened with.
Re-querying would spend nothing on new knowledge and would risk landing on a
partially-updated ledger from a *different*, concurrently closing run. A single
recall at the top gives every round of a run, and every member it dispatches to,
the same stable understanding of what the team knows.

**Write the run's raw summary as the decision by default.** A summary narrates what
this run did; it is not written to be understood by a run that has no memory of
this one. Distilling first asks the sharper question, what should a future run be
told, and produces something decontextualized and reusable. The raw summary is kept
as a fallback specifically for when the distillation turn itself could not run, not
as the preferred shape.

**Never abstain; always write something.** A ledger that records a row for every
run regardless of whether the run taught anything would grow without producing
better plans, and a confused or shallow run would sit in the ledger with the same
weight as a genuine lesson. Treating skip as a correct, common outcome is what
keeps recall worth trusting.

## Related

- [Governed memory](../../concepts/governed-memory/): the shared ledger and private
  per-member memory this page's recall and reflection read from and write to.
- [The coordinator loop](../the-coordinator-loop/): where recall and reflection sit
  inside the full plan, delegate, and observe cycle.
- [Tools and commands](../../reference/tools-and-commands/): the `squad_coordinate`
  and `squad_remember` contracts behind the loop and a member's private memory.
- [Data on disk](../../reference/data-on-disk/): the per-member memory files a
  reflection turn reads and overwrites.
