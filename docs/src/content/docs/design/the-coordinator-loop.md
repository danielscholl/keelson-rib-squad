---
title: The coordinator loop
description: Why a coordinator round folds recall, method selection, execution, and reflection into one manager turn, and why stall and reset caps bound a loop that would otherwise repeat itself forever
sidebar:
  order: 2
---

The coordinator is a `while (true)` loop, not a single delegate-and-collect call. This
record states why a round is shaped the way it is, four jobs folded into one manager
turn, and why the loop carries three separate numeric caps rather than trusting the
manager to know when to stop.

## The shape: one turn, four jobs, every round

A round runs exactly one manager turn, and that turn does all of the following at
once, in a single reply:

1. **Recall.** The prompt the manager sees is cumulative: the goal, the roster, the
   current plan, memory recalled from the governed ledger, every fact accumulated so
   far, and the last eight transcript entries. Nothing about a round starts from a
   blank page.
2. **Method selection.** The manager's reply can set `mode` to `dispatch` (a plain
   text fan-out to one or more members, the default), `code` (a confined turn that
   edits the bound project's repository), or `workflow` (author a reusable DAG for
   recurring sub-work). The choice is re-made fresh every round, not fixed at launch.
3. **Execution.** The loop delegates exactly one step per round to whichever arm the
   selected method names, and folds the single result back into the facts and the
   transcript before the next round begins.
4. **Reflection.** The same reply ends with a trailing JSON directive carrying five
   self-reported fields (is the request satisfied, is the manager in a loop, is
   progress being made, who should act next, what should they do), which the loop
   folds against its own deterministic checks before deciding what happens next.

There is no separate planning turn ahead of a separate delegating turn. The manager
reasons and decides in the same breath, and the loop treats that one reply as
authoritative input to all four jobs at once.

## Why not delegate-and-done

The simpler alternative is a single call: hand the whole task to one dispatch or one
code turn, accept whatever comes back, and stop. That model is enough for a
one-shot question, which is exactly what the `dispatch` tool already covers on its
own. It is not enough for a standing coordinator run against a real repository,
for three reasons.

A real goal usually needs more than one kind of work, in a sequence that only
becomes clear once the first step's outcome is in hand: assess with a read-only
dispatch, then make a confined edit, then maybe author a workflow so the same
sub-task does not need a paid turn next time. None of that sequencing is
expressible in a single call, because a single call has no way to look at its own
result and pick a different method for the next step.

A single call also has no way to notice it is not working. If the first attempt
does not resolve the goal, a delegate-and-done model has nothing left to hand back
but that one attempt. There is no round boundary at which the loop could compare
this attempt to the last one, so a delegate-and-done model cannot distinguish a
task that is making genuine progress from one that keeps producing the same
non-answer.

Finally, a single call has nowhere to put a real "done" gate. Accepting a coding
turn's own claim that it finished is exactly the failure mode the loop is built to
avoid: a review pass, a verification run, and a change-quality check all need a
loop boundary to run *at*, after the work exists and before the caller trusts it.
A one-shot model has no such boundary, only the one turn's own say-so.

## Stall and reset: catching the loop that keeps not working

Reflection inside a round is a self-report, and self-reports are not enough on
their own, for two separate reasons the loop guards against independently.

The first is a well-behaved manager that is honestly stuck: it reports `is_in_loop`
or `is_progress_being_made: false`. That is straightforward to trust.

The second is a manager that is *not* stuck by its own account but is
nonetheless not moving: it keeps reporting progress while re-dispatching a
doomed step. Because the loop cannot take a self-report of progress at face
value in that case, it also computes a deterministic backstop independent of
anything the manager claims: it fingerprints the speaker and the normalized text
of the most recent delegated outcome, and if the same fingerprint repeats for two
rounds running, that counts as stalled regardless of what the directive says.
Coordinator, re-plan, sweep, and verify entries are excluded from this check
deliberately; only actual delegated work (a dispatch, code, or workflow outcome)
can repeat in a way that counts.

Either kind of stall increments a per-round `stallCount`. Once it reaches
`maxStall` (3 by default), the loop does not give up immediately, it re-plans:
every step attempted since the last re-plan boundary is swept into a durable
"do not resume these" list, the plan is cleared so the manager is forced to
rebuild it from scratch, and the loop keeps running. A re-plan spends one unit of
a second, independent budget, `resetCount`. Only once `resetCount` reaches
`maxResets` (2 by default) does the loop actually stop, with a `"gave up after
N re-plans"` reason and no done-gate run at all, because giving up is not a
completion claim and there is nothing to verify.

Three separate caps exist because they guard against three separate failure
shapes. `maxStall` answers "is this particular direction working"; a low value
means the loop abandons a bad plan quickly rather than grinding on it.
`maxResets` answers "have we tried enough different directions"; it stops a
run that keeps re-planning forever without ever converging, rather than letting
stall-and-replan become its own infinite loop. `maxRounds` (24 by default) is
the flat backstop underneath both: a manager that reports shallow, technically-true
progress every single round, never stalling by either measure yet never actually
finishing, would sail past the other two caps indefinitely. The round ceiling is
the one guarantee that holds regardless of what the stall accounting decides.

## Reflection does not end at the manager's turn

The self-reported and fingerprint-backed stall checks run every round, but they
are provisional: they only ever gate whether the loop keeps going or re-plans.
The moment the manager claims the goal is satisfied, a second and more expensive
layer of reflection takes over, and it is this layer, not the manager's own
directive, that actually decides whether `done` is accepted.

When a project is bound and code has changed since the last clean pass, the loop
runs an adversarial review before anything else, requires a specific,
reproducible defect to block (not a hunch), then runs command verification
(operator-supplied or auto-detected from the project's `package.json`), then a
deterministic change-quality check of the diff itself, looking for exactly the
kind of tampering a green test run would not catch on its own: a deleted test
file, a net-negative count of assertion calls, or a newly added lint or
type-suppression comment. Any one of these failing vetoes `done` outright and
loops the manager back for another round; only when all of them clear (or do not
apply, for a run with no bound project) does the ledger's status actually become
`done`, followed by a distillation pass into governed memory so the run leaves
something durable behind. The manager's own self-report of being finished is the
trigger for this check, never the substitute for it.

## Related

- [The coordinator loop](../../concepts/the-coordinator-loop/): the same loop from the mental-model side, recall through reflection in plain terms.
- [Governed autonomy](../governed-autonomy/): the approval gates and policy floor the review and verification steps sit inside.
- [Memory that compounds](../memory-that-compounds/): what the loop-close distillation pass actually writes, and how the next run recalls it.
- [Tools and commands](../../reference/tools-and-commands/): the `squad_coordinate` tool contract, including the round and reset limits an operator can pass in.
