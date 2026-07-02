---
title: Governed autonomy
description: Why the coordinator runs unattended for many rounds under a non-overridable policy floor, and why the real cost control is bounding the loop and its inputs, not a dollar budget
sidebar:
  order: 3
---

A squad's coordinator is built to run unattended: hand it a task and it plans,
delegates, and re-plans across rounds without an operator approving each step.
That is the entire point of the loop, not a side effect of it. But the same
coordinator that runs unattended can also dispatch a code-capable member into a
real project's real git history, so Squad pairs that autonomy with a policy floor
no member, model, or manager prompt can talk its way around, and it bounds the
loop itself rather than pretending it can meter what a turn costs.

## Decision

Squad grants the coordinator wide latitude over *how* a task gets done: it can
fan a question out to the roster, author a reusable workflow, or run a confined
coding turn against a real repository, round after round, with no approval gate
on any individual step. What it never grants, and what no combination of prompt,
model, or member configuration can override, is the ability to land the change
itself. Squad contributes one small, non-overridable policy floor that denies a
self-merge or a force-push outright, and fails a run outright when a review turn
comes back with a BLOCK verdict. The floor exists precisely so the latitude above
is safe to grant: the squad can go off and do real work, including opening a pull
request, without ever being the actor that merges its own change.

## The floor: what it denies, and where

The floor only evaluates on the workflow and rib surfaces; a chat or MCP session
never runs through it at all, on the reasoning that governing the operator's own
direct session would be overreach. Within those two surfaces, the floor runs on
every tool call and every response the harness's policy engine evaluates,
alongside every builtin and every other rib's contributed policies, in one
ordered, first-deny-wins stack: any policy in that stack, including this one, can
veto a call a more permissive builtin would otherwise have allowed.

At the tool-call phase it denies two shapes outright:

- a named merge tool (`gh_pr_merge`, `mergePR`, and similar spellings, normalized
  before matching)
- a shell command recognized as a forbidden git or `gh` operation: an explicit
  `--force`/`--force-with-lease`, a `--delete`/`--mirror` push, a forced (`+`) or
  delete (`:`) refspec even with no flag present at all, `gh pr merge`, or a
  `gh api` merge or GraphQL-mutation call paired with a write method or field
  flag

That classifier is deliberately conservative rather than a real shell parser. It
still resolves the actual command through a chained, subshelled, negated, or
env-prefixed wrapper, and through a `$(...)` command substitution, because a
false negative there is a history rewrite or a self-merge slipping past the
floor, while a false positive only blocks one operation. It does not, on the
other hand, flag a forbidden phrase that merely appears inside a commit message
or a pull request body; only the resolved command's own argv counts.

At the response phase, the floor denies a turn whose output carries a BLOCK
verdict, targeting the verdict node of a review workflow, and only on the
workflow surface. A deny there fails the node outright: no retry inside the same
turn, and the failure propagates to the run's overall result and blocks anything
gated on that node's success. The same check is deliberately not applied on the
rib surface, where it cannot tell a reviewer emitting the verdict apart from an
engineer editing the sentinel string into source; the same verdict check is
instead reused directly by the coordinator's own review-dispatch logic to
enforce it there. Detection stays one implementation; only where it is enforced
changes with the surface.

## Why bound the loop, not the wallet

There is no dollar or token budget anywhere in this design, and a rib has no
seam it could read one from even if it wanted to: the rib contract gives a rib a
seam to run a turn, not a seam to learn what that turn costs. Squad genuinely
cannot gate on price. What it can, and does, gate on is how many turns a run is
allowed to take, and how much text an operator can pour into any one of them.

**Round, stall, and reset caps bound the loop itself.** The coordinate tool
exposes `maxRounds`, `maxStall`, and `maxResets`, each capped in the tool's own
schema (1 to 100, 1 to 20, 1 to 20) so an operator cannot ask for an unbounded
loop; left unset, they default to 24, 3, and 2. Stall detection is deterministic
rather than the manager's self-reported progress: a round that repeats the same
outcome advances a stall counter regardless of what the plan claims, and enough
consecutive stalls forces a re-plan; a re-plan that keeps failing eventually ends
the run as given up rather than looping forever. Three consecutive done-gate
failures, whether a failing verify command or a change-quality check, end a run
the same way. The Run loop panel's own launch path runs a tighter version of the
same loop: the click-to-launch coordinate-run workflow fixes `maxRounds` at 6,
well below the tool's own default, because a surface launch is one bounded
click, not the standing background job the raw tool is built to support.

**Text-length caps bound what any one round costs.** Every board action that
launches a paid turn truncates its own free-text input before that text becomes
a workflow argument: an authoring brief or a cast-scan mission at 2000
characters, a coordinate, dispatch, or code task, or a recorded decision's
summary and content, at 4000. The coordinate tool's own schema caps
operator-supplied verify commands too, at 300 characters each and 8 commands
total. None of these are billing controls in a financial sense; they are a
ceiling on how large a single piece of operator-typed text can grow before it
rides into a turn, which is the one lever a rib can actually pull without a
pricing seam.

This is the entirety of Squad's cost control: no dollar or token budget, just a
cap on how many rounds a loop may run and a cap on how long a piece of
operator-supplied text may be before it is truncated. Both are enforced in code,
by schema bounds and input clamps, not by asking a model to police its own
spending.

## Rejected alternatives

**A dollar- or token-denominated budget.** This would require Squad to know what
a turn costs, and neither the rib contract nor the provider registry exposes
pricing to a rib. Bounding the round count and the stall and reset counts gets
the same practical outcome, a run that genuinely cannot run away, without
needing an accounting layer the harness does not offer.

**Per-round human approval.** Gating every round on an operator click would turn
the coordinator back into a workflow the operator drives by hand, defeating the
reason to run it at all. Squad instead narrows the gate to the two operations
that are actually irreversible, a merge and a force-push, and leaves everything
else in the loop unattended.

## Related

- [The coordinator loop](../the-coordinator-loop/): the plan, delegate, observe,
  and reflect passes this floor bounds.
- [Method agency](../../concepts/method-agency/): the dispatch, code-edit, and
  workflow-authoring methods the floor constrains.
- [Run a coordinator loop](../../guides/run-a-coordinator-loop/): starting and
  watching a bounded run from the surface.
- [Tools and commands](../../reference/tools-and-commands/): the `squad_coordinate`
  and `squad_code` contracts, including the loop caps and the merge/force-push
  denial.
