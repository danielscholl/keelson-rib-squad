# AGENTS.md

This is the canonical project guidance for coding agents — Codex, GitHub
Copilot's coding agent, and (via an import in `CLAUDE.md`) Claude Code — working
in this repository. `CONTRIBUTING.md` is the authoritative human guide; this is
its agent-facing distillation.

## What this is

`@keelson/rib-squad` is a **rib** (extension) for
[Keelson](https://github.com/danielscholl/keelson), the local-only agent harness.
A rib is a standalone package the harness discovers at runtime and attaches
through one typed contract — the `Rib` interface from `@keelson/shared`. Squad adds
a roster of named team **members** you author — one at a time from a brief
(genesis) or a whole team auto-cast from a confined repo scan — each surfaced as a
first-class Keelson chat agent and rendered as a canvas board on a **Squad**
surface. On top of the roster sits a **standing coordinator loop** that takes a
task and plans, delegates one step at a time to the best-suited member, verifies
its own claims of progress against real check/typecheck/test output, and replans
until the goal is met or it gives up. The harness stays domain-free, and the rib
ships **zero React** into the trusted SPA.

Everything is **per-project scoped** on disk, and a non-overridable **governance
floor** lets the squad open a pull request but never merge or force-push its own
change. The **Squad** surface is `projectScoped`: the host renders its
project-picker chip, and the `select-project` action sets the scope every panel and
tool keys on.

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

## Architecture

The whole rib is one `Rib` object exported from `src/index.ts`. Note that
`index.ts` is a large **assembly file**, not a thin composition root: it holds the
tool definitions, the workflow prompts, and the action handlers inline, and imports
the domain logic from the modules under `src/`. It contributes:

- **Views + a surface** — five snapshot keys (`rib:squad:{roster,cast,coordinator,
  runs,decisions}`) and one `projectScoped` **Squad** nav surface: the Roster in the
  header, then four rows — the **Run loop** (promoted to its own row, `live` so it
  pulses while a coordinator run streams round by round), **Proposed squad** (also its
  own row: its board lays the bench beside the scan's receipt via `columns`, and a half
  share collapses that adjacency), Runs, and Decisions. Content panels are
  `hideWhenEmpty`. No hand-coded UI: every panel is a board a producer publishes.
- **Workflows** (`contributeWorkflows`) — twelve, in two producer shapes. Four
  deterministic **bash collectors** (`squad-roster`, `-cast`, `-coordinator`,
  `-runs`) shell a `bin/collect-*.ts` script, read a file off the data home, and emit
  a board — each bound fail-closed to its key via node `output_schema` + `validate:
  expectView`. Six **prompt turns** (`squad-genesis`, `-cast-scan`, `-coordinate-run`,
  `-dispatch-run`, `-code-run`, `-rollback-run`) each call exactly one squad tool,
  with `fail_on_tool_error` and a named `allowed_tools` opt-in (rib tools are
  default-off in workflow nodes). Two more back the governed decision ledger:
  `squad-decide` (a constant bash node + a declarative `memory: { writeback }`) writes
  a row; `squad-decisions` (a `memory: { recall }` then a prompt render) publishes the
  Decisions board — the one paid-turn producer, which is why its region has no cadence.
- **Tools** (`registerTools`) — seventeen `squad_*` tools, all registered
  UNCONDITIONALLY. Many are driver-free disk ops usable on any harness
  (`squad_emit_member` — the genesis write seam — `squad_list_members`,
  `squad_retire_member`, `squad_remember`, `squad_casting_options`, `squad_runs`,
  `squad_report`). The rest depend on a harness seam — the agent-turn seam
  (`squad_dispatch`, `squad_code`, `squad_coordinate`, `squad_propose_cast`,
  `squad_resolve_review`), the exec seam (`squad_open_pr`, `squad_view_diff`,
  `squad_rollback`), or the projects seam to resolve a repo — and **fail closed at
  call time** with "seam unavailable on this harness" rather than being absent from
  the list. `registerTools` is the only hook with the full ctx: it captures the data
  home (`ctx.getDataDir`, baked into the collector bash nodes) and the seam singletons
  (`refreshWorkflow`, `runAgentTurn`, `getProjects`, `getProviders`, `acquireWorkspace`,
  `registerOp`), and imperatively registers the run-detail + run-report snapshots;
  `dispose` clears and unregisters all of it.
- **The coordinator loop** (`src/coordinator.ts`) — a standing run over one task and
  project. Each round: recall governed memory → a manager turn assesses progress →
  picks one method for one member → executes that one step → reflects (a repeated
  outcome is treated as a stall and forces a re-plan). It is bounded (`maxRounds` /
  `maxStall` / `maxResets`), and a "done" claim on a code-changing run is not accepted
  until an independent review and the project's own verify commands come back clean.
  The three methods a step can take: a text-only fan-out (`dispatch.ts`), a confined
  coding turn write-railed to the project root (`code.ts` + `turn-runner.ts`), or
  authoring a reusable workflow DAG (`workflow-authoring.ts`).
- **Policies** (`contributePolicies` → `squadPolicies`) — the non-overridable
  governance floor, evaluated first-deny-wins on every squad turn: it denies a
  self-merge or force-push outright, and fails a workflow-surface run on a BLOCK review
  verdict. This is what lets `squad_code` and the coordinator open real PRs without the
  squad ever being the thing that merges its own change.
- **Actions** (`onAction`) — a verb switch of 23, listed here by their action STRINGS
  (three constants disagree with theirs — `STOP_COORDINATOR_ACTION` is
  `"stop-coordinate"`, `STEER_COORDINATOR_ACTION` is `"steer-coordinate"`, and
  `REPORT_RUN_ACTION` is `"squad-report"`): `enter-member` (→ an `open-chat` client
  effect), `select-project`, the `run-workflow` verbs (`author-archetype` /
  `describe-own` / `cast-propose` / `coordinate` / `dispatch` / `rollback-run` /
  `record-decision`), the data verbs (`cast-pick` / `cast-model` / `approve-cast` /
  `discard-cast` / `set-model` / `retire` / `retire-all` / `reset-squad` /
  `dismiss-genesis` / `stop-coordinate` / `steer-coordinate`), and `view-run` /
  `squad-report` / `view-charter` (which drive the imperatively registered drill-down,
  run-report, and charter snapshots). A roster card carries no code verb: entering the
  member, `squad_code`, and the `squad-code-run` workflow are the paths to a confined
  coding turn. Any `canvas-html`-origin action is rejected outright — the run-report
  canvas is read-only and ships no frame actions.
- **Agents** — every member is enterable as a keelson agent (`listAgents` /
  `resolveAgent`), both building the SAME seed as the roster Enter action
  (`buildSeedFor`) so the two entry points can't drift.

### Layout (where things live)

- `src/index.ts` — the `Rib` object plus the inline tool definitions, workflow
  prompts, and action handlers (the assembly file).
- `src/coordinator.ts` — the standing run-loop engine (ledger, rounds, done-gate);
  `src/orchestrator.ts` holds `DEFAULT_LIMITS`; `src/turn-runner.ts` runs one member
  turn; `src/live-runs.ts` backs stop/steer of an in-flight run.
- `src/dispatch.ts` (text fan-out), `src/code.ts` (confined coding turn), and
  `src/workflow-authoring.ts` — the three coordinator methods.
- `src/cast.ts` + `src/casting/` (`registry` / `themes` / `engine` / `options`) —
  auto-cast a team and assign each member a themed identity.
- `src/member-store.ts` — file-based member persistence (one dir per member;
  `member.json` + `charter.md` + `memory.md` + `rules.md` + `log.md`).
- `src/paths.ts` / `src/scope.ts` — the per-project scope model and data-home
  resolution; `src/runs-store.ts` — archived run ledgers; `src/rollback*.ts` —
  rollback preview + store.
- `src/policies.ts` / `src/forbidden.ts` — the governance floor; `src/memory.ts` —
  the governed decision-ledger seam; `src/compose.ts` — budgeted system-prompt
  stacking + `buildSeedFor`.
- `src/boards/` — the five pure board builders (roster, cast, coordinator, runs,
  decisions); `bin/collect-*.ts` — the out-of-process collectors behind them.
- `src/genesis.ts` (slug naming + safety), `src/keys.ts`, `src/starters.ts`,
  `src/types.ts` — the seams.

### Invariants worth protecting

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
- **Coordinator runs are bounded and durable.** `maxRounds` / `maxStall` /
  `maxResets` cap the loop; the done-gate requires a clean review + verify for a
  code-changing run; run state persists so a stopped or restarted run resumes rather
  than starting over.
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
