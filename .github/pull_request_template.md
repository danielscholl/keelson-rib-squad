<!--
Title must be a conventional commit — it becomes the squash commit that
release-please reads to build the CHANGELOG and pick the version bump.
  <type>[(scope)][!]: <subject>   (subject one sentence, under ~70 chars)
  types: feat fix perf refactor docs chore style test build ci revert
  e.g.  fix(coordinator): clear the abandoned plan on re-plan
-->

## What

<!-- The functional change in 1–3 sentences, grouped by behavior (not file). The
diff shows the what; lead with the problem it solves. Name the issue/slice if
there is one, and note anything deliberately left OUT of scope. -->

## Why now

<!-- The motivation: what this fixes or unblocks, and what drove the timing. -->

## Test plan

<!-- A record of what you actually ran and the result (counts, "green") — not a
checklist of intent. Add live/manual verification beyond CI where it matters. -->

- [ ] `bun run check`
- [ ] `bun run typecheck`
- [ ] `bun test`

## Risk & rollback

<!-- OPTIONAL — delete this whole section if the change is trivial. Otherwise one
line each:
- Blast radius: which surfaces/seams this can affect (coordinator, cast,
  dispatch, memory, workflow-authoring).
- Compatibility: contract/env/data-home or breaking change (else "none").
- Rollback: how to back it out fast (revert, flag, config). -->

<!-- Closes #
Keep the PR scoped to one thing; split refactors out of feature work. -->
