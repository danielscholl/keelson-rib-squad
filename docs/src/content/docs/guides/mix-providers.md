---
title: Mix providers
description: Pin different members to different providers and models so their judgment stays genuinely independent
sidebar:
  order: 5
---

A squad is more useful when its members do not all think the same way. Pin a
reviewer-role member to one provider and a coder-role member to another, and
the two turns run on different model weights: one is not just re-checking its
own reasoning under a different name. This guide covers the actual mechanism:
pinning **provider** and **model**, per member, plus an optional pin on the
manager of a coordinator run.

## Role titles are labels, not a taxonomy

Before pinning anything, it helps to be precise about what a "role" is in
Squad. `role` is a short freeform string a member's charter carries, such as
"Reviewer," "Tech lead," or "Backend engineer." An operator types it, or
[genesis](../cast-a-team/) proposes it from a brief. Nothing in the rib reads
that string to change behavior at turn time. There is no fixed set of role
values Squad switches on, and no code path that grants a "Reviewer" extra
tools or a "Tester" a different provider by virtue of the title alone.

The one place role text has any effect is advisory, not enforced: when
auto-cast composes a proposed team for a project, the scan prompt asks the
model to match a provider to the role it just wrote, leaning toward a
stronger model rather than a weaker one for planning- and review-heavy roles.
That happens once, at proposal time, and it is the LLM's own judgment call
reading a piece of text it wrote itself, not a lookup table in the rib. Once a
member exists, its `role` field is purely descriptive: what actually varies
member to member is `provider` and `model`, set independently of what the
role string says.

So "make the reviewer independent of the coder" is really "pin the member
you're calling your reviewer to a different provider than the member you're
calling your coder." The names are yours to choose.

## The pinning rule

Every provider/model pin in Squad, whether it is set on a member or on a
coordinator run's manager, follows the same rule:

| You want | What to set | What happens |
|---|---|---|
| Pin a specific model | `model` **and** `provider` | Both are recorded. The turn runs on that exact model. |
| Pin a vendor, let it choose the model | `provider` only | The provider is recorded, no model. The turn runs on that provider's own default model. |
| Leave it unpinned | neither | The turn runs on the harness's default provider. |
| Set `model` with no `provider` | model dropped | Rejected with an error explaining that a pinned model needs its provider too. Or, where the caller only reports rather than throws, the model is silently dropped and the pin is treated as absent. |

A model is vendor-specific, so a pinned model is meaningless without knowing
which vendor's model id it is: that is why a model can never be set alone. A
provider, on the other hand, is a complete pin by itself: "run this member on
Copilot" is a coherent instruction with no model named. This coherence rule
is enforced everywhere a pin is written, not just at one entry point, so a
member record can never end up with a stray model and no provider on disk.

## Pin a member's provider and model

Every member in the roster, however it was created, carries an independent
`provider`/`model` pin. From the member's card on the roster, use **Set
model…**. The fields are pre-filled with the member's current pin as
placeholders, so an empty submission clears both back to unpinned.

Typical uses:

- **Pin a vendor only.** Set `provider` to `copilot` and leave `model` blank.
  This member now always runs on Copilot, on whatever model Copilot resolves
  as its default, and stays pinned to Copilot even if the harness's own
  default provider changes later.
- **Pin an exact model.** Set `provider` to `claude` and `model` to a specific
  Claude model id. This member always runs that model, deliberately more (or
  less) capable than whatever a sibling member is pinned to.
- **Clear a pin.** Submit both fields empty. The member falls back to running
  on the harness's default provider, same as a member that was never pinned.

There is no field for `model` with no `provider`: submitting one without the
other surfaces the coherence rule as an error rather than silently doing
something else with it.

## Give a squad independent judgment on purpose

The concrete pattern this guide is named for: cast (or author) at least two
members you intend to use for different sides of the same piece of work, and
pin them to different providers.

For example, author one member with a charter oriented around implementation
and pin it to Copilot, then author a second member with a charter oriented
around adversarial review and pin it to Claude on a stronger model. Nothing
stops you from naming them "Coder" and "Reviewer," but nothing in the rib
requires those exact names either; what matters is that the two members
answer from different model weights when you [dispatch](../../reference/tools-and-commands/)
a question to both, when you [assign a code task](../cast-a-team/) to one and
a review to the other, or when a [coordinator run](../run-a-coordinator-loop/)
delegates to whichever of the two the manager judges is the better fit for a
given step.

This is also exactly what the review gate inside a project-bound coordinator
run leans on: when code changes since the last clean review, the loop
dispatches an adversarial review to the roster's read-capable members before
it will accept the manager's `done`. If those members are unpinned, or all
pinned to the same provider as whichever member wrote the code, the review
still runs, but it is reasoning from the same model family that produced the
change under review. Pinning your review-leaning members to a different
provider than your coding-leaning members means that gate is doing what it
looks like it is doing.

## Let auto-cast assign providers for you

When you cast a squad for a project instead of authoring members by hand,
the scan can assign a provider (and optionally a model) to each proposed
member on its own, matched to the role it just wrote. This only happens when
the harness reports more than one usable provider; the always-on
workflow-linked provider and the test stub provider are never candidates for
assignment, so a harness running only the stub proposes an entirely unpinned
team.

When providers are available, the guidance baked into the scan prompt leans
toward a stronger model for planning- and review-heavy roles and a strong
coding-and-review model for implementation-heavy roles, falling back to
whatever is available, and pinning the provider alone (no model) when the
model id is not certain. Review the **Proposed squad** board before you
approve it: it shows each proposed member's pinned model where one was
assigned, so you can see the mix before any member is scaffolded, and adjust
individual pins afterward with **Set model…** if the proposal's choices are
not the split you want.

## Pin the manager of a coordinator run

A [coordinator run](../run-a-coordinator-loop/) has one more pin available
beyond the roster's own member pins: the manager turn itself, the standing
turn that plans and delegates each round, can be pinned to a specific
provider and model for that run, independent of what any member is pinned
to. The same coherence rule applies here too: a manager model is only kept
if a manager provider is also given: supplying a model with no provider is
silently dropped, and the run proceeds with the manager unpinned rather than
failing.

This is a per-run choice, not a persistent setting: it applies to the run you
are starting and is not remembered as a pin on any member record.

## Related

- [Cast a team](../cast-a-team/): authoring and casting the members you will pin.
- [Run a coordinator loop](../run-a-coordinator-loop/): where a manager pin and a
  roster's member pins both come into play during a run.
- [The coordinator loop](../../concepts/the-coordinator-loop/): why the review
  gate benefits from providers that reason independently.
- [Tools and commands](../../reference/tools-and-commands/): the `squad_coordinate`
  and `squad_dispatch` tool schemas, including the manager pin fields.
