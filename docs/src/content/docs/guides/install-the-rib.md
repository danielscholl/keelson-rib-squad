---
title: Install the rib
description: Add Squad to a running Keelson with rib add, restart, and confirm it is active.
sidebar:
  order: 2
---

Squad is a [Keelson](https://danielscholl.github.io/keelson/) rib, so the harness
loads it the same way it loads any other. This guide adds it to a Keelson you
already run.

## Add the rib

From your Keelson checkout, add the package and start the server:

```bash
keelson rib add https://github.com/danielscholl/keelson-rib-squad
keelson start
```

`keelson rib add` installs the package alongside the harness. The harness
discovers any installed `@keelson/rib-*` package under `node_modules/@keelson/`
at boot, so the install is all the wiring Squad needs. There is no separate
registration step and nothing to configure by hand.

## Restart to pick up changes

A rib only activates at boot, so any change to which ribs are installed needs a
restart to take effect:

```bash
keelson stop && keelson start
```

Run this after adding Squad if the server was already up, and again any time
you add or remove a rib alongside it.

## Choose which ribs activate

The harness reads `KEELSON_RIBS` to decide which discovered ribs to activate.
Leave it unset and every discovered rib activates, Squad included. Set it to a
comma-separated list to narrow the set; Squad's rib id is `squad`:

```bash
KEELSON_RIBS=squad keelson start
```

That variable is read by the harness, not by Squad. The rib has no env-based
configuration of its own.

## Confirm it is active

With the server up, open the harness in a browser:

```text
http://127.0.0.1:7878
```

Squad's own surface reads **Squad** in the tab list. If the tab is present, the
rib is active. Its surface is project-scoped, so the header carries the shared
project-picker chip; picking a project there is what every panel and tool on the
surface keys on.

You can check the same fact from the CLI:

```bash
keelson doctor
```

`keelson doctor` reports each discovered rib and whether it is active. If Squad
is installed but does not appear, check that `KEELSON_RIBS` (if set) includes
`squad`, and that the server was restarted after the install.

## What Squad needs

Squad's only hard requirement is a writable data home. The harness-provided
turn and project seams are reported as present or absent, but their absence is
not treated as a failure by the rib itself: it still activates and its surface
still renders, only the agent-turn workflows and tools fail when actually run.

In practice, though, every workflow past the roster board runs a real agent
turn, so a usable install needs:

- **A configured provider.** Genesis, casting, dispatch, coding, coordination,
  and governed decisions all run through a coding-agent provider. Keelson ships
  five built-ins, Copilot (the default), Claude, Codex, Pi, and a stub echo
  provider, and registers any OpenAI-compatible gateway you add; all but
  Copilot are opt-in. To try the wiring offline before you connect a real
  provider, run with `KEELSON_PROVIDERS=stub`, which lets the surface, tools,
  and workflows come up without billing a real turn.
- **The shared contract.** Squad depends on `@keelson/shared`, which the
  harness provides as a peer dependency. You do not install it separately.

Squad shells out to nothing on its own; the `code` tool works directly against
a project's checkout through the harness's file and process seams, not an
external CLI.

## Remove the rib

To uninstall Squad, remove it by its rib id and restart the server:

```bash
keelson rib remove squad
keelson stop && keelson start
```

`keelson rib remove` unwires the package. The data home (holding your authored
members, proposed casts, and coordinator run ledgers) is left on disk; delete it
by hand if you want to discard it.

## Related

- [Cast a team](../cast-a-team/): compose a roster for a project once the rib is
  active.
- [Surface](../../reference/surface/): the full layout of the Squad surface this
  guide confirms is wired.
- [Tools and commands](../../reference/tools-and-commands/): the tools Squad
  registers and what each one needs to run.
- [CONTRIBUTING.md](https://github.com/danielscholl/keelson-rib-squad/blob/main/CONTRIBUTING.md):
  set up a local checkout to work on the rib's source.
