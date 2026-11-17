# 25. The sweep interval is set from the page

Date: 2026-11-17

## Status

Accepted and built (#442). Decided by the owner on 2026-11-17. Both backends carry it, in lockstep
(ADR 0021).

**Amends the ratified invariant "behavior knobs live in `.env` … No DB config layer"** (CLAUDE.md,
Config), which ADR 0011 cited for the exit schedule's knobs and ADR 0018 for References — for ONE
knob, `MONITOR_INTERVAL_SECONDS`, and no other. Every other behaviour knob stays in `.env`.

## Context

The service sweeps the whole watchlist every `MONITOR_INTERVAL_SECONDS` (15s live): one batched
Provider call, the alarms evaluated, the samples written. The dashboard polls on a cadence of its
own, "refresh every", a viewer preference kept in a cookie. The owner had set the page to 5s and
wanted the service's sweep set from the same place, without editing `.env` and restarting.

A sweep interval is a knob, and knobs live in `.env`. The rule stands for a reason that still
holds: a knob in the database is a knob nobody can see from the repository, and a layer of them
becomes a second configuration system. So the exception is made for one knob, by name, and the
rule is otherwise unchanged.

## Decision

1. **Stored in the database, set from the page.** Settings offers "service sweeps every" with the
   presets **5, 10, 15, 30 and 60 seconds**, and "default (.env, Ns)". A choice is a row in
   `sweep_interval` (migration 0016), applied at the next sweep with no restart; "default" deletes
   the row, and `.env`'s `MONITOR_INTERVAL_SECONDS` is in force whenever there is none.
   `PATCH /settings` writes it (`{ sweep_seconds: preset | null }`, behind the token); `/health`'s
   `settings` serves the interval IN FORCE, where it came from (`sweep_source`: `settings` or
   `env`), the default and the presets.
2. **Nothing below 5s.** Each sweep is one moomoo snapshot call, limited to 60 per 30 seconds and
   shared with every open page's polls.
3. **A threshold counted in sweeps keeps its TIME, not its count.** `DEGRADED_AFTER_FAILURES` (5)
   and `QUARANTINE_AFTER_SILENT_SWEEPS` (10) were sized at the `.env` interval — 75s and 150s at
   15s. At another interval each becomes `ceil(count × env interval / interval in force)` sweeps
   (`domain/cadence.ts`'s `sweepsFor`, cased and ported): at 5s, 15 and 30. A faster sweep checks
   more often; it never gets trigger-happier. Rounded UP, so a knob is never judged in less time
   than it was sized for (at 60s, two failures, 120s, never one); 0, which turns a knob off, stays
   0. The same treatment for everything else counted in sweeps:
   - `FLAPPING_AFTER_FAILURES`, failures inside a window of TIME: a faster sweep fails more often in
     the same outage, so five failures in 15 minutes at 5s are 25s of failure where at 15s they
     were 75s. Scaled the same way.
   - `STALE_AFTER_SWEEPS` (4), how long a sweep may go unstarted before `/health` calls it stalled
     and the watchdog abandons it: scaled the same way, with a FLOOR of four intervals. At 5s it is
     still a minute (a sweep that logs in to OpenD, 8s, and then asks, 10s, must not be called
     stalled at 20s); at 60s it stays four intervals, because a minute's tolerance there would call
     every ordinary tick late.
4. **The header says both:** `refreshes every 5s · service sweeps every 15s`.

## How it is built

- **Read, never remembered.** The engine asks for the interval at every tick (the scheduler is a
  chain of timeouts that arms each tick at the interval in force), the health account at every
  reading, and `/health` at every request. There is no copy in memory for a route to update — and a
  route may not reach the engine anyway (`check-seams`).
- **A hand-edited row is refused, never fatal.** The route writes only a preset, so a stored value
  that is not one got in by hand: it is refused when READ, the service says so in its log at boot,
  and sweeps at `.env`'s interval. A database that cannot be read at all also falls back, because
  the read happens at every tick and a throw there would stop the alarms.
- **A table of its own, one row at most** (`CHECK (id = 1)`), rather than a key/value table of
  settings: a second knob here is a migration and an ADR, never a row someone adds.

## Consequences

- The interval in force can differ from `.env`, and `.env` no longer tells the whole story. The
  page, `/health` and the boot line ("sweeping every 30s (set from the page)") say which.
- The counted knobs are still read from `.env` and still mean what they meant at its interval, so
  `.env.example`'s explanations of them stay true; only their counts move.
- The migration is reversible: dropping `sweep_interval` loses only the choice, and code before it
  ignores the table.
