# Copilot code review — instructions for @keelson/rib-squad

This rib is the **Squad** extension for
[Keelson](https://github.com/danielscholl/keelson), the local-only agent harness
— a single-package Bun + TypeScript project. It casts a roster of coding-agent
**members** you author (genesis), then dispatches and coordinates their parallel
work against a selected project: a standing manager plans, delegates one step at
a time (text, a confined coding turn, or an authored workflow), proves the result
at a done-gate, and opens a draft PR for a human to merge. Every member's turn is
**policy-governed** (an RAI floor the harness evaluates first-deny-wins) and
**memory-ledgered**. It ships **zero React**. See `AGENTS.md` for the full
architecture.

## How to review

Be terse and cite `file:line`. Prefer a few high-signal findings over breadth.
This is single-user, local software — ignore speculative scale, multi-tenant, and
micro-optimization concerns. No poems, jokes, or emoji.

## Comment policy — do NOT push comments or docstrings

`CONTRIBUTING.md` sets a deliberate **no-narration** policy. Do **not**:

- Ask for docstrings or comment coverage. Comments are optional; a one-line
  soft-wrap is fine and should not be flagged.
- Suggest comments that narrate what a PR changed, restate well-named code, or
  recap review history.

A comment is warranted only when it captures a non-obvious **why** (a hidden
constraint, a workaround, an order dependency, an invariant from another module).
Flag a comment only when it *violates* the policy (narration / what-just-changed),
not when one is merely absent. Never repeat one observation across N sites — make
the point once, on the clearest instance.

## Invariants to flag when a change breaks them

- **No merging or force-pushing from an agent turn.** This is the sharpest
  invariant. The RAI floor (`policies.ts`) denies a member's turn from merging its
  own work or rewriting history; the detection lives in `forbidden.ts`, which
  **tokenizes** the command (it deliberately over-matches) to gate `git push`
  force/delete variants (`--force`, `-fv`, `+refspec`, `:dst`, `--mirror`), a
  `git -C dir push` global option before the subcommand, `gh pr merge`, a
  `gh api …/pulls/<n>/merge` write, the `mergePullRequest` / `enablePullRequestAutoMerge`
  GraphQL mutations, and named merge tools (`isMergeToolName`). Flag any change
  that weakens this back toward a flat regex, drops a force-push/merge variant, or
  lets a merge / history-rewrite reach the harness.
- **The floor is non-overridable and governs the right surfaces.** `raiFloor` is
  first-deny-wins over the `workflow` and `rib` surfaces only (chat/MCP are the
  operator's own context, deliberately out of scope); a **structured** BLOCK
  verdict from one of squad's OWN workflows (`isOwnWorkflow`,
  `hasBlockVerdictDirective`) fails the node rather than being re-prompted past.
  Flag making the policy overridable, widening it onto the operator's chat/MCP
  surfaces, or a path that lets a run continue past a real BLOCK verdict.
- **Code mode fails closed.** `runCodeTurn` (`code.ts`) grants write tools
  (`Edit`/`Write`/`Bash`) only when the member carries the `code` capability AND
  the selected project has a root path — the turn is bounded to that root
  (`cwd` + `allowedDirectories: [root]`) with `CODE_TOOLS` as its entire surface.
  Flag granting write tools without the confinement, running a code turn with an
  empty/unset root or a non-code-capable member, or widening `CODE_TOOLS`.
- **Integration is draft-only and human-gated.** `open-change-request.ts` opens a
  `--draft` PR/MR via `gh` / `glab`; nothing in the rib merges. Ordinary pushes and
  PR *creation* are allowed — only the human review gate merges. Flag a new path
  that merges, auto-merges, or force-pushes, or one that drops the `--draft` flag.
- **A coding turn cannot delete pre-existing tracked files.** After a code turn,
  `confineBaselineDeletes` (`confinement.ts`, called from `coordinator.ts`) diffs
  the baseline tree against the current tree and `git restore`s any baseline file
  the turn removed. Flag removing or bypassing this restore, or a code path that
  lets a turn's deletions stand unconfined.
- **The done-gate is machine-proven, not self-asserted.** Operator-configured
  `verify` commands run at the done-gate via the exec seam (`coordinator.ts`); a
  red exit vetoes `done`. Flag a change that lets a run declare done while a verify
  command is failing, or that treats prose acceptance criteria as a runnable verify
  command.
- **Attach only through the `Rib` contract** (`@keelson/shared`), and ship **zero
  React**. Boards render through the canvas `board` / `view` contract and publish
  through `validate` (`expectView`); stores fail closed (`assertSafeSlug` rejects an
  unsafe slug, a collision refuses to clobber an authored member). Flag reaching
  around the contract into harness internals, a new hard dependency on a harness
  package beyond the `@keelson/shared` peer, hand-coded UI/React shipped from the
  rib, an unvalidated board, or a store write that accepts an unsanitized slug or
  clobbers an existing member.
- **Memory writeback is governed and fail-soft.** `memory.ts` reflects a run's
  outcome back as an **evidence-default, review-gated** `decision` row (the server
  forces `review_status` pending — a writeback cannot mint an instruction-grade
  row); recall and reflection degrade to no-memory rather than crash a run. Flag a
  writeback that tries to self-approve or mint an instruction row, or a memory path
  that throws instead of failing soft.

## What NOT to flag

- Missing docstrings or comments (see the comment policy above).
- Tests (`test/**`) using `bun:test`, JSON fixtures, or mock-vs-real tradeoffs —
  these are intentional.
- A collector or forge path degrading (empty roster, missing `gh` / `glab`, no
  selected project) instead of throwing — the rib is designed to render empty and
  fail soft.
- Speculative scale / multi-tenant / micro-optimization concerns.
- The absence of an abstraction — this repo avoids abstractions ahead of a
  concrete second caller.
- Formatter-owned style — Biome owns lint and format.
