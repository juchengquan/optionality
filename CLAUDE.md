# CLAUDE.md

SPX options monitoring service: FastAPI + APScheduler + SQLite, Telegram bot, server-rendered dashboard.
Deployed as a macOS launchd agent on the owner's always-on machine, behind `tailscale serve --set-path /api`.

## Commands

- `make test` / `make lint` / `make format` — run all three before every commit. Lint is ruff with a broad
  external ruleset (expect rules far beyond the defaults; per-file `BLE001` ignores exist for the
  worker/sweeper/bot, whose job is to survive any failure).
- `make serve` — run locally (loads `.env`). Production runs via launchd: **`make launchd-restart` after every
  merge or pull** — launchd does not watch the repo, and the agent runs this working tree.
- Schema change: edit `service/models.py`, then
  `OPTIONALITY_DB_PATH=data/optionality.db uv run alembic revision --autogenerate -m "..."` and
  `... alembic upgrade head`. Alembic runs in batch mode (SQLite table rebuilds). **Squash a branch's
  migrations before it merges; never touch shipped migrations.** Startup `create_all` covers fresh DBs.
- uv only, never pip. Python ≥ 3.12. TDD: write the failing test first; the whole codebase was built that way.

## Layout (`src/optionality/`)

- `core.py` — run pipeline + `fetch_snapshot` (CLI `main.py` and the service share it)
- `apis/` moomoo + yfinance + `build_spx_code`/`normalize_strike_date`; `notification/` gmail, file, telegram
- `service/`: `app.py` (factory, auth middleware, lifespan), `worker.py` (THE single job thread),
  `scheduler.py` (APScheduler; `refresh_jobs` must only touch `schedule-*` job ids),
  `monitor.py` (sweep, watchlist, `fetch_resilient`, `verify_contracts`), `telegram_bot.py` (long-poll bot),
  `routes/` + `templates/` (Jinja2 + vendored htmx; the only JavaScript in the project)

## Invariants — user-ratified in design sessions; do not "fix" without asking

- One worker thread owns run execution. The sweep, `/spx/quote`, `/quotes`, and creation probes make single
  bounded OpenD calls outside that queue — documented exceptions, not violations.
- The whole watchlist is ONE `get_market_snapshot` call per sweep/page (combo legs join the batch, deduped).
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
  `StaticFiles` (see `htmx_asset`).

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
