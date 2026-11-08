# CLAUDE.md

SPX options monitoring service: a JSON API, an alarm engine, a Telegram bot and a React dashboard.
**Two launchd agents** serve it, and a third watches what it depends on, on the owner's
always-on machine, behind one tailnet hostname (ADR 0006):
the API on 127.0.0.1:31415 (`/opt/api`) and `com.optionality.ui` (Caddy serving `frontend/dist`, `/opt`).
Same origin, so no CORS. `~/recovery.sh` rebuilds the whole tailscale serve table and both agents.

**The service is TypeScript (ADR 0009):** `com.optionality.api` runs `backend/src/main.ts` under node,
on `data/optionality-ts.db`. Node runs the TypeScript directly, so what is in the working tree is what
runs. The Python service it replaced, and the run pipeline (strategy and holdings scans), were deleted in
phase 10 (ADR 0014); the `python-before-phase-10` tag keeps them. The Python's own database,
`data/optionality.db`, was frozen at the 2026-10-02 cutover and never opened again — and no longer
sits in `data/` at all: it went into `archive/python-era-20261017.tar.gz` in `BACKUP_DIR` on
2026-10-17, as `pyarch/optionality.db`. There is no rollback.

**The TypeScript domain is canonical** (`backend/src/domain/`). A Python package, `optionality` in
`python/`, is ported FROM it for notebook use (ADR 0014) and held to it by the golden cases in `testdata/golden/`,
compared exactly. A TypeScript domain fix therefore makes `make test` red until the Python is ported.

## Commands

- **`make check` before every commit** — everything, in one target, and it passes in any timezone:
  every suite that reads a clock is pinned to `TZ=UTC` (both vitest configs, the Python suite, and the
  case generator), because the frontend's was not and the gate was green only at +08. The browser
  suite is checked zone-independent instead — `env` would not reach its Chromium. Targets: lint, typecheck, `check-api`,
  `check-cases`, the Python suite, the API suite, both UI suites and `check-ui`. Running a subset is
  how a commit passes while something it touched is broken: `make test` alone is only the Python
  package (every golden case, reproduced exactly). `make lint` is ruff plus `check-boundaries`: no
  package imports another's source tree, only its package.json `exports` (`backend` for `AppType`,
  `backend/schemas` for the input schemas; ADR 0014). `make format` formats the Python only.
- **The TypeScript has no formatter, by decision** (2026-10-17). Prettier and Biome were measured
  against this code with its own settings: both rewrote about 120 of 143 files, nearly all of it
  exploding the compact parameter lists below one-per-line, and Prettier dropped grouping
  parentheses that carry meaning (`(s - t) + x` in `pySum`). The style is consistent without one —
  keep it: **double quotes, semicolons, two-space indent, about 100 columns, related parameters on
  one line**, comments as hand-wrapped prose. `.editorconfig` holds the mechanical part. Workspace
  package names are their directory names (`backend`, `frontend`).
- `make deploy` — **the only correct way to land a merge**: pull, install, back up the DB, restart BOTH
  agents (the API applies pending migrations at boot). launchd does not watch the repo and the agents
  run this working tree, so a merge that skips this leaves stale code running. Doing the steps by hand
  is how the dashboard and the API drift apart.
- TypeScript: `make test-api` (the suite), `make typecheck`, **`make check-api`** (every module loads
  under Node — `tsc` and vitest both accept syntax Node refuses to run, and two classes reached main
  unable to load at all).
- **Golden cases:** a change to anything `backend/src/domain/` exports changes what
  `testdata/golden/*.json` should say. `make cases` regenerates them and `make check-cases` — and `make test-api`
  — fail until you do. Never edit them by hand; add inputs to `backend/src/cases/inputs.ts`. Every
  exported domain function must have a case (ADR 0014), decisions included (ADR 0017) — `cases.test.ts`
  holds the module list to the DIRECTORY, so a new `domain/` file demands its cases and its Python port.
  The harness refuses a case passing MORE arguments than the port takes — `zip(strict=False)` dropped
  the extra in silence, so a parameter lost in the port left every case passing on a default.
  Exported CONSTANTS are stated in the same files and compared too; they were mirrored on trust until
  the coverage guard was found to filter on `typeof v === "function"`. **Generated under `TZ=UTC`**,
  as the suites read them: a default zone is the running machine's, so an unpinned corpus would say
  `+08:00` here and `+01:00` in Berlin. The generator is `tools/cases.ts`, not
  `backend/`'s: it also writes the two FINGERPRINT stamps (`backend/src/golden.ts` and
  `python/src/optionality/_ported.py`, ADR 0016), and writing into another package's source is a
  repo-wide codegen step rather than something the backend may do. Both stamps are generated and
  committed; `make check-cases` fails when either is stale.
- **`make ibkr-fake-gateway`** — a stub IB Gateway speaking the SOCKET protocol, for driving the
  `ibkr/` client by hand. Its replies are RECORDED, not invented: what the client sends was captured
  from the official Python client with `sendMsg` intercepted at protocol 157, and what the gateway
  replies is what the real gateway on this machine sent for `SPXW 20261218 C 8100` on 2026-11-08.
  One definition, in `src/ibkr/fake.ts`, shared with the suite so the two cannot drift. A run
  against it proves the CLIENT and is never evidence about a provider, an account's entitlements,
  a dead session or an open market.
  This name is REUSED rather than new: `ibkr-fake-gateway` served the Client Portal stub until
  #205 deleted that transport and the whole of the old `ibkr/` with it, and the socket stub then
  took both the directory name and the target name (named for the gateway it speaks to, as
  `opend/` is). The retired `ibkr-first-contact` has no replacement — the first-contact harness
  needs a socket-shaped runner nobody has written. The ideas worth lifting are in #205's history:
  `hasFigures`'s distinction between a figure that has not arrived and a Contract that does not
  exist, and the five questions only a real gateway can answer.
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
  `rows.test.ts` tie those three together, so a half-done change fails rather than drifts. They tie
  three legs of four: `rows.test.ts` builds its subject from `schema.sql`, so the MIGRATION is held
  by `migrate.test.ts`'s "the two roads into a database", which migrates `db/schema-base.sql` (the
  shape before 0001 — never edit it) and compares the result to a fresh database, column for column
  and null for null. Without it a column added everywhere but the migrations passed every check and
  reached the live file as `no such column`.
  `main.ts` applies what is pending at boot and a failure there is fatal on purpose. A database
  built from `schema.sql` is STAMPED, not migrated (ADR 0011). `make deploy` backs the file up
  before it restarts, so the backup predates the migration. **Never edit a migration that has
  run.**
- uv only, never pip. Python ≥ 3.12. TDD: write the failing test first; the whole codebase was built that way.

## Layout

- `backend/src/`: `main.ts` (the process), `app.ts` (routes, auth, `/docs`), `routes/`, `domain/` (everything pure
  and canonical, importing nothing outside itself — the maths, and since ADR 0017 the DECISIONS too:
  `alarm.ts` and its Telegram wording, `lifecycle.ts`'s quarantine and expiry verdicts, and `js.ts`,
  the four JavaScript behaviours a port must reproduce. See golden cases), `sweeper.ts` (the alarm engine), `scheduler.ts` (the sweep loop
  and its watchdog — NOT dead code: it is what drives the alarms), `watchlist.ts`, `bot/` (long-poll
  Telegram bot), `opend/` (the moomoo websocket client), `ibkr/` (IB Gateway's own socket protocol:
  framing, the handshake with its protocol floor of 156, the five messages a read-only quote fetch
  sends, and since ADR 0019 the bounded ask itself — there is no order message and none is
  importable, so the service cannot trade by absence rather than by discipline. Reached as a
  REFERENCE source whether or not it is the Provider, because a Reference alarms on nothing;
  `IBKR_HOST` turns it on and blank turns it off), `db/` (schema, migrations, queries),
  `cases/` (the golden cases' inputs and builder), `references.ts` (the Reference path: one bounded
  call of its own, and the only degrade in the service that retries one code at a time — bounded by
  the number of References, which the sweep could not afford; ADR 0018).
- `frontend/` — Vite + React + TS, the dashboard at `/opt`. `frontend/dist` is committed.
- `testdata/golden/` — the golden cases (generated test data). `tools/check-boundaries.mjs` — the package-boundary lint.
- `python/` — the `optionality` package (ADR 0014): `src/optionality/` mirrors `backend/src/domain/` module
  for module (snake_case the only translation), `js.py` holds the JavaScript number rules the port
  must reproduce (cased since ADR 0017, and named `js.py` not `_js.py` for that reason),
  `opend.py` needs the `opend` extra AND owns the containment loop that drops a code moomoo names as
  unknown — inside the provider, where `opend/client.ts` has it (ADR 0015, #168), not above the port;
  `quotes.py` is the port's contract plus the one fetch-and-catch that cannot be pure, and `api.py`
  loads Positions and Monitors from the live service (`OPTIONALITY_API` for its URL). Only those
  three are not golden-cased: they mirror no domain module. Everything else is, decisions included —
  45 of 51 public functions.
  `tests/test_cases.py` runs every golden case.
  **Installed by a pinned git ref** (ADR 0016), never from a path that tracks the working tree —
  an editable install serves a notebook whatever half-ported state the tree is in:
  `uv add "optionality @ git+https://github.com/juchengquan/optionality.git@py-<version>#subdirectory=python"`.
  Versions are CalVer (`2026.11.1`, unpadded — PEP 440 normalises `09` to `9`), cut with
  `make py-cut` on a branch and tagged with `make py-tag` on main after the bump merges.
  `optionality.api.agrees()` asks a running service whether the port is still current; it never
  runs on import, and answers "no service" rather than raising.

## Invariants — user-ratified in design sessions; do not "fix" without asking

- Every call for **market data** is a single bounded one: the sweep, `/quotes`, `/references`,
  `/positions/values` and the creation probes. Widened from "every call to the Provider" by ADR
  0019, whose Provider-only wording is deprecated: a Reference may name a vendor the rest of the
  service does not use, and left Provider-specific the rule would have permitted an UNBOUNDED
  call to one — a loophole that change itself created. `/references` makes one bounded call per
  SOURCE in use, not per Reference, and a dead vendor dashes its own rows and nobody else's. (`/spx/quote` was a sixth until #199 dropped it:
  nothing called it, and the bot's `/snapshot` answers the same question in-process.) (`/positions/values` is polled by the dashboard's Holdings
  panel while it is open.) `/references` is polled WITH `/quotes` — two calls per poll per open
  tab — and is a call of its own rather than part of that batch for containment, not for cost:
  moomoo rejects a whole batch for one bad code and the containment loop drops only a code it
  NAMES, so a class refusal (`US..SPX`, which is the first thing a reasonable person types) would
  blank every row the owner acts on. It is also the one route that cannot fail: a Provider that is
  wholly down leaves each Reference a dash with its own sentence (ADR 0018). This read "one worker thread owns run execution, and these are the exceptions"
  until phase 10 retired the worker with the run pipeline it existed for (ADR 0014), and named OpenD until
  ADR 0015 made the vendor one Provider among others — `OPTIONALITY_PROVIDER` chooses, and the rule holds
  for whichever answers.
- The whole watchlist is ONE snapshot call per sweep (combo legs join the batch, deduped).
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
  A rule the engine cannot evaluate → quarantine (disable + Telegram notice, NEVER delete), for either
  fault: an unknown contract, or a watched figure that has not arrived for `QUARANTINE_AFTER_SILENT_SWEEPS`
  consecutive sweeps (observed, never declared — what a provider serves depends on the account, not on its
  code; 0 only logs). Expired monitors: mute with notice, auto-delete after `EXPIRED_RETENTION_DAYS`.
  Nothing else is ever auto-deleted.
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
- **`com.optionality.opend`** (`make launchd-opend-install`) watches OpenD, which everything else
  depends on and nothing was watching: it exited cleanly after 23 days up on 2026-11-08 and the
  sweep failed 646 times over 2h42m. A TIMER every 60s calling `~/openD.sh ensure`, not KeepAlive,
  for two reasons: that script backgrounds OpenD and returns, so KeepAlive would see the job end
  and restart it for ever; and KeepAlive can only see whether a process EXISTS, where the failure
  that matters is an OpenD up with its websocket port shut — which looks healthy to the operating
  system while the dashboard shows dashes. `ensure` starts a dead OpenD, restarts a husk whose API
  port is shut, and only REPORTS one that is up without a confirmed session, because that may need
  a human at the login window and a restart a minute against an expired credential is a watchdog
  flapping a provider.
  **`AbandonProcessGroup` is not optional here.** `opend.sh start` backgrounds OpenD and returns,
  and launchd tears down the rest of a job's process group when the job's own process exits —
  taking OpenD with it. Without that key the watchdog killed what it started, 27 seconds after
  every tick: 39 starts in an hour, each one looking successful in its log, and `/quotes` 502ing
  in the gaps. It survived three kill-and-recover demonstrations because every check came seconds
  after the restart. A process-supervision change is verified by watching it STAY up.
  **Two copies of that script exist on purpose.** `deploy/macos/opend.sh` is committed and is the one
  the agent runs — so the version-controlled copy is the one whose behaviour you see. `~/openD.sh`
  is the owner's and must keep working with NO repository cloned, which is why it is a copy rather
  than a symlink. `make check-opend` fails when they differ and is part of `make check`, the same
  arrangement `check-ui` uses for the committed bundle; `make opend-sync` copies the committed one
  over the other, keeping its account line. The ONE difference by design is that account:
  `deploy/macos/opend.sh` has none, `~/openD.sh` keeps a literal default, and
  `make launchd-opend-install` stamps `OPEND_LOGIN_ACCOUNT` from `.env` into the generated agent —
  which lives outside the repo, so the account is only ever where git does not look. That target
  refuses to install when it is unset, because an agent that restarts a failing login every 60
  seconds is a measured failure mode rather than a hypothetical. `make opend-logs` follows it.
  - `com.optionality.backup` (`make launchd-backup-install`) takes a checked, gzipped one at 06:00
    into `BACKUP_DIR`, keeping 14 nights and the first of each of 12 months. `BACKUP_DIR` is a
    folder in iCloud Drive (`~/Library/Mobile Documents/com~apple~CloudDocs/optionality-backups`),
    which is what takes them off this machine; the Python-era archive is in its `archive/`.
  - Restore only with `make restore FROM=<file>`. Copying a backup over the live file leaves its
    `-wal` beside it, and SQLite replays that old log onto the restored data.
- The Telegram bot token allows ONE `getUpdates` consumer: never run two service instances against it, and
  avoid external `getUpdates` curls while the service runs.
