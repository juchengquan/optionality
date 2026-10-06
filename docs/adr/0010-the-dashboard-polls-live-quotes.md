# 10. The dashboard polls live quotes

Date: 2026-10-06

## Status

Accepted. Ratified by the owner on 2026-10-06 ("fix the /quotes invariant, keep it live").

## Context

CLAUDE.md carried this invariant, marked user-ratified:

> The dashboard makes NO call of its own: it renders the sweep's cached records, so a row's value
> and its 🔔 always come from the same instant.

The dashboard did not do that. `/quotes` calls `watchlistQuotes`, which fetches from OpenD on every
request, and the dashboard polls it every 5–15 seconds per open tab. Measured, three calls four
seconds apart:

```
cost_to_close=7.4999999999999964
cost_to_close=7.4999999999999964
cost_to_close=7.549999999999997
```

while the sweeper's stored value sat at `-7.5`.

The cached path exists. `MonitorSweeper.cachedQuotes` was written for exactly this, its comment
explains the reasoning, and **no route calls it** — six tests exercise it under a `describe` named
"what the dashboard renders", asserting the invariant that the shipped dashboard was breaking. The
invariant had tests, they passed, and they covered code nothing used.

The consequence that mattered was not the OpenD load. It was that `triggered` came from the
sweeper's stored column while every figure beside it came from the live fetch, so a row could show
a value past its threshold with no bell, or a bell beside a value well inside it. `last_value` was
in the payload too, the sweep's figure next to this fetch's, read by no client.

## Decision

The dashboard keeps the live call. The invariant's *promise* is kept and its *mechanism* changes:

- `buildEntries` reads the watched figure **once** and derives both the fill bar and the bell from
  it, using `isBreached` — the alarm engine's own predicate, so the bell flips at the exact
  threshold and cannot drift from how an alarm is decided.
- The engine's stored `triggered` and `last_value` were removed from `MonitorForEntry`, the input
  type. The entry now *cannot* be built from stale state. This was a comment before; the comment was
  accurate while the code beside it was not.
- An unreadable figure is neither calm nor breaching: no bell beside a dash.
- `last_value` is gone from the `/quotes` payload. `/monitors` is where the engine's record belongs.

## Consequences

The dashboard's figures are current, not up to one sweep old, and the manual refresh button is a
real fetch rather than a repaint.

**Polling faster is no longer free.** Each open tab costs one full-watchlist snapshot per poll, on
top of the sweep's own. The refresh selector offers 5s; two tabs there is 24 extra snapshots a
minute. If OpenD ever complains, this is the first thing to look at.

**The dashboard's bell can lead or lag Telegram.** It shows what is true of the figures on screen;
the engine decides what to send, with cooldowns. A bell with no message means the move happened
since the last sweep — at most 15 seconds.

`cachedQuotes` is kept, unused, as the alternative if this is revisited, and its comment now says
so plainly rather than claiming the dashboard renders it.

## Alternatives

**Point the dashboard at `cachedQuotes`.** Restores the original invariant exactly, costs no OpenD
calls, and makes every figure up to one sweep old. Rejected: the owner wants the screen current.

**Keep the live call and leave the bell stored.** This was the state of things. Rejected: a row that
disagrees with itself is worse than either consistent choice, and the 🔔 is the one thing on the
page that must not lie.
