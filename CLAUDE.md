# CLAUDE.md

SPX options monitoring service: a JSON API, an alarm engine, a Telegram bot and a React dashboard.
**Two launchd agents** on the owner's always-on machine, behind one tailnet hostname (ADR 0006):
the API on 127.0.0.1:31415 (`/opt/api`) and `com.optionality.ui` (Caddy serving `frontend/dist`, `/opt`).
Same origin, so no CORS. `~/recovery.sh` rebuilds the whole tailscale serve table and both agents.

**The service is TypeScript (ADR 0009):** `com.optionality.api` runs `backend/src/main.ts` under node,
on `data/optionality-ts.db`. Node runs the TypeScript directly, so what is in the working tree is what
runs. The Python service it replaced, and the run pipeline (strategy and holdings scans), were deleted in
phase 10 (ADR 0014); the `python-before-phase-10` tag keeps them, and `data/optionality.db` is the
Python's database, frozen at the 2026-10-02 cutover and never opened. There is no rollback.

**The TypeScript domain is canonical** (`backend/src/domain/`). A Python package, `optionality` in
`python/`, is ported FROM it for notebook use (ADR 0014) and held to it by the golden cases in `cases/`,
compared exactly. A TypeScript domain fix therefore makes `make test` red until the Python is ported.

## Commands

- `make test` / `make lint` / `make format` — run all three before every commit. `make test` is the Python
  package's suite: every golden case, reproduced exactly. `make lint` is ruff plus `check-boundaries`: no package
  imports another's source tree, only its package.json `exports` (`backend` for `AppType`,
  `backend/schemas` for the input schemas; ADR 0014).
- `make deploy` — **the only correct way to land a merge**: pull, install, back up the DB, restart BOTH
  agents (the API applies pending migrations at boot). launchd does not watch the repo and the agents
  run this working tree, so a merge that skips this leaves stale code running. Doing the steps by hand
  is how the dashboard and the API drift apart.
- TypeScript: `make test-api` (the suite), `make typecheck`, **`make check-api`** (every module loads
  under Node — `tsc` and vitest both accept syntax Node refuses to run, and two classes reached main
  unable to load at all).
- **Golden cases:** a change to anything `backend/src/domain/` (or `timefmt.ts`) exports changes what
  `cases/*.json` should say. `make cases` regenerates them and `make check-cases` — and `make test-api`
  — fail until you do. Never edit them by hand; add inputs to `backend/src/cases/inputs.ts`. Every
  exported domain function must have a case (ADR 0014).
- `make serve` — run the TypeScript API locally (loads `.env`): on a SNAPSHOT of the live database,
  with the sweep at an hour and the Telegram variables blanked, because the live service is always up
  here and the alarm rows tolerate no second writer. The bot stays off by `OPTIONALITY_BOT` being
  unset (only the plist sets it); blanking the token additionally stops a local sweep from messaging
  you. Port 31417, not 31415.
- `make build-ui` / `check-ui` / `test-ui` for the frontend;
  the bundle in `frontend/dist` is COMMITTED so node never sits on the deploy path. Two frontend branches
  therefore collide in `dist` every time: **`make resolve-ui`** settles it by rebuilding from the merged
  source — never hand-merge a bundle, and never configure a merge driver for it (`.gitattributes` says why).
- **Schema change:** add a `.sql` file to
  `backend/src/db/migrations/` AND put the same shape in `backend/src/db/schema.sql`, then update
  `COLUMNS`, `NULLABLE`, the row interface and `SchemaChecks` in `db/rows.ts` — the compiler and
  `rows.test.ts` tie those three together, so a half-done change fails rather than drifts.
  `main.ts` applies what is pending at boot and a failure there is fatal on purpose. A database
  built from `schema.sql` is STAMPED, not migrated (ADR 0011). `make deploy` backs the file up
  before it restarts, so the backup predates the migration. **Never edit a migration that has
  run.**
- uv only, never pip. Python ≥ 3.12. TDD: write the failing test first; the whole codebase was built that way.

## Layout

- `backend/src/`: `main.ts` (the process), `app.ts` (routes, auth, `/docs`), `routes/`, `domain/` (pure
  maths — canonical, see golden cases), `sweeper.ts` (the alarm engine), `scheduler.ts` (the sweep loop
  and its watchdog — NOT dead code: it is what drives the alarms), `watchlist.ts`, `bot/` (long-poll
  Telegram bot), `opend/` (the moomoo websocket client), `db/` (schema, migrations, queries),
  `cases/` (the golden cases' inputs and builder).
- `frontend/` — Vite + React + TS, the dashboard at `/opt`. `frontend/dist` is committed.
- `cases/` — the golden cases (generated). `tools/check-boundaries.mjs` — the package-boundary lint.
- `python/` — the `optionality` package (ADR 0014): `src/optionality/` mirrors `backend/src/domain/` module
  for module (snake_case the only translation), `_js.py` holds the JavaScript rounding the port must
  reproduce, `opend.py` needs the `opend` extra. `tests/test_cases.py` runs every golden case.

## Invariants — user-ratified in design sessions; do not "fix" without asking

- Every OpenD call is a single bounded one: the sweep, `/spx/quote`, `/quotes`, `/positions/values`
  and the creation probes. (`/positions/values` is polled by the dashboard's Holdings panel while it is
  open.) This read "one worker thread owns run execution, and these are the exceptions" until phase 10
  retired the worker with the run pipeline it existed for (ADR 0014).
- The whole watchlist is ONE `get_market_snapshot` call per sweep (combo legs join the batch, deduped).
  **The dashboard's poll is a live call of its own** — `/quotes`, one batch per poll per open tab — so its
  figures are current rather than up to one sweep old, and polling faster is NOT free (ADR 0010). What the
  earlier wording promised still holds and is what matters: a row's value and its 🔔 come from the same
  instant. That is now true by construction — `buildEntries` reads the watched figure once and derives both
  the fill bar and the bell from it, with `isBreached`, the engine's own predicate. The engine is untouched:
  the stored `triggered`, the cooldowns and the Telegram messages remain the sweep's business, and the
  dashboard's bell may therefore lead or lag what has been sent. `MonitorSweeper.cachedQuotes` is the cached
  alternative and no route calls it.
- Vocabulary: "quote(s)" = live market data, everywhere. moomoo's "snapshot" jargon stays out of the API.
- Alarms: the 🔔 flips truthfully at the EXACT threshold — no value hysteresis. `ALARM_COOLDOWN_SECONDS`
  throttles state-change messages; `ALARM_REPEAT_SECONDS` re-reminds persisting breaches. `compare: abs|signed`
  (signed → negative thresholds legal, exactly 0 never).
- Retention: creation is gated by a live contract-existence probe (strict — rejects while OpenD is down).
  Runtime unknown contracts → quarantine (disable + Telegram notice, NEVER delete). Expired monitors: mute with
  notice, auto-delete after `EXPIRED_RETENTION_DAYS`. Nothing else is ever auto-deleted.
- Combos: values are signed sums under the user's chosen leg signs; NO partial sums (any missing leg skips the
  combo); greeks are signed sums of the value; IV is never summed.
- Telegram tables: ~40 monospace chars per row, four columns max — a new question gets a new command
  (`/quotes`, `/greeks`, `/vol`), never a fifth column. `<pre>` + `parse_mode: HTML` only for table replies.
- Timestamps: storage is UTC; display converts via `DISPLAY_TZ`. moomoo `update_time` arrives naive US-Eastern
  and means LAST TRADE, not freshness — `fetched_at` is freshness.
- Config: behavior knobs live in `.env` (which mirrors `.env.example`'s structure — active lines are overrides,
  commented lines show defaults); viewer preferences (dashboard refresh) live in browser cookies. No DB config
  layer.
- Behind the path-stripping proxy the browser sees `/opt/...` while the app sees `/...`. The bundle is built
  for its prefix (`UI_BASE`), and `ROOT_PATH` tells the API's `/docs` and `/openapi.json` theirs.

## Testing conventions

- `backend/src/testing.ts`'s `harness` injects an echo quote fetcher by default — tests must NEVER reach the
  real moomoo SDK (it blocks indefinitely on dead ports; a missing fake looks like a hung suite).
- Bot tests drive `TelegramBot.handleUpdate` directly with a fake API; sweep tests call
  `MonitorSweeper.sweep()` with fake fetchers and senders. Dates in tests are derived from the harness's
  fixed clock (`NOW`, `daysFromNow`), never the real one.

## Workflow & environment

- Branch → PR → the owner merges (never merge or push to main directly). Restart the agent after landing.
- `.env` is gitignored and holds live Telegram credentials — never commit it or echo its secrets into
  committed files. `data/optionality-ts.db` is live state (watchlist, holdings, their daily samples — the samples
  are the one thing that cannot be re-entered). Two sets of backups, both SQLite's online backup,
  NEVER `cp`: in WAL mode `cp` leaves the write-ahead log behind, so the copy is current only to the
  last checkpoint — 1 row of 500 when measured — and is still valid SQLite, which is what makes it
  dangerous.
  - `make deploy` takes one before every restart and migration, in `data/`, and keeps the last 3
    plus any renamed `optionality-ts.db.bak-pre-<what>-<stamp>` — rename one to keep it for good.
  - `com.optionality.backup` (`make launchd-backup-install`) takes a checked, gzipped one at 06:00
    into `BACKUP_DIR`, keeping 14 nights and the first of each of 12 months. `BACKUP_DIR` is a
    folder in iCloud Drive (`~/Library/Mobile Documents/com~apple~CloudDocs/optionality-backups`),
    which is what takes them off this machine; the Python-era archive is in its `archive/`.
  - Restore only with `make restore FROM=<file>`. Copying a backup over the live file leaves its
    `-wal` beside it, and SQLite replays that old log onto the restored data.
- The Telegram bot token allows ONE `getUpdates` consumer: never run two service instances against it, and
  avoid external `getUpdates` curls while the service runs.
