---
title: The coordinator loop
description: How the standing coordinator moves a task toward its goal, one round at a time, recalling, assessing, picking a method, executing, and reflecting until the goal is met or the loop gives up.
sidebar:
  order: 3
---

A chat turn answers once. A dispatch fans a question out and reports back once. The
**coordinator loop** is different: it is a standing run bound to one task (and usually
one project) that keeps taking rounds, each one narrowing the gap between the current
state of the work and the goal, until the goal is judged met or the loop decides it
cannot get there.

Nothing about the loop is magic. It repeats one small cycle: recall what the team
already knows, assess where things stand, pick how the next piece of work should get
done, execute exactly that one piece, and reflect on what came back before deciding
whether to go again.

## One round, five moves

| Move | When it happens | What it does |
|---|---|---|
| Recall | Once, before the first round | Pulls relevant prior decisions and lessons out of the project's governed memory so the run does not start from a blank slate |
| Assess | Every round | One reasoning turn weighs the goal, the current plan, recalled memory, findings so far, and recent history, then judges whether real progress is happening |
| Pick a method | Same turn as assess | Names the next speaker and how they should work: a plain dispatch, a confined coding turn, or authoring a reusable workflow — or calls for a read-only probe instead, spending no member turn |
| Execute one step | Right after the turn | Runs exactly that one step, and nothing else, this round |
| Reflect | After the step returns | Folds the outcome into the findings and the transcript, and checks whether this round actually moved things or just repeated the last one |

**Recall.** Before round one ever runs, the loop reads the project's governed memory
for decisions and lessons that bear on this task. That grounding rides in every
assessment turn afterward, so a run started today can build on a decision the team
made in an earlier run rather than rediscovering it. See
[Governed memory](../governed-memory/) for how those decisions get written in the
first place.

**Assess.** The reasoning role here is the manager: a per-round turn distinct from
the coordinator loop as a whole and from any member on the roster. It never
dispatches, codes, or authors on its own, it only decides who should and how. Each
round the manager looks at the goal, the plan it is currently following, what it
recalled, what it has learned from earlier rounds, and the most recent history of
who did what, then ends its turn with a plain verdict: either work is still needed,
or the goal looks satisfied.

**Pick a method.** In the same turn, when work is still needed, the manager names
exactly one next step: which roster member should act, and which of three ways
they should act in. A member can be asked to reason in plain text, to make a
confined, direct edit to the project's code, or to author a reusable workflow for
work that will recur. [Method agency](../method-agency/) covers what each of those
three looks like and when the manager reaches for it.

A manager turn has one other move available: instead of naming a member, it can
call for a **probe** — a deterministic, read-only look at the repository (a git
log, a git status, a directory listing) that answers a factual question directly
and spends no member turn at all. It is the cheap alternative to dispatching
someone merely to go and look.

**Execute one step.** The loop delegates one step per round, never several at once
from the coordinator's own perspective. While that step is running, the board
records it as work in flight so an operator watching live can see who is acting and
what they were asked to do before the result comes back.

**Reflect.** Whatever comes back gets folded into the run's accumulated findings and
appended to its transcript. Reflection is more than bookkeeping: if the same
specialist produces essentially the same outcome two rounds running, the loop treats
that as stalled progress on its own, regardless of what the manager's own
assessment claimed. A stall pushes the loop toward a re-plan rather than blindly
repeating a step that already failed to move anything.

## Looping until done, or giving up

A round that ends in "still needed" simply becomes the next round: the manager
assesses again, against the updated findings and transcript. A round that ends in
"goal satisfied" is not automatically accepted, though. For a project-bound run where
code has changed, the loop first requires an independent review of the diff to come
back clean and the project's own verification commands to pass before it will call the
task done; either one coming back red sends the loop around for another round instead
of finishing. Only once those checks clear, or the run has no code changes to check
at all, does the loop actually stop.

The loop does not run forever. It stops on its own once any of these hold:
- **The goal is met** and, where applicable, the review and verification checks
  clear.
- **It runs out of rounds.** A single run has a round ceiling (24 by default),
  configurable when the run is started. The ceiling is not quite hard: a run that
  is still converging — the deterministic checks green, but a review still
  producing concrete BLOCK signal — extends it, at most twice, by a margin
  proportional to its own budget. That keeps a nearly-finished run from
  terminating with mergeable work stranded behind an unresolved review.
- **It runs out of tokens.** A run given a cumulative token budget halts once
  usage crosses it — the token analogue of the round ceiling.
- **It gives up.** Repeated stalls force a re-plan; if the loop keeps stalling after
  it has already spent its re-plan budget, it stops rather than looping forever on a
  goal it cannot make progress toward.
- **A gate keeps failing.** Three consecutive done-gate failures of the same kind
  — a verify command that stays red, or a change that keeps tripping the
  regression checks — stop the run rather than retrying indefinitely.
- **No one is left to act.** If the roster the loop is scoped to is empty, there is
  no one to delegate the next step to.
- **It is stopped.** An operator stopping a run, or a run reconciled after its
  driver died, ends as a settled verdict like any other.

Stopping the run yourself (or the harness restarting mid-run) does not throw the work
away. The loop's state is durable: ask for the same task against the same project
again, and the coordinator picks up its existing plan and findings rather than
starting over. Ask for a different task, a different project, or start after a run
has already finished, and it begins fresh.

## What the operator watches

An operator starts a coordinator loop by naming a task, either from the Run loop
panel on the Squad surface or by asking for it directly, and can watch it from there
while it works. The panel updates on its own while a run is active: a round counter,
a findings count, and how often the loop has stalled or replanned; the current goal
and plan; the most recent findings; and, while a step is executing, a card naming who
is acting and what they are doing. Once any work has been attributed, a **Minds**
section gives each member that worked its own lane: the provider behind it, how many
turns it took, what they cost, and its latest act.

If the manager decides the current roster lacks a capability the goal needs, the
panel surfaces that as a recommendation, not an action: nothing casts a new member on
its own, the operator decides whether to act on it. See
[Cast and roster](../cast-and-roster/) for how a recommendation like that turns into
an actual specialist.

When the run finishes, whether it succeeded or gave up, it settles into a static
summary on the panel and is archived to the run history, where it stays findable by
task and status after the panel itself has moved on to the next run.

## Related

- [Method agency](../method-agency/): the three ways the coordinator gets a step
  done, in depth.
- [Governed memory](../governed-memory/): where recalled decisions come from and how
  a run writes new ones.
- [The coordinator loop](../../design/the-coordinator-loop/): the design record for
  why the loop is shaped this way.
- [Run a coordinator loop](../../guides/run-a-coordinator-loop/): a task-first walk
  through starting and steering one.
