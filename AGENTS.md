# AGENTS.md

This is the canonical project guidance for coding agents — Codex, GitHub
Copilot's coding agent, and (via an import in `CLAUDE.md`) Claude Code — working
in this repository. `CONTRIBUTING.md` is the authoritative human guide; this is
its agent-facing distillation.

It records only what stays true across changes: the contract, the commands, the
recurring patterns, and the invariants. Inventories — how many tools, workflows,
actions, or boards exist and what they are named — live in the code, change
often, and are deliberately NOT recorded here. Derive them from the code when
you need them; the `/prime` command does exactly that.

## What this is

`@keelson/rib-squad` is a **rib** (extension) for
[Keelson](https://github.com/danielscholl/keelson), the local-only agent harness.
A rib is a standalone package the harness discovers at runtime and attaches
through one typed contract — the `Rib` interface from `@keelson/shared`. Squad adds
a roster of named team **members** you author — one at a time from a brief
(genesis) or a whole team auto-cast from a confined repo scan — each surfaced as a
first-class Keelson chat agent and rendered as canvas boards on a **Squad**
surface. On top of the roster sits a **standing coordinator loop** that takes a
task and plans, delegates one step at a time to the best-suited member, verifies
its own claims of progress against real check/typecheck/test output, and replans
until the goal is met or it gives up. The harness stays domain-free, and the rib
ships **zero React** into the trusted SPA.

Everything is **per-project scoped** on disk, and a non-overridable **governance
floor** lets the squad open a pull request but never merge or force-push its own
change.

## Commands

Bun. Everything is workspace-local; there is no monorepo.

```bash
bun install                  # one-time
# resolve @keelson/shared from a local keelson checkout (CI does the same):
mkdir -p node_modules/@keelson && ln -sfn ../../keelson/packages/shared node_modules/@keelson/shared

bun test                     # rib identity + pure builder coverage (uses stubs)
bun run typecheck            # tsc --noEmit (needs @keelson/shared linked)
bun run check                # Biome lint + format (required pre-PR)
bun run check:fix            # auto-fix safe lint/format

bun run link:keelson         # symlink this rib into ../keelson (override KEELSON_DIR)
cd ../keelson && KEELSON_RIBS=squad bun dev   # exercise it in a running harness
```

`CONTRIBUTING.md` gates every PR on `bun run check`, `bun run typecheck`, and
`bun test` all green. CI resolves `@keelson/shared` as a symlink to a
`danielscholl/keelson` checkout's `packages/shared` from `main`, so a harness
contract change that breaks this rib turns CI red here.

## Architecture (the shapes, not the inventory)

The whole rib is one `Rib` object exported from `src/index.ts`. Note that
`index.ts` is a large **assembly file**, not a thin composition root: it holds
the tool definitions, the workflow prompts, and the action handlers inline, and
imports the domain logic from the modules under `src/`. The recurring shapes:

- **Every panel is a board a producer publishes.** No hand-coded UI ships from
  the rib. Producers come in two shapes: cheap deterministic **bash collectors**
  (`bin/collect-*.ts` scripts that read a file off the data home and emit a
  board, bound fail-closed to their view key via node `output_schema` +
  `validate: expectView`), and **prompt turns** that each call exactly one squad
  tool with `fail_on_tool_error` and a named `allowed_tools` opt-in (rib tools
  are default-off in workflow nodes). Anything that costs a paid turn to render
  carries no cadence.
- **Tools register unconditionally, fail closed at call time.** Some tools are
  driver-free disk ops usable on any harness; the rest depend on a harness seam
  (agent-turn, exec, projects, …) and return "seam unavailable on this harness"
  when it is absent — they are never missing from the list. Tools that touch a
  real remote or working tree require confirmation.
- **`registerTools` is the seam-capture point.** It is the only hook with the
  full ctx: it captures the data home (`ctx.getDataDir`, baked into the
  collector bash nodes) and the seam singletons, and imperatively registers the
  drill-down snapshots. `dispose` clears and unregisters all of it so a re-boot
  recaptures the new ctx's.
- **The coordinator loop** (`src/coordinator.ts`) is a standing run over one
  task and project. Each round: recall governed memory → a manager turn assesses
  progress → picks one method for one member → executes that one step → reflects
  (a repeated outcome is a stall and forces a re-plan). A step's method is a
  text-only fan-out (`dispatch.ts`), a confined coding turn write-railed to the
  project root (`code.ts` + `turn-runner.ts`), or authoring a reusable workflow
  DAG (`workflow-authoring.ts`).
- **Policies** (`contributePolicies` → `squadPolicies`) are the non-overridable
  governance floor, evaluated first-deny-wins on every squad turn: deny
  self-merge and force-push outright; fail a workflow-surface run on a BLOCK
  review verdict. This is what lets the squad open real PRs without ever being
  the thing that merges its own change.
- **Actions** (`onAction`) are a verb switch driving the board buttons. The verb
  STRINGS are defined where the boards emit them (`src/boards/*.ts`) and can
  differ from the constant names in the switch — trust the strings. Any
  `canvas-html`-origin action is rejected outright.
- **Members are agents.** Every member is enterable as a keelson agent
  (`listAgents` / `resolveAgent`), and both entry points build the SAME seed as
  the roster Enter action (`buildSeedFor`) so they can't drift.

## Layout (where things live)

- `src/index.ts` — the `Rib` object plus the inline tool definitions, workflow
  prompts, and action handlers (the assembly file).
- `src/coordinator.ts` — the run-loop engine; `src/orchestrator.ts` — the loop
  limits; `src/turn-runner.ts` — one member turn; `src/live-runs.ts` —
  stop/steer of an in-flight run; `src/rollback*.ts` — rollback preview + store.
- `src/dispatch.ts` / `src/code.ts` / `src/workflow-authoring.ts` — the
  coordinator's step methods.
- `src/cast.ts` + `src/casting/` — auto-cast a team and assign themed identities.
- `src/member-store.ts` — file-based member persistence (one dir per member).
- `src/paths.ts` / `src/scope.ts` — the per-project scope model and data-home
  resolution; `src/runs-store.ts` — archived run ledgers.
- `src/policies.ts` / `src/forbidden.ts` — the governance floor; `src/memory.ts`
  — the governed decision-ledger seam; `src/compose.ts` — system-prompt stacking
  + `buildSeedFor`.
- `src/boards/` — pure board builders; `bin/` — the out-of-process collectors.
- `src/genesis.ts` / `src/keys.ts` / `src/starters.ts` / `src/types.ts` — the
  seams and the domain types.

## Invariants worth protecting

- **Zero React into the trusted SPA.** Every panel renders through the canvas
  `board` contract, never hand-coded UI shipped from the rib.
- **Attach only through the `Rib` contract** (`@keelson/shared`). Don't reach
  around it into harness internals.
- **The governance floor is non-overridable.** No self-merge, no force-push; a BLOCK
  review verdict fails a workflow-surface run. A confined coding turn is write-railed
  to the selected project's root.
- **Per-project scope isolation.** Every member, proposal, ledger, and run archive
  lives under its scope's directory; the `DEFAULT_SCOPE_ID` sentinel maps onto the
  flat data-home root so a pre-scoping roster is never orphaned.
- **Fail closed.** Collectors publish through `validate` (`expectView`) + the node
  `output_schema`; prompt turns set `fail_on_tool_error`; the stores reject an unsafe
  slug (`assertSafeSlug`) and refuse to clobber an existing member. A collector
  degrades, never throws — a missing file yields a valid empty board.
- **Coordinator runs are bounded and durable.** The loop is capped by explicit
  limits; the done-gate requires a clean review + verify for a code-changing
  run; run state persists so a stopped or restarted run resumes rather than
  starting over.
- **Fresh seam capture per boot.** `registerTools` re-captures the ctx seams each
  activation; `dispose` clears and unregisters them so a re-boot recaptures the new
  ctx's.

## Comments

`CONTRIBUTING.md` is authoritative. Default to **none**. Add a comment only when
it captures a non-obvious **why** a future reader needs — a hidden constraint, a
workaround, a non-obvious order dependency, an invariant from another module. No
PR-point-in-time narration, no what-just-changed notes, no restating the code.

## Conventions

- **Commits**: conventional (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`,
  `test:`), one-sentence subject under ~70 chars. The squashed PR title is what
  release-please reads, so the **PR title must be a conventional commit**.
- **PR body**: *What* / *Why now* / *Test plan*. No "Generated with" footers.
- **Workflow descriptions**: use the `Use when / Triggers / Does / NOT for` shape
  so the SPA workflow cards render scannably. Match it.
- **No abstractions ahead of a concrete second caller.**
