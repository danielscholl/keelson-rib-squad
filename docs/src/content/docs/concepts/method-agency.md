---
title: Method agency
description: The three ways the coordinator can get a delegated step done, author a reusable workflow, dispatch specialists, or edit code directly, and when each one is chosen.
sidebar:
  order: 4
---

Every round, the manager's reasoning turn does more than pick who acts next. It
also decides *how* that member should act: talk about the problem, write code
against it, or turn it into something reusable. That second decision is what this
page calls method agency. It is a genuine choice remade fresh each round, not a
fixed pipeline the manager walks through in order.

The choice matters because the three methods cost different things and produce
different artifacts. A reasoning step is cheap and reversible. A code edit changes
a real working tree and has to be confined and reviewed. A workflow persists past
the run that authored it. Picking the right one for the step in front of it is most
of what the manager's per-round judgment is actually for. See
[the coordinator loop](../the-coordinator-loop/) for how this decision sits inside
the wider recall, assess, execute, reflect cycle.

These are the three methods for a step that is *delegated to a member*. A round
need not delegate at all: a manager that only needs a fact about the repository
can call for a read-only probe and spend no member turn on it. That option is
covered on [the coordinator loop](../the-coordinator-loop/) page, not here.

## The three methods

| Method | Chosen when | What it produces |
|---|---|---|
| **Dispatch specialists** | The default. Used whenever the directive omits a method, names an invalid one, or asks for code from a member who isn't code-capable (that request silently downgrades to dispatch rather than failing). | One or more parallel, text-only replies from members, plus a closing synthesis reply when more than one member spoke. Read-only repo access if a project is bound, none otherwise. No file on disk changes. |
| **Modify code directly** | The directive names a code-capable member (tagged `code` on the roster) *and* a project is bound. Offered to the manager only when both hold; a code step decided without a bound project falls back to dispatch instead of failing. | An actual edit to the project's working tree: files read, written, or run against, confined to that project's root. Touched-file and diff stats land in the run's transcript. |
| **Author a workflow** | The directive asks for a reusable, repeatable DAG instead of one-off work. Available on every run, project-bound or not, and open to any member, there is no capability tag gating who may author. | A persisted workflow definition under the data home that outlives the run. The step's transcript entry records that a workflow was authored, not a repo change or a spoken reply. |

## Dispatch specialists

Dispatch is the manager's default and its cheapest method: a plain-text
conversation, not a change to anything. The named member, or several at once, each
get a text-only turn built from the same instruction. When more than one member
speaks, the fan-out runs concurrently rather than one at a time, and a closing
synthesis turn merges the replies into one answer, unless only one member spoke, in
which case that member's own reply already is the answer.

Without a bound project, a dispatch turn has no filesystem access at all: the
member reasons purely from the instruction text. With a project bound, each member
(and the synthesis turn) gets read-only inspection of that project's root, enough
to check a claim against a real file without being able to change it. Write access
is never part of a dispatch turn under any circumstance. That is reserved
entirely for the code method.

Dispatch also carries the coordinator's adversarial review pass: when code has
changed since the last clean review, the coordinator routes a dispatch wave at the
diff itself, framed to refute rather than rubber-stamp it. A review that comes back
blocked is folded straight back into the coordinator's next round rather than
accepted as done.

## Modify code directly

The code method is the only one of the three that touches a real repository. It
runs a single member's turn with a genuine tool surface, read, search, edit, write,
and shell, confined to one project's root: the member cannot see or touch anything
outside it, and the turn fails closed before it starts if that root is empty.

Two conditions gate it, and both have to hold. The member the manager names has
to carry the `code` capability tag on the roster (see
[cast and roster](../cast-and-roster/) for how that tag gets assigned), and a
project has to be bound to the run in the first place. The manager is only
ever offered `mode: code` as an option when a project is present, so an
unbound run never sees it suggested. If a code step somehow gets decided without a
bound project, it runs as a dispatch turn instead of erroring.

The method's task framing tells the member plainly not to merge, push a force
update, or rewrite history, and a non-overridable policy floor backs that up
regardless of what the member is told or attempts: it denies a merge or
force-push tool call outright. Opening a pull request and pushing ordinary commits
are allowed, which is what keeps a human at the merge gate on every run. See
[governed autonomy](../../design/governed-autonomy/) for the full shape of that
floor.

## Author a workflow

Authoring a workflow is how the manager turns one-off, recurring work into
something durable. Unlike the code method, there is no capability tag gating who
can be asked to do it, any member can author, and there is no project requirement
either: the artifact is written under the data home, not into a repository, so it
is available on a run with no project bound at all.

Reach for this method mentally the same way the manager's prompt frames it: for
sub-work that is going to happen the same way more than once, so it is worth
capturing as a deterministic DAG rather than re-deciding it by hand every time it
comes up. See [bundled workflows](../../reference/workflows/) for the shape of
the workflow definitions Squad ships, and the generic
[workflow node](https://danielscholl.github.io/keelson/docs/concepts/workflows/)
concept for what a DAG node actually is once authored.

## One step, one method, per round

A round delegates exactly one step to exactly one method. Nothing commits the
manager to that method for the rest of the run: the very next round reasons
over the updated ledger and can pick a completely different one. A run can freely
move from dispatching a review, to a code edit, back to dispatch for a second
opinion on that edit, to authoring a workflow for the pattern it just repeated,
all inside one continuous loop. Method agency is what makes that possible: it is a
decision remade every round, not a track the manager is locked onto once it
starts.

## Related

- [The coordinator loop](../the-coordinator-loop/): where this per-round method
  choice sits inside the wider recall, assess, execute, reflect cycle.
- [Cast and roster](../cast-and-roster/): how a member earns the `code` capability
  tag the coding method checks for.
- [Tools and commands](../../reference/tools-and-commands/): the exact contract
  for the `squad_dispatch`, `squad_code`, and `squad_coordinate` tools behind
  these three methods.
- [Governed autonomy](../../design/governed-autonomy/): the non-overridable policy
  floor that keeps the code method from merging or force-pushing its own work.
