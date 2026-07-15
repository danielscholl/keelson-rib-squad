---
title: Tools and commands
description: The exact chat tools, agents seam, and board action verbs Squad registers with the harness, and the plain fact that it ships no slash commands.
sidebar:
  order: 5
---

Squad exposes its capabilities to the harness as a Keelson rib: chat tools an
agent can call, an agents seam that makes every member enterable on its own,
and board action verbs the surface dispatches. This page is the terse
contract for all three. The behavior behind each entry lives in the concept
and guide pages; here are the exact names, schemas, and effects.

## Chat tools

Seventeen tools, all named with a `squad_` prefix and all registered
unconditionally (registration does not depend on which harness seams are
wired; several fail closed at call time instead, see
[Seam-dependent tools](#seam-dependent-tools)). Input fields are the Zod
schemas; an optional field is marked `?`. The rows are in registration order.

| Tool | `state_changing` | Purpose | Input fields |
|---|---|---|---|
| `squad_emit_member` | yes | Persist an authored member (charter plus record) under `members/<slug>`. Internal write seam for the `squad-genesis` workflow. Run the workflow (for example `/workflow run squad-genesis <brief>`) rather than calling this directly. | `name`, `role`, `charter`, `model?`, `provider?`, `tools?`, `toolAllowlist?`, `castAs?`, `project?` |
| `squad_casting_options` | no | Read-only casting context for authoring a themed identity: the active ensemble and its remaining capacity, previously used ensembles, the catalog, names already taken, and any operator-pinned ensemble. Called by the same turn that authors the member. Never fails: a missing registry or theming turned off reads as `{ mode: "off" }`. | `project?` |
| `squad_list_members` | no | List the roster: slug, name, role, charter, status, pinned model/provider, and capability tags. Read-only. | `project?` |
| `squad_retire_member` | yes | Permanently remove a member's record and charter. Fails closed if no such member exists. | `slug`, `project?` |
| `squad_remember` | yes | Record a learning into a member's **private** memory, distinct from the shared governed decision ledger. `target` selects whether the write appends to a running journal or overwrites the durable memory document. | `slug`, `text`, `target?` (`"log"` default, or `"memory"`) |
| `squad_dispatch` | yes | Fan one task out to multiple members in parallel, each a text-only, read-only turn, then by default add a closing synthesis turn. | `task`, `members?`, `synthesize?` |
| `squad_code` | yes | Run a confined coding turn for one code-capable member with real Read/Glob/Grep/Edit/Write/Bash access, confined to the selected project's root. The turn may not merge or force-push. | `member`, `task`, `project?` |
| `squad_open_pr` | yes (confirm) | Open an operator-requested **draft** change request: branch at HEAD from `title`, push without force, then open a draft PR/MR via the detected forge CLI (`gh` or `glab`) with `body`. Never merges, rebases, resets, force-pushes, or runs automatically at the done-gate. | `title`, `body`, `project?` |
| `squad_resolve_review` | yes (confirm) | Operator-triggered review follow-up: fetch unresolved PR/MR threads on the current branch, run the coordinator through the normal verify/review-gated loop to address them, push with a plain `git push`, reply to every fetched thread, and resolve only the threads marked fixed. Never force-pushes, merges, deletes branches, or resolves declined threads. | `project?` |
| `squad_view_diff` | no | Show the selected project's staged, unstaged, and untracked git diff using the same bounded capture as the review gate. Read-only: runs only diff/status-style commands. | `project?` |
| `squad_propose_cast` | yes | Run one confined read-only scan of the selected project and persist a proposed roster for the operator to approve or discard. Internal write seam for the `squad-cast-scan` workflow. Not meant to be called directly. | `mission?` |
| `squad_runs` | no | List archived coordinator runs for the resolved scope. Read-only. | `project?` |
| `squad_report` | yes | Compose the deterministic styled HTML report for one archived run and publish it to the Run report canvas. Reads only the run ledger (no agent turn). Omitting `run_id` reports the most recent archived run for the scope. | `run_id?` |
| `squad_stop` | yes | Stop the live coordinator run for the resolved scope. Returns once the stop has been requested. A detached run can also be stopped by run id via the generic `run_cancel`. | `project?` |
| `squad_steer` | yes | Inject an operator instruction into the live coordinator run; the run folds it into its facts and honors it on the next round. Errors when no run is live in scope. A detached run can also be steered by run id via the generic `run_steer`. | `instruction`, `project?` |
| `squad_rollback` | yes (confirm) | Preview or perform a rollback of an aborted/failed run. Without `confirm: true` it returns the full manifest and mutates nothing; with it, rewinds commits, restores tracked paths to the run baseline, deletes files the run created, then writes the rollback event last. Refuses if HEAD was rewritten, a merge/rebase is in progress, or the run is not rollbackable. | `project?`, `run?`, `confirm?` |
| `squad_coordinate` | yes | Run the standing coordinator loop end to end against a task and return a summary plus a round-by-round trace. | `task`, `project?`, `members?`, `managerModel?`, `managerProvider?`, `maxRounds?` (1–100), `maxStall?` (1–20), `maxResets?` (1–20), `maxTokens?` (1000–100000000), `verify?` |

`squad_open_pr`, `squad_resolve_review`, and `squad_rollback` additionally set
`requires_confirmation`, so the harness prompts the operator before the call
runs: each one writes to a real remote or rewinds a real working tree.

### Field detail

A few schemas carry constraints or defaults worth stating exactly:

- `squad_dispatch`'s `members` is optional; omitting it dispatches to every
  active member. `synthesize` defaults to `true`.
- `squad_code`'s `project` is an optional id or name; omitting it falls back
  to the operator's current project selection, or the sole project when there
  is only one. The turn's write access is confined to that project's root.
  Merging or force-pushing from inside the turn is denied outright by the
  squad governance floor (see [Governance floor](#governance-floor)); opening
  a draft PR or an ordinary push is allowed.
- `squad_coordinate`'s `maxRounds` bounds how many plan-delegate-observe
  rounds the loop can run; `maxStall` and `maxResets` cap how much
  no-progress churn it tolerates before giving up. `maxTokens` is the token
  analogue of `maxRounds`: a cumulative budget for the whole run, which halts
  with a `max-tokens` status when usage crosses it. `verify`'s items are shell
  commands executed via `bash -c` in the project root, not prose acceptance
  criteria — a prose item typically fails (often exit 127). When the operator supplies
  no explicit `verify` commands, the tool auto-detects `check`, `typecheck`,
  and `test` scripts from the target project's `package.json` and runs them
  with `bun` or `npm` depending on which lockfile is present. An unresolvable
  selector or a non-Node project simply runs with no verify step: the
  done-gate is open, not closed, in that case.
- `squad_runs`'s `project` resolves scope the same way `squad_coordinate`
  and `squad_code` do; an explicit but unknown project errors rather than
  silently falling back to the default scope.

### Seam-dependent tools

Every tool is registered regardless of which seams the harness wires in; a
seam-dependent tool call fails closed with an explicit "seam unavailable on
this harness" error rather than the tool being absent from the list. Which
seam each one needs:

- **No seam (driver-free disk ops, usable on any harness)**:
  `squad_emit_member`, `squad_casting_options`, `squad_list_members`,
  `squad_retire_member`, `squad_remember`, `squad_runs`.
- **Agent-turn seam** (it runs a turn): `squad_dispatch`, `squad_code`,
  `squad_coordinate`, `squad_propose_cast`, `squad_resolve_review`.
- **Exec seam** (it shells out to git or a forge CLI): `squad_open_pr`,
  `squad_view_diff`, `squad_rollback`, and `squad_resolve_review`.
- **Snapshot seam** (it republishes a canvas): `squad_report`.

The projects seam resolves a repository for any tool taking a `project`
argument, and an explicit but unknown project errors rather than silently
falling back to the default scope. How hard a tool depends on the seam varies:
`squad_code` and `squad_open_pr` check for it up front and fail closed without
it, because they cannot confine a turn or pick a remote with no repository. The
rest only need it to resolve an explicit `project`, reading the operator's
current selection otherwise.

## Governance floor

Squad contributes a small, non-overridable policy the harness evaluates
first-deny-wins on every Squad agent turn: it denies a self-merge or a
force-push outright, and it fails a run when a review produces a BLOCK
verdict (that enforcement is scoped to the workflow surface, not chat). This
is what lets `squad_code` and the coordinator open real pull requests without
the squad ever being the thing that merges its own change; a human stays the
merge gate.

## The agents seam

Every member is directly enterable as a Keelson chat agent, showing up
wherever the harness lists agents:

- `listAgents` reads the members on disk and returns each as a slug, name,
  and description summary.
- `resolveAgent(slug)` returns the seed for that member, built from the same
  seed-composition path the roster's Enter action uses, so the two entry
  points cannot drift apart.

## Slash commands

Squad currently registers no slash commands at all. Unlike some sibling
ribs, it exposes no `/`-prefixed shortcuts; every capability above is reached
through a chat tool, a board action, or a bundled workflow.

## Board action verbs

The surface dispatches actions to the rib by a verb string. Each returns a
result; some carry an `effect` the host interprets (open a chat, run a
workflow), and the rest return plain data the surface reads without
navigating.

| Verb | Payload | Effect returned |
|---|---|---|
| `enter-member` | `{ slug }` | `open-chat` (the composed seed) |
| `select-project` | `{ scopeId }` | data (`{ scopeId }`); refreshes the roster, cast, coordinator, and runs panels |
| `author-archetype` | `{ slug }` | `run-workflow` `squad-genesis`, seeded with the archetype's brief |
| `describe-own` | `{ brief }` | `run-workflow` `squad-genesis`, seeded with the operator's brief |
| `cast-propose` | `{ mission? }` | `run-workflow` `squad-cast-scan` |
| `cast-pick` | `{ slug, picked, castAt? }` | data (`{ slug, picked }`); refreshes the cast panel |
| `approve-cast` | `{ castAt? }` | data (`{ created, skipped, truncated, dropped }`) |
| `discard-cast` | `{ castAt? }` | data (`{ discarded: true }`) |
| `set-model` | `{ slug, model?, provider? }` | data (`{ slug, model? }`) |
| `retire` | `{ slug }` | data (`{ slug }`) |
| `retire-all` | _(none)_ | data (`{ retired }`); dispatched from the Roster panel head's `⋯`, not a board section |
| `coordinate` | `{ task }` | `run-workflow` `squad-coordinate-run`, `stay: true` |
| `dispatch` | `{ task }` | `run-workflow` `squad-dispatch-run` |
| `assign-code` | `{ slug, task }` | `run-workflow` `squad-code-run` |
| `record-decision` | `{ summary, content }` | `run-workflow` `squad-decide` |

`coordinate` sets `stay: true`, which keeps the operator on the Squad surface
(rather than switching to the Workflows tab) so they can watch the Run loop
panel stream round by round. `assign-code` preflights that the named member
exists, is active, and is code-capable before launching the run, so a stale
card button cannot kick off a run that is guaranteed to fail.

Squad has no HTML-canvas surface, so any action arriving with a sandboxed
canvas-iframe origin is rejected outright: there is nothing legitimate that
origin should ever be able to trigger.

## Related

- [Surface](../surface/): the panels these tools and actions publish to and
  launch from.
- [Workflows](../workflows/): the node-by-node shape behind
  `squad-coordinate-run`, `squad-cast-scan`, and the other workflows these
  tools front.
- [Method agency](../../concepts/method-agency/): the coordinator's per-round
  choice among dispatch, code, and workflow authoring, the same three
  methods `squad_dispatch`, `squad_code`, and `squad_coordinate` expose as
  standalone tools.
- [Governed autonomy](../../design/governed-autonomy/): the design rationale
  behind the non-overridable governance floor.
- [Keelson rib contract](https://danielscholl.github.io/keelson/docs/reference/rib-contract/):
  the generic tool, agent, and action surface a rib plugs into.
