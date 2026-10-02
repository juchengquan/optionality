# CLAUDE.md

SPX options monitoring service: a JSON API, an alarm engine, a Telegram bot and a React dashboard.
**Two launchd agents** on the owner's always-on machine, behind one tailnet hostname (ADR 0006):
the API on 127.0.0.1:31415 (`/opt/api`) and `com.optionality.ui` (Caddy serving `frontend/dist`, `/opt`).
Same origin, so no CORS. `~/recovery.sh` rebuilds the whole tailscale serve table and both agents.

**The API is being rewritten in TypeScript (ADR 0009), and the cutover is a single command.**
Two implementations exist, and exactly ONE launchd agent is loaded:

- `com.optionality.api` — node, `backend/src/main.ts`, database `data/optionality-ts.db`. The one to
  work on. Node runs the TypeScript directly, so what is in the working tree is what runs.
- `com.optionality.service` — uvicorn, `src/optionality/`, database `data/optionality.db`. The rollback
  until phase 10 deletes it. Its database is never opened by the new service.

`launchctl print gui/$(id -u)/com.optionality.api` says which is live. `make deploy` restarts whichever
it is. `make cutover` / `make rollback` switch; see **docs/cutover.md** first. The run pipeline
(`core.py`, `apis/`, `notification/`) stays in Python either way, called as a subprocess.

## Commands

- `make test` / `make lint` / `make format` — run all three before every commit. Lint is ruff with a broad
  external ruleset (expect rules far beyond the defaults; per-file `BLE001` ignores exist for the
  worker/sweeper/bot, whose job is to survive any failure).
- `make deploy` — **the only correct way to land a merge**: pull, install, back up the DB, migrate if the
  Python is live, restart BOTH agents. launchd does not watch the repo and the agents run this working
  tree, so a merge that skips this leaves stale code running. Doing the steps by hand is how the
  dashboard and the API drift apart.
- TypeScript side: `make test-api` (the suite), `make typecheck`, **`make check-api`** (every module
  loads under Node — `tsc` and vitest both accept syntax Node refuses to run, and two classes reached
  main unable to load at all), `make diff-api` / `make diff-opend` / `make diff-services` (the three
  differentials against the Python; see `backend/tools/*/README.md`).
- `make serve` — run the API locally (loads `.env`). `make build-ui` / `check-ui` / `test-ui` for the frontend;
  the bundle in `frontend/dist` is COMMITTED so node never sits on the deploy path.
- Schema change: edit `service/models.py`, then
  `OPTIONALITY_DB_PATH=data/optionality.db uv run alembic revision --autogenerate -m "..."` and
  `... alembic upgrade head`. Alembic runs in batch mode (SQLite table rebuilds). **Squash a branch's
  migrations before it merges; never touch shipped migrations.** Startup `create_all` covers fresh DBs.
- uv only, never pip. Python ≥ 3.12. TDD: write the failing test first; the whole codebase was built that way.

## Layout (`src/optionality/`)

- `core.py` — run pipeline + `fetch_snapshot` (the worker and routes share it)
- `apis/` moomoo + yfinance + `build_spx_code`/`normalize_strike_date`; `notification/` gmail, file, telegram
- `service/`: `app.py` (factory, auth middleware, lifespan), `worker.py` (THE single job thread),
  `scheduler.py` (APScheduler; `refresh_jobs` must only touch `schedule-*` job ids),
  `monitor.py` (sweep, watchlist, `fetch_resilient`, `verify_contracts`), `telegram_bot.py` (long-poll bot),
  `routes/` (`ui.py` is now only the React shell and its asset route),
  `frontend/` (Vite + React + TS — the dashboard at `/ui`; built assets are COMMITTED under
  `static/app/`, so node is never needed to run the service — `make build-ui`, `make check-ui`,
  `make test-ui`. See ADR 0005. The htmx dashboard was retired once React reached parity.)

## Invariants — user-ratified in design sessions; do not "fix" without asking

- One worker thread owns run execution. The sweep, `/spx/quote`, `/quotes`, and creation probes make single
  bounded OpenD calls outside that queue — documented exceptions, not violations.
- The whole watchlist is ONE `get_market_snapshot` call per sweep (combo legs join the batch, deduped).
  The dashboard makes NO call of its own: it renders the sweep's cached records, so a row's value and its
  🔔 always come from the same instant. The dashboard poll is INDEPENDENT of the sweep: the sweep sets how
  fresh the data is, the poll sets how soon the newest sweep reaches the screen. Polling faster is free.
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
  and means LAST TRADE, not freshness — `fetched_at` is freshness. Schedule cron tz stays `America/New_York`.
- Config: behavior knobs live in `.env` (which mirrors `.env.example`'s structure — active lines are overrides,
  commented lines show defaults); viewer preferences (dashboard refresh) live in browser cookies. No DB config
  layer.
- Behind the path-stripping proxy, Starlette `Mount`s don't resolve — serve static assets via routes, not
  `StaticFiles` (see `app_asset`). The React shell injects `root_path` for the same reason: the browser
  sees `/opt/...` while the app sees `/...`.

## Testing conventions

- `tests/conftest.py`'s `client_factory` injects an echo `snapshot_fetcher` by default — tests must NEVER reach
  the real moomoo SDK (it blocks indefinitely on dead ports; a missing fake looks like a hung suite).
- Bot tests drive `TelegramBot.handle_update` directly with a `FakeApi`; sweep tests call
  `MonitorSweeper.sweep()` with fake fetchers/senders. Dates in tests are computed relative to today.

## Workflow & environment

- Branch → PR → the owner merges (never merge or push to main directly). Restart the agent after landing.
- `.env` is gitignored and holds live Telegram credentials — never commit it or echo its secrets into
  committed files. `data/optionality.db` is live state (watchlist, run history) with no backup yet.
- The Telegram bot token allows ONE `getUpdates` consumer: never run two service instances against it, and
  avoid external `getUpdates` curls while the service runs.
