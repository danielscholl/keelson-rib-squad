# @keelson/rib-squad

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Keelson Rib](https://img.shields.io/badge/Keelson-rib-1e3a5f.svg)](https://github.com/danielscholl/keelson)
![Status: Experimental](https://img.shields.io/badge/status-experimental-orange.svg)
[![Runtime: Bun](https://img.shields.io/badge/runtime-Bun-black.svg)](https://bun.sh/)

**A squad of named team members for [Keelson](https://github.com/danielscholl/keelson).**

Squad brings the "squad" model of repo development onto Keelson as an installable
extension: you author a roster of named team members — a Lead, an Engineer, a
Reviewer, a Tester, or whatever the work needs — and each one becomes a
first-class Keelson chat agent you can talk to directly. The roster renders as a
canvas board on a **Squad** surface, with no hand-coded UI; the harness stays
domain-free, and the rib ships **zero React** into the trusted SPA.

> Status: **experimental.** The `Rib` contract it builds on is still pre-1.0.

## What it adds

- **Genesis and casting** — author a persistent member on demand from a freeform
  brief (the `squad-genesis` workflow), or auto-cast a whole team from a confined,
  read-only scan of a project's repository (propose, review, approve or discard).
  Each member is a directory under the data home with a `charter.md`, `memory.md`,
  `rules.md`, and `log.md`.
- **Roster** — a deterministic canvas board (the `squad-roster` workflow) with one
  card per member: a themed identity, the role pill, the charter, and the
  Enter / Set model / Retire controls. Zero members renders a cold-start launchpad
  with role archetypes.
- **The standing coordinator** — hand the squad a task and it plans, delegates one
  step at a time to the best-suited member, verifies its own claims of progress
  against real check/typecheck/test output, and replans until the goal is met or it
  gives up. Each step can dispatch a text-only conversation, run a confined coding
  turn that edits the repository, or author a reusable workflow for the operator to
  run later.
- **Mixed providers** — pin a member's provider and model independently (a
  reviewer on one vendor, a coder on another), and optionally pin the coordinator's
  own manager turn, so the squad's judgment is not all one model's opinion.
- **Governed memory** — a shared, evidence-default decision ledger the coordinator
  recalls from and writes back to at the end of a run, distinct from each member's
  own private memory.
- **A non-overridable policy floor** — the squad can open a pull request but can
  never merge or force-push its own change, and a BLOCKing review verdict stops a
  run cold.
- **Talk to a member** — every member is enterable as a Keelson chat agent: Enter
  on the roster card (or `resolveAgent`) opens a fresh chat seeded with the
  member's composed charter.

## Install into Keelson

Into an installed Keelson (the managed home at `~/.keelson`):

```bash
keelson rib add https://github.com/danielscholl/keelson-rib-squad
keelson start
```

To remove it later, uninstall by its rib id and restart:

```bash
keelson rib remove squad
keelson stop && keelson start
```

## Requirements

- A configured Keelson with a provider (Copilot, Claude, Codex, Pi, or any
  OpenAI-compatible gateway; Copilot is the default) — or `KEELSON_PROVIDERS=stub`
  to try the wiring offline.
- No external CLIs. `@keelson/shared` comes from the harness as a peer dependency
  (one copy shared across the harness and every rib).

## Try it

Open `http://127.0.0.1:7878` → the **Squad** surface, then:

- **Add a member** — `keelson workflow run squad-genesis --inputs brief="a terse
  SRE who reasons about blast radius"` (or use a role archetype on the cold-start
  board). It authors a member you'll see on the Roster.
- **Talk to a member** — click **Enter** on a roster card to open it as a seeded
  chat, or reach it through `/api/agents`.

## Develop locally

```bash
bun install
# resolve the contract from a local keelson checkout (CI does the same):
mkdir -p node_modules/@keelson && ln -sfn ../../keelson/packages/shared node_modules/@keelson/shared

bun test                   # rib identity + pure builder coverage (uses stubs)
bun run typecheck
bun run check              # biome lint + format

# Wire into a local Keelson checkout (defaults to ../keelson; override KEELSON_DIR):
bun run link:keelson
cd ../keelson && KEELSON_RIBS=squad bun dev
```

Then open `http://127.0.0.1:5173` → the **Squad** tab (or **Ribs**).

## Acknowledgments

This rib is a clean-room port of [Squad](https://github.com/bradygaster/squad)
(MIT, by Brady Gaster and contributors), the originating human-led multi-agent
runtime for repo development. It imports no upstream code; Squad's model — a
roster of named team members you author and direct against a repository — is
re-typed here and driven by the `Rib` contract. Full attribution lives in
[NOTICE](NOTICE).

## License

Licensed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for
attribution.
