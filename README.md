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

> Status: **experimental.** This is the Phase-0 thin slice: genesis (author a
> member from a brief), the roster board, and entering a member as a seeded chat.
> The `Rib` contract it builds on is still pre-1.0.

## What it adds (Phase 0)

- **Genesis** — author a persistent member on demand from a freeform brief (the
  `squad-genesis` workflow). Each member is a directory under the data home with a
  `charter.md`, `memory.md`, `rules.md`, and `log.md`.
- **Roster** — a deterministic canvas board (the `squad-roster` workflow) with one
  card per member: a hashed identity dot, the role pill, the charter, and the
  Enter / Set model / Retire controls. Zero members renders a cold-start launchpad
  with role archetypes.
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

The rib's structure — a canvas-board surface, genesis-as-a-workflow, and the
fail-closed snapshot binding — follows the
[@keelson/rib-chamber](https://github.com/danielscholl/keelson-rib-chamber) rib's
patterns, re-typed for the squad domain.

## License

Licensed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for
attribution.
