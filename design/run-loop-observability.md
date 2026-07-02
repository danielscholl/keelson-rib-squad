# Run-loop observability

Plan of record for #113 (capture) and #114 (board), with the host dependency
tracked as keelson#384. The companion mockup is
[`run-loop-observability.html`](./run-loop-observability.html) — the proposed
board rendered on the real r11 run, reconstructed at round 9.

## Problem

The operator cannot see what a squad mind is doing. The gap is two-layered,
and the first layer is not UI:

**Capture.** `turn-runner.ts` drains the turn stream into an empty loop —
every `tool_use`, `tool_result`, and `thinking` chunk dies there. The settled
result's `usage` is never read. What survives into the ledger is ~1,500 chars
of the member's inter-tool narration jammed into one string, with no
timestamps and no tool names.

**Presentation.** The board then shows the last 12 entries at 200 chars,
flat. Measured on the real r11 run (29 entries, 11 rounds): rounds 0–7 are
not on the board at all, nothing expands, gate events render at the same
weight as findings, and `identityTone()` hashes members into a pool that
includes `caution` and `ok` — identity masquerading as status.

## Tier A — capture (#113)

Additive optional fields on `CoordinatorEntry`; old ledgers keep rendering.

```ts
tools?: { name: string; target?: string; ok?: boolean }[]  // capped, last N
usage?: { input: number; output: number }
at?: string          // ISO, entry creation
durationMs?: number  // turn wall-clock
```

Mechanics:

- The turn-runner's drain loop becomes a fold: `tool_use` chunks append
  `{name, target}` (target = a short arg digest: file path, command head);
  the paired `tool_result` stamps `ok`. Thinking chunks are counted, not
  stored.
- `usage` copies from `RibAgentTurnResult.usage` when present.
- While a turn is in flight, the in-flight record carries the growing trace
  and the coordinator snapshot recomposes on a ~2s throttle, so the board's
  Now card streams. The `live` region pulse (keelson#353) then reflects real
  frames.

What it unblocks: the heart of #72 (live run-state), #50 (per-member tokens
derivable from the ledger), #111 (an empty reply with `tools > 0` is a lost
synthesis, not a benign no-op).

## Tier B — board (#114)

Region spec, all within existing canvas primitives except the ledger
expansion (keelson#384):

| Region | Primitive | Content |
| --- | --- | --- |
| Cost strip | `bars` (inline) + `stats` | Round as a meter (`value=round, total=budget`, caution ≥ 80%); stalls / re-plans / gate count; tokens + elapsed once Tier A lands |
| Round rail | `grid` | One cell per round, badge toned by who acted; gate-red reserved for red rounds. The run's shape at a glance |
| Now card | `cards` | Speaker, action, plan step, elapsed, last-3 tool trace, token tally |
| Ledger | `rows` + `detail` | Entries grouped under round heads (newest first), each expanding to the full stored text, markdown stripped at compose; gate events at error weight; rounds older than the last ~3 collapse to a one-line stub |
| Minds | `cards` | One lane per member: role, provider · model, turns, tokens, footprint, last/current action. Generalizes "Worked by" |
| Gate history | `rows` | Verification / change-quality verdicts per round |
| Verification | `rows` (boxed) | As today, single icon per row |

Also in scope:

- Identity pool restricted to non-status tones (`brand`, `accent`, `info`,
  `neutral`) so no member ever hashes to a warning color.
- Roster: drop the stat-tile row (counts already live in the head chip);
  strip markdown from charter previews.
- Runs board → `cards` with a per-run View action returning an `open-canvas`
  run-detail board composed from the archived ledger — the drill-down half of
  #70's View verb, no host change needed.

## Tier C — host (keelson#384)

One additive field on `rows` items: `detail?: string` (capped). The SPA
renders a disclosure that expands an inset pre-wrapped text block. Same
evolution pattern as `boxed` / `inline` / `reason`.

## Sequencing

1. keelson#384 merges to keelson main first (rib CI symlinks shared from
   keelson main; the strict canvas schema on an older server rejects unknown
   fields, so the rib must not emit `detail` before the host understands it).
2. Tier A (#113) is independent of the host change — ships any time.
3. Tier B (#114) lands last; it degrades gracefully wherever Tier A data or
   the `detail` field is absent (rows render exactly as today).

## Non-goals

Streaming raw thinking token-by-token to the board (the snapshot substrate is
frames, not a chat stream; the throttled trace carries the value). A
chat-style transcript surface per member (`Enter <member>` seeded chat already
exists for interrogation). Any new top-level view — this is a recomposition of
one board plus one host primitive.
