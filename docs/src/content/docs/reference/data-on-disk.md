---
title: Data on disk
description: The exact directory and file layout Squad writes under its data home, per-scope member directories, the pending cast proposal, and archived coordinator run ledgers.
sidebar:
  order: 6
---

Squad is a Keelson rib, so it persists everything under its own per-rib data
home. The path is `{keelson-home}/rib-squad/`, the value the harness hands the
rib at boot from the `getDataDir` seam (an out-of-process reader that predates
the seam, or one running standalone, falls back to the same path derived
directly from the keelson home). Everything below is relative to that home.

| Path | What |
|---|---|
| `members/{slug}/` | The default scope's member directories. |
| `cast-proposal.json` | The default scope's pending cast proposal, if any. |
| `casting-registry.json` | The default scope's theatrical-casting record. |
| `coordinator-ledger.json` | The default scope's live coordinator run, if one is in progress. |
| `pending-genesis.json` | The default scope's in-flight genesis or cast scan, if any: the marker that seats a boot card until the member lands. |
| `runs/{id}.json` | The default scope's archived coordinator runs. |
| `rollbacks/{runId}.jsonl` | The default scope's rollback events, appended one JSON line per event. |
| `workspace.json` | The default scope's leased worktree record (`projectId`, `leaseId`, `worktreePath`), when the harness provides workspace isolation. |
| `projects/{segment}/members/{slug}/` | A project scope's member directories. |
| `projects/{segment}/cast-proposal.json` | That project scope's pending cast proposal, if any. |
| `projects/{segment}/casting-registry.json` | That project scope's theatrical-casting record. |
| `projects/{segment}/coordinator-ledger.json` | That project scope's live coordinator run, if one is in progress. |
| `projects/{segment}/pending-genesis.json` | That project scope's in-flight genesis or cast scan, if any. |
| `projects/{segment}/runs/{id}.json` | That project scope's archived coordinator runs. |
| `projects/{segment}/rollbacks/{runId}.jsonl` | That project scope's rollback events. |
| `projects/{segment}/workspace.json` | That project scope's leased worktree record (`projectId`, `leaseId`, `worktreePath`), when the harness provides workspace isolation. |
| `selected-project.json` | The operator's current project selection, at the home root regardless of scope. |
| `projects.json` | A snapshot of the known project catalog, at the home root regardless of scope. |

Every path above is relative to `{keelson-home}/rib-squad/`.

## Scopes: which directory a squad's files actually live in

A **scope** is a data-isolation boundary, one per project. There is no
separate "squad" object on disk; a squad *is* whatever `members/`,
`cast-proposal.json`, `casting-registry.json`, `coordinator-ledger.json`, and
`runs/` live under one scope's directory.

The **default scope** is a sentinel, not a real project id: it maps straight
onto the data home root shown above, so a harness that predates project
scoping keeps reading and writing the same flat paths it always did. Every
other scope maps onto `projects/{segment}/`, where `{segment}` is the scope id
sanitized to a bare token of letters, digits, `_`, and `-`. If sanitizing an id
would make it collide with a different id's sanitized form, the segment
instead becomes a stable hash of the *original* id, so two distinct scopes can
never land on the same directory.

One rule folds into this: selecting the workspace's own default project (as
opposed to some other added project) resolves to the default scope, not a new
`projects/{segment}/` tree, so a roster cast before project scoping existed is
never orphaned into a subtree of its own. Every other project scopes by its
own project id.

`selected-project.json` and `projects.json` are the two exceptions to the
per-scope rule: they live at the true home root regardless of which scope is
active, because the out-of-process collectors read them via argv before they
can resolve a scope at all. `selected-project.json` holds the operator's
current selection (`scopeId`, and, unless the default scope is selected,
`projectId`/`name`/`rootPath`); a missing or unreadable file reads as no
selection, which resolves to the default scope. `projects.json` is a snapshot
of the known project catalog, refreshed independently of the selection.

## A member's directory

Each member is one directory, `members/{slug}/`, under its scope. The
directory name is the authoritative slug: a slug is lowercase, ASCII
alphanumerics and hyphens only, starting with an alphanumeric, capped at 48
characters, and every read or write keyed by slug is checked against that
shape before it touches disk.

| File | Contents |
|---|---|
| `member.json` | The structured record: name, role, charter, status, pinned model/provider, capability tags, casting fields, `createdAt`. |
| `charter.md` | The authored founding identity document: `# <name>`, `## Role`, `## Mission`, `## Voice`. |
| `memory.md` | The durable working-memory document. Seeded as `# Working memory\n\n_(empty)_\n`, then overwritten wholesale (never appended) as the member's memory changes, capped at 4000 characters; an over-cap write is rejected, not truncated, leaving the prior memory in place. |
| `rules.md` | The operating-rules document. Seeded as `# Rules\n\n_(none yet)_\n`. Squad writes no other content to this file; it stands as an operator-editable document. |
| `log.md` | The running journal. Seeded with one genesis entry, then appended to one bulleted line at a time, keeping the most recent 50 entries at up to 280 characters each. |

`member.json` is written whole each time (temp file plus rename, never a
partial write in place):

```json
{
  "slug": "mcmanus",
  "name": "McManus",
  "role": "Tech Lead",
  "charter": "# McManus\n\n## Role\nTech Lead\n\n## Mission\n...\n\n## Voice\n...\n",
  "status": "active",
  "provider": "claude",
  "model": "claude-opus-4-8",
  "tools": ["code"],
  "themeId": "usual-suspects",
  "personality": "Sharp, controlled, always three steps ahead.",
  "backstory": "A fixer who plans everything and says almost nothing.",
  "originalName": "Backend Lead",
  "createdAt": "2026-06-23T12:00:00.000Z"
}
```

`model` is present only alongside `provider`; Squad never persists a model
with no provider behind it. `tools`, `themeId`, `personality`, `backstory`,
and `originalName` are all optional and are written only when they have a
value, so a member built with theming off, or with no capability tags, simply
omits them. Creating a member fails closed on a slug collision: an existing
directory is never overwritten, so a re-run of genesis or a re-approved cast
proposal can never clobber an existing member's charter, memory, or log.
Retiring a member deletes its whole directory, recursively and permanently;
Squad's member record does define an inactive status alongside active, but
retiring does not use it as a soft pause.

## The cast proposal

`cast-proposal.json` holds at most one pending proposal per scope, written by
an auto-cast repository scan and read by both the Proposed squad panel and the
approve/discard actions:

```json
{
  "projectId": "proj_8f2a",
  "projectName": "keelson-rib-squad",
  "rootPath": "/Users/operator/code/keelson-rib-squad",
  "mission": "Get this repo reviewed and tested before the next release.",
  "members": [
    {
      "name": "Vera",
      "role": "Reviewer",
      "charter": "# Vera\n\n## Role\nReviewer\n\n## Mission\n...\n\n## Voice\n...\n",
      "tools": ["read"],
      "provider": "copilot",
      "model": "gpt-5.5"
    }
  ],
  "summary": "A three-person team covering implementation, review, and test coverage.",
  "notes": [],
  "createdAt": "2026-06-25T09:30:00.000Z"
}
```

`mission` and `summary` are present only when supplied. `notes` is always an
array, populated with a truncation message when the scan proposed more
members than the cap allows, so an operator-visible cap is never silent.
Approving the proposal scaffolds every proposed member into `members/` (an
existing slug is skipped, never overwritten) and then deletes this file;
discarding just deletes it. Either way, nothing about the proposal survives
past the decision.

## The casting registry

`casting-registry.json` is the per-scope record of which theatrical character
each member has been cast as, the state that keeps a roster collision-free and
gives a retired name a traceable lineage when it is reused:

```json
{
  "version": 1,
  "activeThemeId": "usual-suspects",
  "themeHistory": ["usual-suspects"],
  "members": {
    "mcmanus": {
      "themedName": "McManus",
      "themeId": "usual-suspects",
      "status": "active",
      "originalName": "Backend Lead"
    }
  }
}
```

`members` is keyed by slug for active entries; a retired entry that has since
been reused is archived under a bookkeeping key (for example
`mcmanus#retired-1`) and cross-linked to its successor so both ends of the
hand-off stay traceable. A missing or corrupt registry reads as empty, so
casting degrades to a fresh, uncasted squad rather than failing outright. See
[Cast and roster](../../concepts/cast-and-roster/) for how casting itself
decides which character a proposal gets.

## Archived coordinator runs

While the standing coordinator loop runs, its full state lives in
`coordinator-ledger.json`: the goal, the plan, accumulated facts, the
round-by-round transcript, stall and reset counters, verification results, and
more. The moment a run reaches a terminal status, that same ledger is copied
whole into `runs/{id}.json`, where `{id}` is derived from the ledger's
`createdAt` timestamp (colons and dots replaced with hyphens). A run that
resumes and later re-terminates overwrites its own archive file rather than
creating a duplicate, because the filename is keyed on `createdAt`, not a
fresh id each time.

Every terminal status archives — `done`, `gave-up`, `max-rounds`,
`max-tokens`, `verification-failed`, `change-quality-failed`, and `aborted`.
An operator who stops a run still gets its ledger in the history, and so does a
run reconciled as aborted after its driver died without writing a terminal
status. The one status that never writes a file is `error`, which is precisely
the status that is *not* a terminal status: it means the loop threw rather than
reaching a verdict, so there is no settled ledger worth keeping. Archival is
fail-soft at every call site — persistence of run history is never allowed to
fail the live run's result.

An archived run file is the entire ledger, unabridged:

```json
{
  "task": "Add coverage for the retry path and open a draft PR.",
  "projectId": "proj_8f2a",
  "facts": ["...", "..."],
  "plan": ["...", "..."],
  "round": 9,
  "stallCount": 0,
  "resetCount": 1,
  "status": "done",
  "transcript": [{ "round": 9, "kind": "code", "speaker": "mcmanus", "text": "...", "provider": "claude" }],
  "verification": { "command": "bun run check", "exitCode": 0, "passed": true, "summary": "3 checks passed", "atRound": 9 },
  "lastCodeRound": 8,
  "lastCleanReviewRound": 9,
  "summary": "Added retry-path tests and opened a draft PR.",
  "createdAt": "2026-06-25T10:00:00.000Z",
  "updatedAt": "2026-06-25T10:14:00.000Z"
}
```

Reading run history back does not re-parse all of that. `runs/` is listed and
each file is reduced to a coarse `RunSummary` — `id`, `task`, `status`,
`round`, `createdAt`, `updatedAt`, plus `scopeId` when the ledger carries one —
sorted newest-updated first. `id` is derived, not stored: it is the ledger's
`createdAt` with colons and dots hyphenated, which is the same rule that names
the file. A file that fails to parse, or is missing any of the required fields,
is skipped rather than breaking the listing. The Runs panel and the `squad_runs` tool both read only
this coarse index; the full facts, transcript, and verification detail sit in
the file on disk but are not surfaced through either of those paths.

## Related

- [Cast and roster](../../concepts/cast-and-roster/): how a member's directory comes to exist, and what casting actually assigns.
- [The coordinator loop](../../design/the-coordinator-loop/): why a round is shaped the way it is, the source of everything the ledger records.
- [Surface](../surface/): the panels that render these files as live boards, and their refresh cadence.
- [Tools and commands](../tools-and-commands/): the `squad_coordinate` and `squad_runs` tools that write and read this data.
