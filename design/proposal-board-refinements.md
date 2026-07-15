# Proposed-squad refinements

Plan of record for the cast board's second pass, evaluated against a real
five-seat Firefly cast of `cimpl-stack`. The companion mockup is
[`proposal-board-refinements.html`](./proposal-board-refinements.html) — today's
board, the proposed one, and a flipped card, toggleable.

## Status

Tier 1 shipped, with two changes forced by the contract. **The mockup is not as
primitive-faithful as it claims** — building it surfaced three breaks:

- **`dim` is not a tone.** `canvasToneSchema` is 13 values and `dim` isn't among
  them; the mockup invented it. Emitting it would fail `canvasFieldSchema.strict()`
  → `expectView` throws → the whole panel goes dark on any board with a read-only
  seat. The read-only case now carries **no tone**, which renders identically
  (there is no `[data-tone="neutral"]` rule either) and makes "only the exception
  is marked" true in the data rather than only in the prose.
- **The flip is deferred; the charter opens as its own panel.** The mockup's
  flipped card leans on two rules absent from `app.css`
  (`--stacked .cvb-field-value{font-family:inherit}` and a `--stacked
  .cvb-field-label` gutter). They can't be added blanket: `stacked` is a
  documented *line-oriented readout* primitive and four live boards depend on its
  monospace — including squad's own roster boot card (`>` prompt, green mono).
  Scoping it needs a schema flag, and `@keelson/shared` is `.strict()` with CI
  symlinked to keelson `main`, so a rib PR emitting one goes red until the harness
  lands it. `view-charter` reuses `viewRunAction`'s open-canvas shape instead —
  full width, prose type, no resize to fix.
- **No marker file.** `cast-view.json` was the flip's answer to the out-of-process
  collector. A drill-down needs none: the board stays pure, and `modelPicker` needs
  no provider list (the host fetches its own catalog), so the whole design renders
  from a bash collector with no seam.

The charter panel also settles the open question below: the rationale is no
longer homeless. It rides that panel's seat card as `why cast:`, beside the
charter it argues for.

## Problem

The board earns its keep: the bench is the approve decision, and the cards are
the right unit. What surrounds them isn't paying rent.

**The stat row is four tiles of restated screen.** Not low-value — duplicated.
`5 of 5 picked` is verbatim `header.status`, two inches up. `26 files read / 33s`
is verbatim the Scan receipt's first row, to the right. `5 of 6 bench` reports
`MAX_CAST_MEMBERS`, an internal cap the operator never chose. `3 can code` is the
row's one real fact, stranded from the cards that hold it.

**The briefing dresses a claim and a count identically.** `the thesis` is prose a
confabulation can produce; `the scan` is a number counted off the turn's
`tool_use` chunks. Four identical boxed panels give them the same box, the same
label column, the same weight — flattening the one distinction the board exists
to draw.

**Half the card is boilerplate.** `cast Firefly` is identical on every seat and
the thesis already says "A five-person **Firefly** squad". `model gpt-5.5` is a
dead readout of a pin the operator can't act on. Two labels (`can`, `why cast:`)
spend words naming zones the card's own divider already separates.

**Capability renders at the weight of trivia.** Nothing marks `code` as what it
is — the seat's permission to modify the repository, the one thing on the card
the governance floor exists to bound.

**The card answers the wrong question.** `why cast:` is the scan's argument for
the seat. Useful once; not what you re-read. What the seat is *for* is buried in
an appendix whose visible line is `cast as ${role}` — a verbatim restatement of
the card's own title and pill.

## Tier 1 — the board (rib-only)

| Change | Site | Shape |
| --- | --- | --- |
| Delete the stat row | `statsSection()` | Drop it. The Approve confirm body names the code-capable count where it's a consequence |
| Collapse the rail | `railSections()` → `briefSection()` | The receipt becomes one row: `26 files read · 7 searches (glob / grep)` + duration, `rows.detail` still expanding to the file list, thin-scan tone intact. Frees the column; the bench goes full width |
| Rebuild the briefing | `briefSection()` | The claim becomes **one card** (ensemble as title, capacity as pill — absorbing the deleted bench tile — thesis under the card's divider); the provenance becomes **two bare rows** (no brief given; what the scan read). See below |
| Hoist the ensemble | `castLabel()` → the briefing card's title | **Only when uniform** (see below) |
| Drop both labels | `cardFor()` | `reason.label` and the field `label` are each optional. Capability above the rule, purpose below it — the dashed border on `.cvb-card-reason` already draws the divider |
| Mark the privilege | `capabilityField()` | `✎ code, read` in `caution`; `read` **untoned** (not `dim` — see Status). Only the exception is marked |
| Drop the model field | `cardFor()` | Deleted — the model becomes the `Model — <id>` action label (the at-rest indicator) |
| Purpose, not rationale | `reasonFor()` | Return `charterExcerpt()` (already written, already prefers the `## Mission` line) instead of the rationale |
| Delete the appendix | `charterSection()` | Its job was carrying the mission. The card carries it; the full charter is a panel |
| Model control | new `cast-model` | Card action, `modelPicker` field, `providerField: "provider"` |
| Charter (read-only) | new `view-charter` | Card action, `label: "▤"`, `hint: "Charter"`, opening `CHARTER_KEY` |

Six sections become four: header → briefing → bench → decide.

`cast-model` follows `castPickAction` exactly: `withProposalLock` → `readProposal`
→ `staleProposal(castAt)` → match the slug against seats this proposal actually
holds → `writeProposal` → refresh `squad-cast`. It reuses `validateProviderPin()`
— but **fails closed** where the scan path only notes: a rejected pin on an
operator's explicit retune returns an error rather than silently dropping.

**The pin is a pair.** `readProposal` drops a model whose provider is absent, so a
provider-less pin evaporates on the collector's next read; `approveCastAction` only
copies the model when both are set. So `cast-model` writes both or neither, and a
`{model}` with no provider is rejected rather than left to `validateProviderPin` —
which returns a note-less empty pin for it, indistinguishable from the picker's
clear, and would silently wipe the pin.

### The briefing: form encodes voice

**A card is an assertion; a line is a fact.** The claim wears a card with the same
anatomy as the seats it proposes — so the board reads as one grammar (the squad's
card, then its members' cards) rather than panels-then-cards. The provenance wears
bare rows. That's the distinction four identical boxed panels were erasing, and
it's ~40% shorter besides.

Two constraints found while building it:

- **Card field values render in monospace.** The no-brief warning started as a
  toned field — the only toned text slot a card has, since `reason` and `footnote`
  take no `tone` — and a prose warning in mono reads as code. Hence the warning is
  a row: rows aren't mono, and the glyph carries the tone. Reach for a card field
  for prose and it will fight you.
- **`segments` is count-only** (`{ label, n: number, tone? }`), so it can carry
  `26 files` but not `Firefly ensemble` or `33s`. Not the primitive for this.

When the operator *did* give a brief, the warn row drops and the brief rides as
the card's `footnote` — the absence is the signal worth toning, not the presence.

### Why the receipt collapses rather than dies

The rationale on each card is what the model **claimed**; the receipt is what the
harness **counted** off the turn's `tool_use` chunks — per `railSections()`'s own
comment, "the one thing here a confabulation can't produce" (#232, #233). With
`why cast:` also leaving the card, deleting the rail would leave the board with
zero evidence. The collapsed row keeps all of it, including the thin-scan tone
that flips a 3-file cast to a yellow `!`.

### The ensemble hoist needs a uniformity guard

`themeSelectionOrder()` reuses the active ensemble "while it has capacity, else
the next", and `assignThemedIdentity` rolls onward when one is exhausted — so a
cast **can** span two ensembles. Hoist only when every picked seat shares a
`themeId`; otherwise the row says `2 ensembles` and the field stays on the cards.

### The charter is a panel, not a back — and why

The flip was the mockup's move, and the contract won't carry it (see **Status**).
The panel it became reuses the rib's own drill-down pattern verbatim:
`view-charter` reads the seat off the persisted proposal, publishes
`buildCharterBoard` under `CHARTER_KEY`, and returns
`{ effect: "open-canvas", key, title }` — the same three lines `view-run` uses for
an archived ledger. Registered imperatively in `registerTools`, cleared in
`dispose`, no surface region of its own.

What it buys over the flip: the charter reads at full width in prose type rather
than through a 150px letterbox in a 240px track, and nothing resizes, because the
charter never enters the bench. What it costs: you leave the bench to read.

The panel repeats the card's head (dot, name, role pill, capability) so it reads
as that seat rather than a different one. The prose rides `rows.text` — rows
aren't monospace and `text` has no cap, unlike a card field — split on the
charter's own `##` headings, with `detail` re-hanging structure only for a body
that has some, so a one-paragraph section renders no caret onto its own words.

Two traps worth keeping: `charterDisplay` strips a leading self-name, which is
right for the preamble (`# Mal` + its provenance line) and wrong for a section
body, where `## Mission → "Mal holds the line."` would lose its subject — so only
the preamble is named. And `rows.detail` is capped at 4000 while
`castMemberSchema.charter` has no max, so an oversized section is capped rather
than taking the board down — the same class of bug `FILE_LIST_CAP` exists to
prevent, and one the deleted appendix had latent.

## Deferred to a keelson PR

None of these block the board; it ships and works without them. All three need
`@keelson/shared` schema changes, and CI symlinks `main`, so they must land there
**before** any rib PR emits them.

1. **Corner placement.** `.cvb-card-actions` is a plain left-aligned `flex-wrap`
   row; a producer can't set `justify-content`. The host already does this trick
   one element up — `.cvb-card-overflow { margin-left: auto }` pins the `⋯` to the
   head's right edge. Wanted: an action hint (`align: "end"` → `margin-left:auto`,
   additive like `inline`/`subtitle`). A blanket `justify-content: space-between`
   would be wrong — it would push the roster card's Retire away from its Enter too.
2. **Icon-only.** There is no `iconOnly` flag — `labelContent = item.label`, always
   rendered — so `▤` ships as `label: "▤"`, making the button's accessible name the
   glyph. `hint` already gives the "Charter" tooltip for free (it lands as `title`).
   Wanted: `iconOnly?: boolean`, rendering glyph-only while the label stays the
   accessible name.
3. **A scoped prose treatment**, if the flip is ever worth revisiting: the scroll
   cap (`max-height` + `overflow-y`, genuinely new — nothing caps a card's height
   today) plus prose type and a label gutter, all behind a new flag rather than on
   `stacked`, whose monospace four live boards rely on.

**Known cosmetic cost until 1 and 2 land:** in a `columns:3` bench (~380px tracks),
a long model id on the `Model — …` label wraps `▤` to a second line.
`.cvb-card-actions` is `flex-wrap`, so it degrades rather than breaking.

## Drift found while scoping

`boards/roster.ts`'s `set-model` still collects the model as **free text**
(`placeholder: "e.g. claude-opus-4.8 (blank to clear)"`) while Chamber's
`mindCardActions()` uses the host's live `modelPicker` — searchable, grouped by
provider, backed by a dedicated `ModelCatalogPopover`. The roster should adopt it
in the same pass, or the two benches will disagree about how a model gets picked.

## Open questions

**~~The rationale is homeless.~~ Settled.** Purpose took the card's one prose
slot, so the scan's per-seat argument (`rationale: z.string().max(600)`) had
nowhere to render: the collapsed receipt answers "was this cast grounded?" but
nothing answered "why *this* seat?". It now rides the charter panel's seat card
as `why cast:`, beside the charter it argues for — making that panel the seat's
full story rather than only its identity.

**Read-only settles provenance.** Dropping charter editing removes the question
raised in the first pass: every charter on the board is the scan's, so the
receipt still describes what you're approving and no "edited by you" footnote is
needed. The charter stays mutable after approve, on the member, via the roster.
This board is now purely a decision surface: read, drop, retune the model, approve.

## Non-goals

Editing a charter here (that's the roster's job, on a real member). Any new
**surface region** — the charter key is a drill-down, opened by an action's
open-canvas effect exactly as the run detail is, never a panel of its own. Beyond
that this is a recomposition of one board plus two verbs, on the rib that already
owns it.
