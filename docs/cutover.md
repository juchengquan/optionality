# The cutover

> **Historical.** The cutover happened on 2026-10-02 and phase 10 deleted the Python, `make cutover`,
> `make rollback` and every differential (see the end). Nothing below can be run any more; it is kept
> as the record of how the move was made.

Replacing the Python service with the TypeScript one (ADR 0009, phase 9). **Read this before running
anything.** One agent runs at a time; the Python keeps its own database and never opens the new one.

## What moves, and what does not

| | before | after |
|---|---|---|
| API | `com.optionality.service` (uvicorn, Python) | `com.optionality.api` (node, TypeScript) |
| port | 127.0.0.1:31415 | **the same** |
| tailscale | `/opt/api` → 31415 | **unchanged** |
| dashboard | `com.optionality.ui` (Caddy) | **unchanged** |
| database | `data/optionality.db` | `data/optionality-ts.db`, a verified copy |
| Telegram bot | the Python's thread | the Node agent, `OPTIONALITY_BOT=1` |

The tailscale serve table does not move, so nothing outside this machine notices. The dashboard is the
same bundle; it was already typed against this API (phase 8) and its shapes were compared against the
Python's, endpoint by endpoint, before that landed.

## Before you start

```sh
make cutover-preflight
```

It checks the things that make the cutover safe and refuses to pretend about any of them: node is
installed, `data/optionality-ts.db` does not already exist, OpenD is reachable on its websocket port,
every module loads under Node, the whole suite passes, and `~/recovery.sh` has been updated.

### `~/recovery.sh` has to change first

It lives outside the repo and it is the source of truth for the tailscale table and both agents. As
written it boots `com.optionality.service`, so running it after the cutover would start the Python on a
port Node already holds — a bind failure, respawned for ever by `KeepAlive` — or, if Node happened to be
down, quietly bring the Python back with a database that has stopped being current.

Make it boot whichever agent is installed, preferring the new one:

```sh
# --- optionality API (127.0.0.1:31415, exposed as /opt/api) -----------------
# Since ADR 0009 phase 9 this is the TypeScript service, com.optionality.api.
# com.optionality.service is the Python one, kept installed as the rollback.
# Exactly one is loaded; this boots whichever plist exists, preferring the new.
if [ -f "$HOME/Library/LaunchAgents/com.optionality.api.plist" ]; then
  OPTIONALITY_AGENT=com.optionality.api
else
  OPTIONALITY_AGENT=com.optionality.service
fi
OPTIONALITY_PLIST=$HOME/Library/LaunchAgents/$OPTIONALITY_AGENT.plist
```

The rest of the block — the `kickstart -k` / `bootstrap` choice, and the comment about `bootout` being
asynchronous — is unchanged and still right.

## The cutover

```sh
make cutover
```

In order: it runs the gates, stops the Python agent, copies the database and verifies it **field by
field** (211 values) and then again through SQLAlchemy (194 values, with their Python types, plus
`alembic current` at head), installs the Node agent on 31415, and reads `/health` back.

It refuses to overwrite an existing `data/optionality-ts.db`, so a second run after a rollback needs
that file moved aside deliberately.

## Then the one test that cannot be automated

Everything else in this rewrite is provable from tests. This is not: it crosses into a phone, through a
token the agent should not be exercising on the owner's behalf.

1. Pick a monitor whose current value is close to its threshold — `/monitors` in the bot, or the
   dashboard's fill bar, shows which.
2. Move the threshold so it will fire on the next sweep. From the phone:
   `/threshold 261030 C8100 <a value just inside the current one>`
3. Wait one sweep interval (`MONITOR_INTERVAL_SECONDS`, 60 by default).
4. **Confirm the Telegram message arrives**, and that it reads the way it always did:
   `⚠️ <name>: option_delta 0.058 crossed ≥ 0.05`
5. Put the threshold back. Confirm the recovery message arrives: `✅ … back below …`

While you are there, the bot is the other thing only a person can check: `/monitors`, `/quotes`,
`/greeks`, `/vol`, `/health` should all come back as tables that fit the screen.

## If anything is wrong

```sh
make rollback
```

Stops Node, removes its plist, and boots the Python agent again. Its database was never opened by the
new service, so everything that existed before the window is intact. Anything entered **during** the
window lives only in `data/optionality-ts.db` and has to be retyped — which is why the window should be
short, and why the first thing to do after a successful cutover is to use it for a day before deleting
anything.

`data/optionality-ts.db` is left in place by the rollback, so nothing is lost by rolling back and
trying again.

## A WAL sits beside the frozen database

`data/optionality.db` has `-wal` and `-shm` files beside it, ~20 KB, left by the Python's last
session and touched again on 2026-10-17 when the schema was read to confirm the TypeScript side had
never migrated it. The schema and the data are unchanged — no `position_samples`, no
`schema_migrations`, neither new `positions` column — but the file's mtime is no longer the cutover
minute, so do not use that as evidence of anything.

Nothing needs doing. SQLite recovers a WAL automatically when the database is next opened, which is
what a rollback would do. It matters only for the rule CLAUDE.md already states: these files are
copied with the online backup and NEVER with `cp`, because `cp` leaves the write-ahead log behind
and the copy is current only to the last checkpoint.

**It will refuse once the two databases have diverged, which does not take long.** The sentence above
is true of the first hours and stops being true after that: what has to be "retyped" grows into
everything, and worse, the Python's frozen rows come BACK — holdings you have since closed reappear as
open. Measured on 2026-10-15, thirteen days in: one holding lost, four closed ones restored, all seven
alarm rules lost, every exit schedule and the whole vol history gone, the last of those unrebuildable
because a leg's IV and vega are only knowable on the day they were observed. ADR 0011 put
`positions.opened_at` and `position_samples` on the TypeScript side alone, so the Python has nowhere
to keep them.

`make rollback` therefore runs `backend/tools/rollback/guard.mjs` first and stops, printing exactly
what would go. If you mean it anyway:

```sh
make rollback ROLLBACK_FORCE=--i-accept-the-loss
```

`cutover` passes that itself on its own failure path, and is the only thing that should: there the
copy is seconds old, so the two agree and nothing is lost — and the alternative is a half-finished
cutover with no way back.

## The window

The Python stays installed, and its database stays current as of the cutover minute. Phase 10 — a month
later — deletes the ported Python and the rollback with it. A month is about how long it takes to meet a
weekly edge case: a Friday expiry, a quarantined contract, a gap open.

Two things to watch during it:

- **`/health`** should show `db: true`, `opend: true`, and a `last_sweep_at` that keeps moving.
- **the sweep's own account of itself**: `alarms: active`. `STALLED (n failed sweeps)` means the
  OpenD websocket is not answering, and the Python used the TCP port — so this is the one failure mode
  the cutover newly exposes.

## Phase 10's scope grew, because its premise changed

ADR 0009 narrowed phase 10 from "delete `src/optionality/`" to "delete the Python that was ported",
keeping `core.py`, `apis/`, `notification/` and `datatype/` **on the grounds that the run pipeline
needs them**. On 2026-10-15 the owner said he had stopped using the run pipeline, and #118 removed
its fifteen HTTP endpoints, so that premise no longer holds: a run can now be created only by the
scheduler, from a schedule that can only be inserted with SQL. The pipeline is unreachable, and the
Python it would have called is unreachable with it.

So phase 10 also retires, deliberately rather than as a side effect:

- `worker.ts` — it can never be given work again. Its `queueDepth()` reaches four readers that
  will all report a constant zero: `/health`, the Telegram bot's status line
  (`bot.ts:460`), and the dashboard twice — the `degraded` gate at `App.tsx:182`
  (`health.queue_depth > 0`) and the visible `· queue: 0` beside it at line 228. **This retires a
  ratified invariant** — "one worker thread owns run execution" — so it wants a line in the ADR,
  not a quiet deletion.
- the scheduler's CRON half: `fireSchedule`, `refreshJobs`, and `config-body.ts`'s `TaskType`.
- `/health`'s `last_run` and `queue_depth`, and both dashboard readers of the latter. A frontend
  change as well as a backend one, which is why it belongs with the deletion rather than ahead of
  it.
- the `configs`, `schedules`, `runs` and `reports` tables.
- `core.py`, `apis/`, `notification/` and `datatype/` — the Python ADR 0009 had kept.

**What must NOT go with it:** the scheduler itself. `main.ts` calls
`scheduler.startSweep(settings.monitorIntervalSeconds, () => sweeper.sweep())`, so the scheduler is
what drives the alarm sweep. Only its cron half is dead. Deleting the scheduler stops the alarms.

Two things were done early, on 2026-10-15, so phase 10 does not have to:

- **the differentials were cashed in.** ADR 0009 requires anything they find to be committed as a
  TypeScript test before the Python goes. `make diff-api` reported 0 divergences over 19,265
  compared values across 400 cases, and `make diff-opend` 0 over 288 across 8 live contracts, so
  nothing is owed. `make diff-services` was deliberately not run: it starts the Python service, and
  the bot token allows exactly one `getUpdates` consumer.
- **a tag**, `python-before-phase-10`, because the repo had none and "git preserves it" was
  otherwise unlabelled. 73 files come back from
  `git show python-before-phase-10:src/optionality/service/monitor.py`.

## Phase 10 happened, earlier than planned

On 2026-10-17, ahead of the 2026-11-02 date, because ADR 0014 brings a NEW Python package into the
repo under the same `optionality` import name and one environment cannot hold both. Everything the
list above names went: the Python service, `tests/`, `alembic/`, the run pipeline in both languages
(the TypeScript worker and runner, the scheduler's cron half, `/health`'s `queue_depth` and
`last_run`, and the four tables, dropped by migration 0005), the Python launchd plist, Docker, and the
cutover, rollback and differential tooling. The scheduler's sweep loop stayed, as warned above.

The rollback was not lost by this: it had been measured on 2026-10-15 as restoring four closed
positions and dropping every monitor, so it was already a trap rather than a net. What remains is
the tag `python-before-phase-10` for the code, `make deploy`'s online backups for the data, and
`data/optionality.db`, the Python's database as it stood at the cutover minute.
