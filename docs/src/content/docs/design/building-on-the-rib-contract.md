---
title: Building on the rib contract
description: Which optional context seams Squad leans on and why, the declarative-memory path it rides where no imperative seam reaches a workflow node, and the one seam it deliberately skips.
sidebar:
  order: 5
---

Every rib is handed the same `RibContext`: a fixed set of accessors, most of them
optional, that the harness may or may not provide depending on how it was embedded.
Squad's shape follows directly from which of those it takes up, how it degrades when
one is missing, and, in one important case, what it ships instead because the
contract has no imperative answer at that particular boundary. The generic contract
itself, including the convention that an optional seam degrades rather than throws,
is documented in the
[keelson rib contract reference](https://danielscholl.github.io/keelson/docs/reference/rib-contract/).
This page is Squad's own account of which seams it actually uses.

## One hard dependency, captured before anything else runs

Squad has exactly one requirement it cannot work around: a writable data directory,
`ctx.getDataDir`. Everything the rib persists (members, charters, the cast proposal,
the coordinator ledger, run archives) lives under that path.

The catch is boot order. Squad's collector workflows (`squad-roster`, `squad-cast`,
`squad-coordinator`, `squad-runs`) run as separate, out-of-process bash commands, so
they have no way to call back into `ctx` to ask for the data directory themselves.
The resolved path has to be a plain string baked into each collector's shell command
at the moment the workflow is registered. That means `registerTools`, where the path
is captured, must run before `contributeWorkflows`, where it is read back out and
interpolated. Squad relies on the harness's own activation order to guarantee that
sequencing; it does not re-derive the path defensively inside the workflow body.

`authStatus` reflects this asymmetry plainly: an unwritable data home is the only
condition that fails the probe. The agent-turn and projects seams are reported back
as present or absent for visibility, but their absence never fails the probe, because
Squad already has a defined degraded behavior for both.

## The seams that make Squad feel responsive, not just correct

**`refreshWorkflow`** is the seam behind Squad's illusion of instant feedback. Nearly
every mutation, authoring a member, retiring one, pinning a model, approving or
discarding a cast proposal, each round of a coordinator run, re-runs the matching
collector immediately afterward instead of waiting for that panel's next scheduled
refresh. Every one of those calls is fire-and-forget and swallows its own failure.
That is deliberate: a refresh hiccup must never be allowed to look like the write
itself failed. Without this seam, a panel simply falls back to its own cadence or to
a refresh on next open, which is a real, working default, just a slower one.

**`runAgentTurn`** is what actually lets Squad delegate work to a member rather than
just record who the members are. It backs `squad_dispatch`, `squad_code`,
`squad_coordinate`, and the read-only repo scan behind casting. All four check for
the seam before doing anything and return a plain, readable error, `agent-turn seam
unavailable on this harness`, rather than throwing, if an older or minimal harness
omits it. The rib itself still boots and its read-only tools still work either way;
only the delegation path is gated.

**`getProjects`** is what lets a roster, a coordination run, or a coding turn scope
itself to one repository, and what backs the project picker the surface renders in
its header. Squad also keeps a best-effort local mirror of the live project catalog
on disk, written whenever the seam answers, purely so the picker still has something
to show before any seam-dependent action has run even once in a fresh install.

**`getProviders`** is read-only and lower-stakes: Squad only consults it to make
casting smarter, auto-assigning a sensible model/provider pin by role at cast time.
If listing providers ever fails, casting degrades quietly to unpinned members rather
than failing the whole proposal. Nothing else in the rib depends on it.

**`runWorkflow`** lets the coordinator's workflow-authoring arm actually execute a
DAG a member just wrote, without Squad depending on the workflow engine directly.
**`getExec`** is handed into the coordinator purely to run its own done-gate verify
commands. Both are optional and both are used only inside `squad_coordinate`; a
harness that omits either one leaves the coordinator's planning and dispatch arms
intact and simply narrows what a step can do.

## Where the contract stops: the governed memory ledger

`RibContext.getMemory` exists, and Squad does use it directly in one place: the
coordinator's own governed-memory loop. At the start of a run, if a project is bound
and the seam is present, the coordinator recalls prior decisions and lessons scoped
to that project and folds them into the grounding every dispatched member sees. At
the close of a run, it distills the outcome into a single durable lesson (or
abstains, when nothing generalizable came of the run) and writes that back as one
`decision` row. Both directions are project-scoped and fail-soft: no seam, no bound
project, or a store hiccup all degrade to no memory rather than crashing the run,
and the server still enforces its own guardrail underneath, this writeback can only
ever land as evidence-default, never as an instruction-grade row.

That loop works because it runs as ordinary TypeScript inside a tool's `execute`
function, closing over the same `ctx` the rib captured at activation. A workflow
node is a different kind of thing entirely. `squad-decide` and `squad-decisions` are
DAG definitions the shared workflow engine executes as a bash command or a prompt
template, not TypeScript with a live `RibContext` in scope. A node body has no way
to call `ctx.getMemory()`, even though that exact seam is reachable a few functions
away in the same rib, because nothing hands a node a `ctx` to call it on in the
first place.

For that boundary the contract offers a different, declarative mechanism: a
`memory: { recall }` or `memory: { writeback }` block placed directly on a workflow
node definition, which the shared workflow engine evaluates server-side around that
node's execution, independent of anything the node's own command does. This is why
`squad-decide`'s node body is a trivial constant, `echo 'squad: decision recorded to
the ledger'`, with no paid turn and no interpolation of the operator-supplied
summary or content into the shell at all. The actual ledger write happens in the
node's `writeback` block, sourced from `$inputs.summary` and `$inputs.content`, after
the node succeeds. The executor stamps that write's provenance as `generated`
itself; nothing a rib or a node writes can request a higher-trust provenance than
that.

`squad-decisions` mirrors the same pattern on the read side. Its one node carries a
`recall` block that runs first, querying for team decisions and lessons capped at 50
items and substituting the results into `$memory.recall.items`; the node's prompt
then renders those rows onto the Decisions board. That render is a paid agent turn,
which is the reason the Decisions panel is the one region on the whole surface with
no refresh cadence at all: a heartbeat would spend a turn every time it fired whether
or not anyone was looking, so the panel instead re-fetches only when the operator
opens or focuses it.

## The seam Squad deliberately does not use

`RibContext.registerRegion` lets a rib add a live panel to one of its own surfaces at
runtime, one region per running thing, and remove it again later. Squad never calls
it. Every region on the Squad surface, the roster header, the Run loop banner, Runs
history, the Proposed squad panel, and Decisions, is declared once, up front, as part
of the surface's static layout.

That is a real architectural choice, not an oversight. Squad's live-updating unit is
a run, and the Run loop panel already is that live view: it is bound to the
persisted coordinator ledger and republishes on every round, so there is exactly one
panel to watch regardless of which run is active. History does not need a panel per
archived run either; `squad-runs` renders the whole archive as one list. Nothing in
Squad's current shape spawns an unbounded number of concurrent, independently
addressable things the way a per-room or per-lens panel would in a rib built around
many things running side by side. A fixed five-panel layout says what the surface
is; nothing about it would get clearer by making any one of those panels dynamic.

## Related

- [The coordinator loop](../the-coordinator-loop/): the design record for the loop that consumes the agent-turn, run-workflow, exec, and memory seams described here.
- [Memory that compounds](../memory-that-compounds/): why recall-then-reflect is shaped the way it is, one level up from the seam mechanics on this page.
- [Surface](../../reference/surface/): the fixed five-region layout this page argues for staying static.
- [keelson rib contract](https://danielscholl.github.io/keelson/docs/reference/rib-contract/): the generic `RibContext` shape and the optional-seam convention every section above relies on.
