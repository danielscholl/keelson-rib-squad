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
a roster of named team **members** you author (genesis), each surfaced as a
first-class Keelson chat agent and rendered as a canvas board on a **Squad**
surface. The harness stays domain-free, and the rib ships **zero React** into the
trusted SPA.

This is the **Phase-0 thin slice**: it proves the surface + chat loop. Rooms,
lenses, member-to-member work, and reflection are later phases.

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

The whole rib is one `Rib` object exported from `src/index.ts`. It contributes:

- **A view + a surface** — one static snapshot key (`rib:squad:roster`) bound to
  the canvas renderer, and the **Squad** nav surface that lays the roster out in
  its header. No hand-coded UI: the roster is a board a collector publishes.
- **Workflows** (`contributeWorkflows`) — `squad-roster` (a deterministic bash
  collector that reads the members from the data home and emits a roster board,
  bound fail-closed to `rib:squad:roster` via `validate: expectView`) and
  `squad-genesis` (one agent turn that authors a member's `charter.md` and persists
  it via the `squad_emit_member` write seam; `fail_on_tool_error`,
  `allowed_tools: ["squad_emit_member"]`).
- **Tools** (`registerTools`) — `squad_emit_member` (the genesis write seam),
  `squad_list_members` (read-only), and `squad_retire_member`. All are driver-free
  disk ops, always present. The hook captures `ctx.getDataDir` (data home),
  `ctx.refreshWorkflow`, `ctx.runAgentTurn`, and `ctx.getProjects` into module
  singletons (the latter two for later phases); `dispose` clears them.
- **Actions** (`onAction`) — payload-carrying board verbs: `enter-member` (→ an
  `open-chat` client effect), `set-model`, `retire`, `author-archetype`, and
  `describe-own` (→ `run-workflow` effects for `squad-genesis`). Frame-origin
  (`canvas-html`) actions are rejected outright — there is no chart iframe yet.
- **Agents** — every member is enterable as a keelson agent (`listAgents` /
  `resolveAgent`), both building the SAME seed as the roster Enter action
  (`buildSeedFor`) so the two entry points can't drift.

### Layout (where things live)

- `src/index.ts` — the `Rib` object, the workflow definitions, the tools, the
  action handlers.
- `src/member-store.ts` — file-based member persistence (one dir per member;
  `member.json` + `charter.md` + `memory.md` + `rules.md` + `log.md`).
- `src/compose.ts` — budgeted system-prompt stacking + `buildSeedFor`.
- `src/boards/roster.ts` — the pure roster board builder.
- `src/genesis.ts` — slug naming + safety primitives.
- `src/paths.ts` / `src/keys.ts` / `src/starters.ts` / `src/types.ts` — the seams.
- `bin/collect-roster.ts` — the out-of-process roster collector.

### Invariants worth protecting

- **Zero React into the trusted SPA.** The roster renders through the canvas
  `board` contract, never hand-coded UI shipped from the rib.
- **Attach only through the `Rib` contract** (`@keelson/shared`). Don't reach
  around it into harness internals.
- **Fail closed.** The roster publishes through `validate` (`expectView`) and the
  node `output_schema`; the stores reject an unsafe slug (`assertSafeSlug`) and
  refuse to clobber an existing member; genesis fails the run on a tool error.
- **Fresh seam capture per boot.** `registerTools` re-captures the ctx seams each
  activation; `dispose` clears them so a re-boot recaptures the new ctx's.
- **The collector degrades, never throws.** A missing members/ dir yields a valid
  empty board.

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
