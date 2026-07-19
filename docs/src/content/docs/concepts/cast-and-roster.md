---
title: Cast and roster
description: How a squad's roster comes to exist, one member at a time through genesis or all at once through an auto-cast repository scan, and what casting a specialist actually does.
sidebar:
  order: 2
---

A **member** is one persistent, chat-enterable agent inside a squad: a name, a
role, a founding charter, and its own working memory and log. The **roster** is
the set of members currently active for a project. Squad has no separate "team"
object; a squad *is* its roster.

A roster does not start populated. You bring one into existence one of two ways:
author a member yourself from a brief (**genesis**), or point Squad at a
repository and let it read the project and propose a whole team at once
(**auto-cast**). Both paths end at the same place, a member directory on disk
and a card on the roster, but they trade off speed against control.

## Why compose a team instead of one agent

A single chat agent is fine for open-ended work, but a dev loop with distinct
concerns (planning, implementation, review, testing) reads better as distinct
people than as one agent context-switching between hats. A roster gives each
concern a stable name, a charter that only argues from that concern, and
optionally a different provider or model suited to the job.

| One generic chat agent | A Squad roster |
|---|---|
| Re-explained per task | Each member is authored once, then reused |
| One voice for every concern | A lead, a reviewer, a tester, and so on, each with its own charter |
| One model for everything | Each member may pin its own provider and model |
| Nothing persists between sessions | Charter, memory, and log persist on disk |
| Not addressable individually | Each member is enterable directly, or assignable a task by name |

The roster is also what the [coordinator loop](../the-coordinator-loop/) draws
on: it recalls decisions, picks a method, and then dispatches or assigns work to
whichever members the task needs. A roster is the raw material that loop
allocates against, not a feature in its own right.

## Genesis: authoring one member from a brief

Genesis is how you add a single member on purpose. From the roster you either
pick a starter archetype (Lead, Engineer, Reviewer, or Tester, each a
pre-written brief) or type your own freeform description of the member you
want. Either path launches the same **workflow**, `squad-genesis`, rather than
authoring the member in-process, so the run is visible and inspectable like any
other workflow run. Squad has no slash-command shortcut for this: you launch it
from the roster's quick-pick actions, the freeform brief field, or the CLI,
`keelson workflow run squad-genesis <brief>`.

The workflow's single prompt turn reads the brief, decides a name and a short
role title, and writes an honest charter in Markdown, a persona section, a role,
a mission, and a voice, explicitly told not to invent tools, credentials, or
capabilities the member will not actually have. It then calls one write tool,
`squad_emit_member`, exactly once to persist the result, and replies with a
single confirmation line naming the member.

That write is deliberately a separate, deterministic seam from the generative
prompt above it: it fails closed on a slug collision, so a re-run can never
clobber an existing member's charter, memory, or log, and it is the one place a
proposed name and role become a final cast identity (see the next section).
Once it lands, the roster reflects the new member on its next refresh, no
manual reload needed.

## Auto-cast: scanning a repository for a whole team at once

Auto-cast is the faster path when you would rather describe what the project
needs than author members one by one. From the roster's cold start, **Hire a
squad** launches another workflow, `squad-cast-scan`, against whichever project
is currently selected — named in both the section title ("Scan &lt;project&gt; and
propose a squad") and the panel head, so the target is never a guess.

That workflow runs one confined, read-only agent turn: it can read files,
glob, and grep the project's root, but it cannot edit or execute anything, and
it is bounded to five minutes so a hung provider cannot wedge the action. The
turn reads the repository's languages, frameworks, layout, docs, tests, and CI,
then proposes a small team, typically three to five members and never more than
six, each shaped like a genesis output: a person-like name, a short role, and a
charter grounded in what it actually found in the repo, not invented.

The result is staged as a **proposal**, not a roster — and the panel renders it
as the bench it is about to become, beside the evidence for it: each seat's own
reason for existing, and a receipt of what the scan actually opened, counted
from the turn rather than reported by the model. Approving a cast is a staffing
judgement, and those are what you judge it on.

A bench card carries the seat's *purpose*, not its charter — the case for the
seat, at a glance, across three tracks that hold their shape whatever the seat
count. The seat's full charter is one verb away (`▤`), opening on its own
Charter board, because a charter is what you actually read to decide on a seat
and a bench of six of them is not a decision, it is a scroll.

You review it on the Proposed squad panel and either:

- **Pick the seats you want**, by clicking any card to drop or restore it. This
  is a file write, not a re-scan.
- **Approve & scaffold**, which casts the picked members (skipping any name that
  collides with an existing member, never overwriting one), returns each dropped
  seat's cast name to the pool, and clears the proposal, or
- **Discard proposal**, which drops the whole proposal with nothing written.
  Casting again is a fresh scan proposing a *different* team — which is why
  disagreeing with one seat shouldn't cost you the other five.

Casting is deliberately a cold-start move. Once a project has an active roster,
the roster only offers **Hire a member…** (another genesis run); re-casting a
populated squad is not offered, because it invites confusion about which
members survive. Switching to a project with no roster yet reopens the cast
option.

## What casting a specialist actually means

Both genesis and auto-cast let an agent propose a raw name and role. **Casting**
is the step that turns that proposal into a persisted, distinctive identity
drawn from a movie, TV, or book ensemble, so a roster of five engineers reads as
five actual people instead of "Engineer 1" through "Engineer 5."

Squad ships a catalog of eight ensembles (among them The Usual Suspects, Ocean's
Eleven, Firefly, and Breaking Bad), but the catalog is a **starting set, not a
limit**. The casting turn may name any other real, widely-known work if it fits
the project better, and a listed character is an example rather than the pick
set: the model may name any real character from that work, listed or not. What
is not negotiable is that the ensemble be real — an invented one is rejected.

Casting resolves through three rungs, in order, and each falls through to the
next on any rejection:

1. **Name stability.** A live member already cast for this proposed name keeps
   its character, so re-casting the same project is idempotent rather than
   duplicating the member under a new name.
2. **The LLM's proposal.** The casting turn's own choice of ensemble and
   character, subject to exactly the same uniqueness checks as the rung below.
   This is what lets a squad's ensemble be reused, rerolled, or invented instead
   of being permanently confined to the static catalog. An ensemble named this
   way is persisted for the squad as a custom theme.
3. **The deterministic walk.** The tested fallback: the member's role is mapped
   onto one of a handful of canonical buckets, then Squad takes a free character
   in the active ensemble whose own preferred role fits best, falling back to any
   free character in that ensemble, and finally to any free character at all.

The LLM rung is additive — it never replaces the deterministic engine, which
still catches every case the model declines or gets wrong.

Underneath all three, casting keeps the squad coherent: it reuses the active
ensemble while it still has free characters and only rolls to another once it is
exhausted. "Active" is derived from the **seated roster**, not a stored field —
an ensemble whose last member has been retired is no longer active, and Squad
falls back to the newest ensemble that still holds a member, so a torn-down squad
starts fresh rather than inheriting a ghost. Only a genuinely empty roster has no
active ensemble. Reservations are serialized so two overlapping casts can never
claim the same character, and an approved batch is themed one member at a time so
every seat in it lands on a distinct character.

When a character is assigned, its personality and backstory are folded into the
member's charter alongside the role, mission, and voice the authoring turn
wrote, so the identity and the job description read as one document. Casting an
identical proposal twice (the same project, the same proposed name) returns the
same character rather than reserving a new one, and retiring a member frees its
character to be cast again later.

Theming can also be turned off entirely, or it can run out (every ensemble
exhausted). Either way, casting falls back to the proposed name unchanged, made
unique against existing slugs if needed. A member built this way is exactly as
functional as a themed one; it just keeps its original, generic-sounding name.

## A roster is scoped to a project

A roster belongs to whichever project is currently selected, not to the squad
as a whole. Each selected project has its own member directory, its own
casting state, and its own pending cast proposal, so casting a team for one
project never touches another project's roster. A workspace with no project
explicitly selected uses a default, unscoped roster, so a squad you cast before
project-scoping existed keeps working exactly as it did.

Switching the selected project switches which roster, proposal, and casting
state every panel and tool is looking at. See [Data on
disk](../../reference/data-on-disk/) for exactly what is stored where.

## Provider and model at cast time

A member can be pinned to a specific provider and model, or left to run on the
harness's default. When auto-cast has a live provider catalog to choose from,
it also assigns providers by role, leaning toward the stronger available option
for planning and review work rather than the cheapest one. A pinned model
always travels with its provider; Squad never persists a model with no
provider behind it. See [Mix providers](../../guides/mix-providers/) for the
operator-facing version of this.

## Entering and retiring a member

Every member on the roster is directly enterable as an ordinary Keelson chat
agent, seeded with its charter, its durable memory, its operating rules, and
its recent log. Entering a member from the roster and entering it as an agent
elsewhere in the harness build the seed the same way, so the two never drift
apart.

Retiring a member is permanent: it deletes the member's entire directory,
charter and all. Squad's member record does define an inactive status
alongside active, but retiring does not use it as a soft pause; it removes the
member outright. There is no undo short of casting or authoring that member
again from scratch.

## Related

- [The coordinator loop](../the-coordinator-loop/): how the roster gets put to work.
- [Governed memory](../governed-memory/): the shared decision ledger, distinct from a member's own memory.
- [Cast a team](../../guides/cast-a-team/): the task-first walkthrough of both casting paths.
- [Data on disk](../../reference/data-on-disk/): the files a member and a proposal write.
