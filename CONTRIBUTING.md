# Contributing to @keelson/rib-squad

Thanks for your interest in the Squad rib. This document captures the conventions
and required checks for every pull request. Squad is a
[Keelson](https://github.com/danielscholl/keelson) rib — a standalone package the
harness discovers at runtime — so its contribution flow is lighter than the
keelson monorepo's. Where this file is silent, the
[keelson CONTRIBUTING guide](https://github.com/danielscholl/keelson/blob/main/CONTRIBUTING.md)
is the parent.

## Development environment

You need [Bun](https://bun.sh/) on PATH. The rib has one runtime peer,
`@keelson/shared`, which the harness provides at runtime; for local development
you resolve it from a keelson checkout.

```bash
git clone https://github.com/danielscholl/keelson-rib-squad.git
cd keelson-rib-squad
bun install
mkdir -p node_modules/@keelson && ln -sfn ../../keelson/packages/shared node_modules/@keelson/shared
```

`@keelson/shared` is declared an **optional** peer dependency: the rib installs
and its tests run without it (they use stubs), but typechecking against the `Rib`
contract needs it linked. CI resolves it the same way — a symlink to a
`danielscholl/keelson` checkout's `packages/shared`, sourced from `main`, so a
harness contract change that breaks this rib turns CI red here.

To exercise the rib inside a running harness, link it into a local keelson and
launch the dev server:

```bash
bun run link:keelson   # defaults to ../keelson; override with KEELSON_DIR
cd ../keelson && KEELSON_RIBS=squad bun dev
```

Then open `http://127.0.0.1:5173` and select the **Squad** tab (or **Ribs**).
Squad needs a configured provider (Copilot/Claude, or `KEELSON_PROVIDERS=stub` to
try the wiring) — no external CLIs.

## Required checks before opening a PR

Every PR must keep these green. CI runs the same commands.

```bash
bun run check       # Biome lint + format check
bun run typecheck   # tsc --noEmit (needs @keelson/shared linked)
bun test            # runs with stubs; CI sets KEELSON_USE_STUBS=1
```

Run `bun run check:fix` to auto-fix the safe lint and format issues.

## Commit messages

Conventional commit format (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`,
`test:`). One sentence in the subject (under 70 characters). Body — when needed —
explains *why*, not *what*; the diff already shows the what.

## Pull request hygiene

- Keep PRs scoped to one thing. Split refactors out of feature work.
- The PR description should answer: what changed, why now, how it was tested.
- Don't add new abstractions ahead of a concrete second caller.
- Don't add comments that narrate the change — that belongs in the PR
  description, not the source. Add a comment only when it captures a non-obvious
  *why* a future reader would need.

## Architecture rules

- All squad machinery — genesis, the roster board, the member store — lives in
  this rib. The harness stays domain-free.
- The rib ships **zero React** into the trusted SPA; the surface renders through
  the canvas `board` view, not hand-coded UI.
- The rib attaches to the harness only through the `Rib` contract
  (`@keelson/shared`). Don't reach around it into harness internals.
- Stores fail closed: an unsafe slug is rejected, a collision refuses to clobber,
  and boards publish through `validate` (`expectView`).

## Security

For security-sensitive reports, see keelson's
[SECURITY.md](https://github.com/danielscholl/keelson/blob/main/SECURITY.md).
Please do not file public GitHub issues for vulnerabilities.
