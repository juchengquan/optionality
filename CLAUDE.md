# CLAUDE.md

SPX options monitoring service: a JSON API, an alarm engine, a Telegram bot and a React dashboard.
**Two launchd agents** serve it, and a third watches what it depends on, on the owner's
always-on machine, behind one tailnet hostname (ADR 0006):
the API on 127.0.0.1:31415 (`/opt/api`) and `com.optionality.ui` (Caddy serving `frontend/dist`, `/opt`).
Same origin, so no CORS. `~/recovery.sh` rebuilds the whole tailscale serve table and both agents.

**The service is TypeScript (ADR 0009):** `com.optionality.api` runs `backend/src/main.ts` under node,
on `data/optionality-ts.db` — and only it, until the owner switches it: since 2026-11-10 every door
scenario passes and every backend module is ported, so `make use BACKEND=python` passes its guard,
and running it is a drill (below), the owner's call. Node runs the TypeScript directly, so what is
in the working tree is what runs. The Python
service it replaced, and the run pipeline (strategy and holdings scans), were deleted in
phase 10 (ADR 0014); the `python-before-phase-10` tag keeps them. The Python's own database,
`data/optionality.db`, was frozen at the 2026-10-02 cutover and never opened again — and no longer
sits in `data/` at all: it went into `archive/python-era-20261017.tar.gz` in `BACKUP_DIR` on
2026-10-17, as `pyarch/optionality.db`. There is no rollback.

**The TypeScript domain is canonical** (`typescript/src/domain/`). A Python package, `optionality` in
`python/`, is ported FROM it for notebook use (ADR 0014) and held to it by the golden cases in `testdata/golden/`,
compared exactly. A TypeScript domain fix therefore makes `make test` red until the Python is ported.

**ADR 0021 (accepted 2026-11-09, being built) takes the Python to the whole service**: a second
backend that can run the sweep, the alarms, the database, the API and the bot, one backend at a
time, ported module for module and held to the TypeScript at its three doors. It is built in six
phases, and each phase updates this file when it lands, so everything below describes what exists
today. Until a phase says otherwise, nothing here changes: the TypeScript is the only backend, and
the read-only property below still holds for the only code that runs.

**Each language has a library and a backend (ADR 0021).** The TypeScript library is `typescript/`,
npm package `optionality` — everything callable with NO service running: the domain, `quotes.ts`, the
vendor clients and their field mappings, the fake IB Gateway, the case builder and the golden stamp.
The backend, `backend/`, is everything that needs Settings, the database, the sweep loop or a way to
deliver, and it reaches the library only by name (`optionality/domain/alarm`, `optionality/quotes`, …),
through `typescript/package.json`'s `exports`. The library imports nothing from the backend, and
`check-boundaries` holds that direction.

## Commands

- **`make check` before every commit** — everything, in one target, and it passes in any timezone:
  every suite that reads a clock is pinned to `TZ=UTC` (the library's, the backend's and the
  frontend's vitest configs, the Python suite, and the case generator), because the frontend's was
  not and the gate was green only at +08. The browser
  suite is checked zone-independent instead — `env` would not reach its Chromium. Targets, in the
  order they run: lint, typecheck, `check-api`, `check-cases`, `check-scenarios`, the Python suites
  (the library's, then the Python backend's), `test-tools` (the repo-wide `tools/`, which no
  workspace's suite covers), the library suite (`test-lib`), the API suite, both UI suites,
  `check-ui` and `check-opend`. This list went stale twice without a gate noticing, and it is
  worth knowing why:
  `check-make-targets` checks that every backticked invocation names a rule that EXISTS, never that a
  documented SET is complete, so a target added to the `check` rule is nobody's job to write down
  here. Running a subset is how a commit passes while something it touched is broken: `make test`
  alone is only the Python (every golden case, reproduced exactly, then `python-backend/`'s suite).
  `make lint` is ruff over both Python packages (`check`, and `format --check`: `make format` is
  what fixes it) plus six scripts — `check-boundaries`,
  `check-test-support`, `check-seams` (four seams: the backend's `vendors/` and the library's,
  `engine/`, `entrypoints/`), `check-module-map`, `check-make-targets`, `check-served-root` — and
  `check-py-backend`, the Python backend's three lines (ADR 0021): it imports only the library's
  public modules, it names no order call or class outside a `trading/` that does not exist
  (the library holds itself to the second with no door at all, in its own suite), and it keeps
  `check-seams`' four seams, which reads no Python: `vendors/` and the library's clients behind it,
  `engine/`, `entrypoints/`.
  `check-module-map` holds the same backend module for module: every TypeScript backend module has
  its Python port or a reason in the tool's table, landed in the same change (lockstep, ADR 0021);
  the first port's backlog emptied on 2026-11-10 and was deleted. The first:
  no package imports another's source tree, only its package.json `exports` (`backend` for `AppType`,
  `backend/schemas` for the input schemas, `optionality/...` for the library; ADR 0014) — and its
  `DEPENDS` says which may import which BY NAME at all: the library nothing, the backend the library,
  the frontend the backend (ADR 0021). A published name passes the first rule, so without the second
  the library could import the service. `make format` formats the Python only.
  **The Python is one uv workspace** (ADR 0021): the root `pyproject.toml` (virtual, no package of
  its own) with members `python/` and `python-backend/`, one root `uv.lock` and one root `.venv`.
  `python/pyproject.toml` must stay self-contained — notebooks build it alone from its subdirectory.
- **The TypeScript has no formatter, by decision** (2026-10-17). Prettier and Biome were measured
  against this code with its own settings: both rewrote about 120 of 143 files, nearly all of it
  exploding the compact parameter lists below one-per-line, and Prettier dropped grouping
  parentheses that carry meaning (`(s - t) + x` in `pySum`). The style is consistent without one —
  keep it: **double quotes, semicolons, two-space indent, about 100 columns, related parameters on
  one line**, comments as hand-wrapped prose. `.editorconfig` holds the mechanical part. Workspace
  package names are their directory names (`backend`, `frontend`), with ONE exception: the library's
  directory is `typescript/` and its package is `optionality` — the Python library's name too —
  because `typescript` is the compiler's own npm name (ADR 0021). `npm install` links it from the
  workspace (`node_modules/optionality -> ../typescript`), never from the public registry, which
  has a package of the same name (1.2.1 when measured on 2026-11-09).
- `make deploy` — **the only correct way to land a merge**: pull, install BOTH backends (`npm install`
  and `uv sync --all-packages --locked`, whichever is live), back up the DB, restart BOTH agents (the
  API applies pending migrations at boot). Which backend the API agent runs is READ from its
  installed plist, never assumed, and a Python this tree cannot back stops the deploy before the
  restart. launchd does not watch the repo and the agents
  run this working tree, so a merge that skips this leaves stale code running. Doing the steps by hand
  is how the dashboard and the API drift apart.
- `make use BACKEND=ts|python` — **switch the live backend** (ADR 0021, Decision 3): the guard, the
  backup `make deploy` takes, then boot the running backend out and the chosen one in under the
  same label, and wait for `/health` to answer 200. **`BACKEND=python` is refused** while the port
  is incomplete, printing `N of M door scenarios ported` and each door still missing, then
  `N of M backend modules ported` and each module with no port. Since 2026-11-10 it refuses
  nothing: every door scenario passes and every module is ported (see Workflow & environment).
  Never run it to "try" the Python: a drill is the owner's call.
- TypeScript: `make test-lib` (the library's suite), `make test-api` (the backend's), `make typecheck`,
  **`make check-api`** (every module of BOTH packages loads under Node — `tsc` and vitest both accept
  syntax Node refuses to run, and two classes reached main unable to load at all. It is
  `tools/check-loads.ts`, repo-wide, because walking the library from inside the backend would be a
  path into another package's source).
- **Golden cases:** a change to anything `typescript/src/domain/` exports changes what
  `testdata/golden/*.json` should say. `make cases` regenerates them, and WHICH gate stops you depends on
  the kind of change: a CHANGED function or constant renders different bytes, so `make check-cases` and
  `make test-lib` both fail until you regenerate. An ADDITION renders no bytes — a new exported
  function with no case, or a whole new `domain/` module, produces nothing to compare — so
  `make check-cases` stays green and only `make test-lib` catches it, through `cases.test.ts`'s
  coverage guards. Never edit them by hand; add inputs to `typescript/src/cases/inputs.ts`.
  **A SECOND corpus**, `testdata/vendors/`, records what each vendor's `fields.ts` computes — pure,
  canonical logic that the guard above cannot reach, because it holds its module list to the
  `domain/` DIRECTORY and these are not in it. Same shape, same `make cases`, same staleness check,
  its own coverage guard (`cases/vendors.test.ts`), inputs in `cases/vendors.ts`. It records each
  module's exported CONSTANTS as well as its cases, which is why `MARKET_DATA_DELAYED_FROZEN` — the
  grade `ibkr/client.ts` asks the gateway for — lives in `ibkr/fields.ts` beside the `grade` that
  reads the answer, rather than beside the message that carries it: nothing else could hold it. The
  fake gateway answers `reqMarketDataType` with nothing, as the real one does, so no replay can see
  which grade was asked, and changing the Python port's copy of that number left all 688 of its
  tests passing. Recorded here, `test_ibkr.py` compares it like any other shared number, in both
  directions — a constant the corpus states and the port lacks fails too. Deliberately NOT
  part of the `GOLDEN_CASES` fingerprint: that answers "does this port reproduce the DOMAIN", and
  the Python package has no vendor ports yet — folding these in would make `py-2026.11.9`, tagged
  and answering "agrees" today, report disagreement over code it does not contain. Every
  exported domain function must have a case (ADR 0014), decisions included (ADR 0017) — `cases.test.ts`
  holds the module list to the DIRECTORY, so a new `domain/` file demands its cases and its Python port.
  The harness refuses a case passing MORE arguments than the port takes — `zip(strict=False)` dropped
  the extra in silence, so a parameter lost in the port left every case passing on a default.
  Exported CONSTANTS are stated in the same files and compared too; they were mirrored on trust until
  the coverage guard was found to filter on `typeof v === "function"`. **Generated under `TZ=UTC`**,
  as the suites read them: a default zone is the running machine's, so an unpinned corpus would say
  `+08:00` here and `+01:00` in Berlin. The generator is `tools/cases.ts`, not
  the library's: it also writes the two FINGERPRINT stamps (`typescript/src/golden.ts`, which the
  backend's `/health` reads as `optionality/golden`, and
  `python/src/optionality/_ported.py`, ADR 0016), and writing into another package's source is a
  repo-wide codegen step rather than something the library may do. Both stamps are generated and
  committed; `make check-cases` fails when either is stale.
  **A THIRD corpus**, `testdata/vendors/ibkr-gateway/`, holds the two IB Gateway clients of ADR
  0021 (Decision 7) — this one, hand-written, and the Python library's, on `ib_async`
  (`python/src/optionality/ibkr.py`) — to "the same recording in, the same quote batch out". Its `*.json` are RECORDINGS: what the gateway
  sends, message by message, every field the exact text the wire carried, each file saying in
  `provenance` whether it was captured (when, which gateway, how, and every byte altered since)
  or constructed (why, and from what). They are inputs; `make cases` never writes them, and
  `recordings.test.ts` refuses one that says neither, or that carries an account number other than
  the placeholder. `expected/*.json` is generated: what `ibkr/client.ts` returns or throws for each,
  replayed through the fake by `ibkr/replay.ts`, every reply at once. `make check-cases` and
  `cases/gateway.test.ts` fail when one is stale, missing, or has no recording; outside the
  fingerprint for the vendor corpus' reason. Its README is written for the Python stub's author,
  and that stub is `python/tests/fake_gateway.py`: `tests/test_ibkr_gateway.py` replays EVERY
  recording through it to the Python client and compares the batch, or the exact words raised, to
  `expected/` with `test_cases.same`. Parametrized from the directory, so a new recording is
  replayed there too and fails until the Python answers what the TypeScript did.
- **Door scenarios** (ADR 0021, phase 1c): `testdata/scenarios/{http,bot,sweep}/` — a stated world
  (rows, `.env` lines, what each vendor answers, the clock), ONE request, Telegram update or sweep
  tick, and exactly what the service did: the response or reply, the rows it changed, the messages
  it sent, the codes it asked each vendor for. The shared ground a second backend is held to.
  **`make scenarios`** regenerates them from `backend/testing/scenarios/inputs/` (and `make cases`
  runs it too, because `/health` carries the golden fingerprint); **`make check-scenarios`** fails
  on a stale, missing or orphaned file. Never edit them by hand. `test-api` replays every file
  (`replay.test.ts`) and holds each door's coverage (`coverage.test.ts`): every status of every
  endpoint in `/openapi.json`, every command in the bot's published "/" menu, and every outcome in
  `outcomes.ts` — whose own list is held to the decisions the engine imports and the
  `disabled_reason`s it writes. Ids and the clock are INJECTED (`Deps.newId`, `BotDeps.newId`), not
  scrubbed. `testdata/scenarios/README.md` is the format, for a runner in another language.
  **`make scenarios` also writes `schema/api/`** — `openapi.json` and `docs.html`, what the
  TypeScript answers to `/openapi.json` and `/docs` with `ROOT_PATH` blank — and `check-scenarios`
  fails when either is stale. The Python SERVES them (`entrypoints/http/openapi.py`) with its own
  root path put in, because the owner decided on 2026-11-10 that its description is the
  TypeScript's word for word, where FastAPI would write one of its own. Four HTTP scenarios hold
  both pages, with the root path blank and set.
  **The Python's runner** (phase 2) is `python-backend/tests/scenarios/`, module for module with
  `backend/testing/scenarios/`, and `make test` replays every file through it. While the first port
  lasts, a scenario on its BACKLOG (`scenarios/backlog.py`) is skipped with its reason, and the
  suite's last line counts the port: "door scenarios: N of M ported". The backlog was frozen on
  2026-11-09 with all 120, may only shrink, and has been empty since 2026-11-10.
- **`make ibkr-fake-gateway`** — a stub IB Gateway speaking the SOCKET protocol, for driving the
  `ibkr/` client by hand (`ARGS="--conversation link-down"` picks what it replays). It says nothing
  of its own: it replays one conversation from `testdata/vendors/ibkr-gateway/` (above), the same
  files `python/tests/fake_gateway.py` replays to `ib_async`. `normal-with-greeks`, the default, is what the real
  gateway on this machine sent for `SPXW 20261218 C 8100` on 2026-11-09, byte for byte. The stub's
  inline replies of 2026-11-08 were retired with that move, because three things in them no
  capture shows: a contract reply cut to the fifteen fields this client reads (`ib_async` reads
  all thirty-nine and ran off the end), nextValidId sent before managedAccounts, and a gateway
  clock in a format the gateway does not use. Their figures survive in
  `testdata/vendors/ibkr-fields.json`.
  One definition, in the library's `typescript/src/vendors/ibkr/fake.ts` (`optionality/vendors/ibkr/fake`
  to the backend's `tools/ibkr-fake-gateway.ts`), shared with the library's suite so the two cannot
  drift — and, with `vendors/fields.ts` and `ibkr/replay.ts`, one of the three doors of the
  library's vendor seam that `check-seams` lets anything import: it is the fake GATEWAY and not a
  client, and `replay.ts` runs a client only against a stub it starts itself. A run
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
  you. Port 31417, not 31415, and IB client id 31417 for the same reason: the gateway allows one
  connection per client id, and a local run on the live service's would displace it in silence.
- `make build-ui` / `check-ui` / `test-ui` for the frontend;
  the bundle in `frontend/dist` is COMMITTED so node never sits on the deploy path. Two frontend branches
  therefore collide in `dist` every time: **`make resolve-ui`** settles it by rebuilding from the merged
  source — never hand-merge a bundle, and never configure a merge driver for it (`.gitattributes` says why).
  The browser suite runs as TWO vitest instances of Chromium: the desktop one runs every
  `src/__browser__/*.test.tsx`, and `iphone` — Playwright's iPhone 13 profile, `isMobile` and
  touch — runs only `*.iphone.test.tsx`. Each instance names its own files and the suite-wide
  `include` is EMPTY on purpose: vitest merges an instance's list into that one rather than
  replacing it, so anything there runs in both. And because Vite finds the files to pre-bundle
  dependencies from through that same list, `optimizeDeps.entries` names the test files instead —
  without it nothing was pre-bundled, and the mid-run reload failed ten files on every cold cache.
- **Schema change:** add a `.sql` file to
  `schema/migrations/` AND put the same shape in `schema/schema.sql`, then update
  `COLUMNS`, `NULLABLE`, the row interface and `SchemaChecks` in `backend/src/db/rows.ts` — the
  compiler and `rows.test.ts` tie those three together, so a half-done change fails rather than
  drifts. They tie three legs of four: `rows.test.ts` builds its subject from `schema.sql`, so the
  MIGRATION is held by `migrate.test.ts`'s "the two roads into a database", which migrates
  `schema/schema-base.sql` (the shape before 0001 — never edit it) and compares the result to a
  fresh database, column for column and null for null.
  `schema/` sits at the repository root, not in `backend/`, because it is SHARED GROUND like
  `testdata/` (ADR 0021): one database file, one schema and the same migrations, applied by
  whichever backend starts first — and `check-boundaries` refuses either backend reading the
  other's source tree. `db/open.ts` and `db/migrate.ts` resolve it from their own module, never
  from the working directory, so the service finds it wherever Node was started. Without it a column added everywhere but the migrations passed every check and
  reached the live file as `no such column`.
  `main.ts` applies what is pending at boot and a failure there is fatal on purpose. A database
  built from `schema.sql` is STAMPED, not migrated (ADR 0011). `make deploy` backs the file up
  before it restarts, so the backup predates the migration. **Never edit a migration that has
  run.**
- uv only, never pip. Python ≥ 3.12. TDD: write the failing test first; the whole codebase was built that way.

## Layout

- `typescript/src/` — the LIBRARY, npm package `optionality` (ADR 0021): callable with no service
  running, and importing nothing from the backend. `domain/` (everything pure
  and canonical, importing nothing outside itself — the maths, and since ADR 0017 the DECISIONS too:
  `alarm.ts` and its Telegram wording, `lifecycle.ts`'s expiry verdict and all THREE
  quarantine faults — an unknown contract, a figure that never arrives, and a row that cannot be hydrated;
  the first and the last were written beside the `updateMonitorFields` they caused until the second was
  already cased, so a notebook could ask what the next sweep would do about one fault and not the others, and `js.ts`,
  the four JavaScript behaviours a port must reproduce. See golden cases), `quotes.ts` (the
  market-data port, `QuoteFetcher`, and what the service does with a batch — logic rather than
  transport), **`vendors/`** (the CLIENTS. `opend/` is the moomoo websocket client; `ibkr/` is IB Gateway's own socket protocol:
  framing, the handshake with its protocol floor of 156, the five messages a read-only quote fetch
  sends, and since ADR 0019 the bounded ask itself — there is no order message and none is
  importable, so the service cannot trade by absence rather than by discipline; `yahoo/` wraps
  `yahoo-finance2`. Each vendor's pure `fields.ts` is re-exported by `vendors/fields.ts`, a door
  of its own so `testdata/vendors/` can record one truth for two languages: it imports nothing but
  the two `fields.ts` modules, because a door that reached a client would typecheck the moomoo
  SDK's declarations into the case generator, which calls neither. `ibkr/fake.ts` is the fake
  gateway (`make ibkr-fake-gateway`), replaying `ibkr/recordings.ts`'s files, and `ibkr/replay.ts`
  turns each into its expected batch for `make cases` — a door that takes no host and no port.
  The interior is a seam: only the backend's `vendors/` may import a client — `check-seams`
  names it the one `insider`, and resolves the backend's imports BY NAME through `exports` to the
  file they land on), `cases/` (the golden cases' inputs and
  builder) and `golden.ts` (the stamp `/health` carries). `package.json`'s `exports` name what is
  public — `./domain/*`, `./quotes`, `./golden`, `./vendors/fields`, each vendor's client, OpenD's
  probe and the fake gateway — and Node refuses the rest, so `wire.ts`, `socket.ts` and their
  siblings are the library's own.
- `backend/src/`: `main.ts` (the process, and the ONLY file that wires delivery to the library —
  ADR 0020's word for the service's own logic beside its entrypoints, which predates the
  `typescript/` library and means `backend/src/` minus delivery),
  **`entrypoints/`** (every way the outside world reaches the service, each behind its own door:
  `entrypoints/http/` and `entrypoints/bot/`. `make check-seams` holds the direction — the library
  depends on neither, and `importableBy` names `main.ts` and the test harness as the only callers,
  so no service can reach a surface and no request can reach another surface's routes. A test also
  refuses a NEW surface that arrives with no door declared, which is the one thing a per-surface
  rule could not do. The clock is deliberately NOT here: `engine/scheduler.ts` has no imports at
  all, so it is a timer utility rather than a surface, and the sweeper it drives is logic.
  `entrypoints/http/` is the HTTP layer behind `http/index.ts`: `app.ts` (routes, auth,
  `/docs`), `routes/` (one module per resource, each paired by name with its service beside
  `src/` — `routes/monitors.ts` with `monitors.ts`), `deps.ts`, `errors.ts`, `validate.ts`,
  `openapi.ts`, `hc.types.ts` and `listen.ts`. `main.ts` and the harness ask for `createApp`,
  `Deps` and `takePort` and nothing else. **`takePort` runs first in `main.ts`, before settings,
  the database, the vendors, the sweep or the bot: the port is the lock between two backends
  (ADR 0021), so a second process stops having touched nothing, and requests that arrive while
  the service starts get a 503 in the error shape rather than a refused connection.** `main.test.ts`
  boots it against a taken port and checks the database file was never created. The WEAKEST of
  the seams `check-seams` holds, and `http/index.ts` says so:
  unlike `vendors/` and `engine/` it closes no measured failure. `ports.ts` is NOT in it —
  `bot/bot.ts`, `engine/health.ts` and `vendors/index.ts` all import it, so it is the service's
  interface vocabulary rather than the HTTP layer's), **`engine/`** (the alarm engine behind ONE DOOR, `engine/index.ts`: `sweeper.ts` (the sweep),
  `health.ts` (its account of itself — the WHOLE of `ports.ts`'s `SweeperPort`) and `scheduler.ts`
  (the sweep loop and its watchdog — NOT dead code: it is what drives the alarms). `main.ts` is the
  only thing outside that needs any of them, and `make check-seams` holds it there, so a route or a
  bot command cannot start a sweep — they get the read-only `SweeperPort` in `deps`. The door
  deliberately does NOT export `SweepHealth`: #230's mutation sweep found that a freshly
  constructed one in `main.ts` typechecked and passed all 143 route, app and boot tests while
  describing a service whose `/health` says "starting" for ever as the sweeps run. Withholding the
  class makes that unwritable rather than merely caught — `main.ts` now fails to COMPILE.
  `notify.ts` stays outside, because `positions.ts` uses it for the manage-by notice and a pass
  through that door would be the first exception),
  `watchlist.ts`, `bot/` (the long-poll
  Telegram TRANSPORT in `bot.ts` — the poll, the owner check, the reply — and the commands
  themselves in `bot/commands/`, a TABLE rather than a switch: a command is
  `(context, words) => reply text`, it never touches the Telegram API, and `index.test.ts` holds
  the table to `format.ts`'s `BOT_COMMANDS`, the "/" menu that announces it),
  **`vendors/`** (every market-data vendor, and the ONE DOOR they are reached through:
  `vendors/index.ts`'s `openVendors`, with a descriptor per vendor in `opend/`, `ibkr/` and
  `yahoo/` that builds the library's client from Settings. The
  interior is private and `make check-seams` says so — the three directories were already
  reached from three lines in one file and from nowhere else, measured, but that was a fact
  about today rather than a rule, and the cheapest way to fix a dashed row is to import the
  client that has the figure; since ADR 0021 that client is in the library, and only these
  descriptors may import it. IB Gateway is reached as a
  REFERENCE source whether or not it is the Provider, because a Reference alarms on nothing;
  `IBKR_HOST` turns it on and blank turns it off), `db/` (opening the database, the migration
  runner, the row shapes, and `queries/` — the schema and the migrations themselves are in
  `schema/`, shared ground; `queries/` is one module per TABLE, re-exported by `queries/index.ts` so every caller keeps one import path;
  `queries/sql.ts` holds what all of them were repeating, and its `insertRow` names
  `COLUMNS[table]` rather than the value's own keys on purpose: a row with a column MISSING then
  fails to bind instead of storing the database's defaults in silence),
  `vendors/index.ts` (a DESCRIPTOR per
  vendor — `vendors/opend/vendor.ts` and its two siblings. Adding a vendor is a FOLDER inside
  `vendors/` plus a line in `VENDORS`, and its client in the library's `vendors/`. `PROVIDERS` is derived from the descriptors that
  say `canBeProvider`, never listed twice; a Reference-only vendor like Yahoo prices no option,
  so naming it as the Provider is fatal at boot and it owes no `reachable`. `openVendors` opens
  each vendor ONCE and hands the Provider back among the sources under its own name, which is
  what makes ADR 0019's "one client either way" structural rather than remembered — IB Gateway
  allows one connection per client id and the second displaces the first in silence. It replaced
  three shapes merged by hand in `main.ts` and again in `routes/references.ts`),
  `references.ts` (the Reference path: one bounded
  call of its own, and the only degrade in the service that retries one code at a time — bounded by
  the number of References, which the sweep could not afford; ADR 0018), and `create-spread.ts`
  behind `POST /spreads` (#293): spreads on one expiry, each held or watched, with the Monitors
  they start with, ALL OR NOTHING — every refusal decided before ONE probe of every leg, then one
  transaction; `create-monitor.ts`'s order, and its refusals' words where the two overlap. A held
  spread's own Monitors are linked to IT, never re-inferred against the book (a shared strike made
  that ambiguous), and a UNIQUE clash inside the write is the checks' own 409, not a 500.
- `frontend/` — Vite + React + TS, the dashboard at `/opt`. `frontend/dist` is committed.
  **Two pages in one build until the swap (ADR 0023):** today's (`index.html`, `src/`) and the
  redesign at `/opt/next` (`next/index.html`, `src/next/`), built beside it slice by slice (#287
  onward). They share the hashed assets, the API and the deploy; Caddy serves `/next` as a
  directory (`try_files {path}/index.html`) so it needs no redirect. The swap (#301) deletes the old.
- `entrypoints/http/hc.types.ts` — `hc<AppType>` against a hand-written call for every endpoint (ADR 0009, phase 5),
  so a route whose shape changed is a compile error in the frontend rather than a blank cell at the
  end of a sweep. Nothing imports it; `make typecheck` is what runs it. Its COVERAGE is the whole
  value and was held by nobody — complete by diligence, with no file a seventeenth endpoint would
  have broken — so its sibling test takes the endpoint list from `/openapi.json`, which is built
  from the routes, and names any the client does not call.
- `backend/testing/` — the test harness, deliberately outside `src/` (see Testing conventions). `sweep.ts`
  holds the rows a sweep test needs, shared by `sweeper.test.ts` and `positions.test.ts`: the sampler and
  the manage-by notice are `positions.ts`'s and spent 494 lines inside the alarm engine's suite, because
  that is where the batch they read happened to be.
- `schema/` — `schema.sql`, `migrations/` and `schema-base.sql` (see **Schema change**): the one
  schema either backend builds a database from, and the migrations either applies to the live
  file (ADR 0021). Shared ground, declared beside `testdata/` in `check-boundaries`, and moved out
  of `backend/src/db/` for exactly that reason: from there the Python could have read it only by
  reaching into another package's source. Beside them, `api/`: the HTTP door's description of
  itself, which the TypeScript generates and the Python serves (see **Door scenarios**).
- `tools/guards.test.mjs` — every tree-walking guard skips the same directories. `SKIP_DIRS` is
  copied in FIVE files, each with its own `walk`, which is why `.claude` was missing from all five
  at once: `.claude/worktrees/<agent>` is a checkout of this repository on another branch, live and
  registered with git, so walking into one lints that branch against this one's rules and `make
  check` goes red on a clean main. The real fix is one shared walk; until then this holds each list
  to a floor.
- `testdata/golden/` — the golden cases; `testdata/vendors/` — the vendor field corpus (both
  generated test data, both written by `make cases`), and inside it `ibkr-gateway/`, recorded IB
  Gateway conversations (inputs) beside the batches `make cases` generates from them.
  `tools/use-backend.mjs` — `make use`'s guard, the plist renderer for either backend and the
  switch itself, behind one injectable system so its suite never runs launchctl;
  `tools/check-boundaries.mjs` — the package-boundary lint; `tools/check-test-support.mjs` — the
  one that keeps the harness out of the service; `tools/check-seams.mjs` — the same rule INSIDE a
  package, for a directory whose whole point is one door (`backend/src/vendors/`,
  `typescript/src/vendors/`, `src/engine/` and `src/entrypoints/`). Its `SEAMS` table carries
  each seam's doors, a `never` that
  says what may not become one, and the reason, printed on failure. A seam reached from ANOTHER
  package declares its `package`, so a name like `optionality/vendors/ibkr/client` is resolved
  through `exports` and caught like a path; its `insiders` must themselves be seams, so the
  library's clients cannot be handed to the whole backend by naming `backend/src`. The `never` exists because a
  sweep found that adding `ibkr/client.ts` to the door list passed every test the guard had: an
  exemption list that can be opened from the inside is not a guard. All three are tested against a
  FIXTURE TREE rather than against this repository, which is
  what a sweep of `check-boundaries` taught: three ways to gut it left every suite green.
- `python/` — the `optionality` package (ADR 0014): `src/optionality/` mirrors `typescript/src/domain/` module
  for module (snake_case the only translation), `js.py` holds the JavaScript number rules the port
  must reproduce (cased since ADR 0017, and named `js.py` not `_js.py` for that reason),
  `opend.py` needs the `opend` extra AND owns the containment loop that drops a code moomoo names as
  unknown — inside the provider, where `opend/client.ts` has it (ADR 0015, #168), not above the port;
  `quotes.py` is the port's contract plus the one fetch-and-catch that cannot be pure, and `api.py`
  loads Positions, Monitors and References from the live service (`OPTIONALITY_API` for its
  URL) — `positions()` only what is still HELD, `closed_positions()` the closed ones as
  `ClosedPosition` (ADR 0022) — but NOT quotes: `GET /quotes` takes no parameters, so it cannot price a contract the
  service does not already watch, and a notebook wanting an arbitrary code wants a Provider.
  `ibkr.py` is the third PORT: IB Gateway's field mapping (held to `testdata/vendors/ibkr-fields.json`),
  `contract_for` (a code as the contract the gateway wants, `contract.ts`) and `IbkrClient`
  (`client.ts`'s bounded ask, async, on `ib_async`; `quotes()` is the one-shot for a script, as
  `opend` and `yahoo` have). It needs the `ibkr` extra to CONNECT, not to import. `ib_async` owns
  the wire — socket, handshake, encodings, every message's layout — and the module owns what a
  field means and every decision `client.ts` makes; the two figure messages (ticks 1 and 21) are
  read field by field by its own decoder subclass, because `ib_async`'s drops an empty price
  before any callback and an empty greek with a traceback, and the TypeScript reads an empty price
  as no figure but still an ANSWER. It connects `ib_async`'s `Client`, never `IB.connectAsync`,
  which asks for the account's positions on every connect whatever its flags say and whose
  `readonly=True` refuses nothing: the Python sends exactly `messages.ts`'s messages, and
  `tests/test_ibkr_gateway.py` holds it to that as well as to every batch. One module rather than a
  subpackage, like its two siblings: the TypeScript splits `ibkr/` by layer because it owns the
  wire, which `ib_async` owns here. The stub answers `managedAccounts` because `ib_async` will not
  report a connection until the accounts list is populated — recorded in SHAPE (one
  nine-character "DU" paper account) with the identifier replaced, since the recordings are
  committed. **`no_trading.py`** is the no-trading lint's whole content (ADR 0021, Decision 8):
  every call and class in `ib_async` that places, modifies, cancels or exercises an order, the
  string reader, and `breaches_in`. In the LIBRARY because the library's client is what holds an
  `ib_async` connection and its `ibkr` extra is what installs it; ONE list, which
  `tests/test_no_trading.py` re-derives from the installed `ib_async` and refuses anywhere under
  `python/src` (no door — only `no_trading.py`'s own strings are exempt, since they are the list),
  and which `python-backend/`'s lint imports by name. `yahoo.py` is the
  second PORT beside `opend.py`, answering the same `QuoteFetcher` through yfinance — library for
  library with `yahoo/client.ts`, which uses `yahoo-finance2` because a bare fetch is refused with
  429, and both surface Yahoo's own field names so the mapping is the same mapping. Only `quotes.py`
  and `api.py` are cased by nothing: they mirror no domain module and no vendor one. `yahoo.py` IS
  cased — against `testdata/vendors/`, not `testdata/golden/`, so it is outside the `GOLDEN_CASES`
  fingerprint on purpose (`cases/vendors.ts` says why). Everything else is, decisions included.
  Counted on 2026-11-11 and moved by #297's two (`quote.sigma_distance`, `quote.strike_distances`)
  — every public function a public module of the package defines, against every `fn` in
  `testdata/golden/` — that is 64 of the package's 91, which is exactly the 64 of the TypeScript
  domain's 68 exported ones that have cases: the four `*Policy` readers take the
  service's Settings, so the package takes their knobs directly instead. The other 27, none of them
  in `testdata/golden/`:
  - seven held by their own tests and no corpus, because they mirror no domain function: `api.py`'s
    five, `quotes.verify_contracts`, and `opend.quotes`, the one-shot for a script;
  - six held to `testdata/vendors/` instead: `yahoo.to_record` and `yahoo.quotes`, and `ibkr`'s four
    field readers (`grade`, `greek_fields`, `with_mid`, `has_figures`) against `ibkr-fields.json`;
  - two held by the recorded IB Gateway conversations and their own tests: `ibkr.contract_for` and
    `ibkr.quotes`;
  - `no_trading`'s eight, a lint held by fixture sources;
  - `research/`'s three, cased by nothing by design (ADR 0020);
  - and `js.js_string`, which mirrors no TypeScript function — the TypeScript interpolates a number
    where the Python must spell the conversion out.
  **`src/optionality/research/`** is the package's other half, and the only subdirectory: chains,
  historical bars, anything the service never fetches, so it mirrors no TypeScript, no golden case
  holds it and NOTHING CHECKS WHETHER IT IS RIGHT — its own `__init__.py` says so plainly rather
  than dressing it up. `research/yahoo.py` needs the `yahoo` extra (yfinance, SHARED with the Yahoo port — one
  library, one extra; the port/research line is an import rule and not an install one), reached inside the
  function as `opend.py` reaches the SDK), separate from `opend` because the two buy different
  things and one extra would hide which a notebook asked for. The line is held structurally, not
  remembered: `test_standalone.py` refuses an import of `optionality.research` from any pure module
  AND from any port — a port is held to its TypeScript vendor by recorded fixtures, and an answer
  routed through unheld code is not held at all. The ports are DERIVED there (`IMPURE - NOT_A_PORT`)
  so `yahoo` and `ibkr` ports are picked up when they land, and that exemption list cannot be
  widened from the inside without a test failing. The other direction is free: research reads the
  maths and drives the ports, which is what it is for.
  `tests/test_cases.py` runs every golden case, and `tests/test_standalone.py` holds the promise
  three documents make and nothing checked: the maths imports and computes with NO `opend` extra
  and NO service. Two checks, because they fail differently — a static pass over the sixteen pure
  modules (it reads the AST, so a lazy import inside a function is seen too) and a subprocess that
  imports them all with `moomoo` and `ib_async` unimportable and `OPTIONALITY_API` unset. The second is the only
  one that can catch an import-time dependency no pattern lists, like zone data. Worth having
  because `moomoo` IS installed in the venv the suite runs in, so a violation was invisible here.
  Writing it also corrected a belief: `optionality.opend` imports perfectly well without the SDK —
  it reaches `moomoo` inside the function that connects, so the extra is needed to CONNECT.
  `optionality.ibkr` is held the same way, for `ib_async`.
  **Installed by a pinned git ref** (ADR 0016), never from a path that tracks the working tree —
  an editable install serves a notebook whatever half-ported state the tree is in:
  `uv add "optionality @ git+https://github.com/juchengquan/optionality.git@py-<version>#subdirectory=python"`.
  Versions are CalVer (`2026.11.1`, unpadded — PEP 440 normalises `09` to `9`), cut with
  `make py-cut` on a branch and tagged with `make py-tag` on main after the bump merges.
  `optionality.api.agrees()` asks a running service whether the port is still current; it never
  runs on import, and answers "no service" rather than raising.
- `python-backend/` — `optionality_backend` (ADR 0021): the Python backend that will be able to run
  the whole service, one backend at a time. Ported module by module, bottom up (phase 4, every
  module since 2026-11-10):
  **read its README's "Porting a module" before porting one** — the path, the docstring, which
  JavaScript behaviours go through `optionality.js`, async on one loop, names, and how the tests
  are ported. Its suite also holds the three lines `check-py-backend` runs —
  `tests/test_library_boundary.py` (no `optionality._*`, no `optionality.research`, no reach into the library's source by path), `tests/test_seams.py`
  (`check-seams`' table, `SEAMS`, for the Python: the vendors' one door and the library clients
  behind it, which only the descriptors may open; the engine's door, reached by `__main__` alone;
  and `entrypoints/`, where `http/__init__.py` and `bot/bot.py` are the doors, `__main__` the only
  caller besides two declared pieces of test support, and a new surface with no door fails. A
  door hands out what its `__all__` lists and nothing else, so with the engine's withholding
  `SweepHealth` the class is unnameable from outside, as `check-seams` and `engine/index.ts` make
  it for `main.ts` — the omission alone holds nothing where any submodule is one import away. Its
  own tests live at the mirrored path under `tests/`, and only they may reach in) and
  `tests/test_no_trading.py`
  (no order placed, modified, cancelled or exercised outside `optionality_backend/trading/`, which
  must not exist until a trading ADR creates it; the forbidden names and the reader that applies
  them are the library's `optionality.no_trading`, imported by name, whose own suite re-derives
  them from `ib_async`'s source and holds the library to the same rule with no door). All three run
  against fixture trees. `tests/engine/` runs on a VIRTUAL-TIME loop (`tests/engine/conftest.py`,
  through pytest-asyncio's loop-factory hook): the scheduler's suite keeps the TypeScript's real
  intervals and deadlines and sleeps for none of them, and an exception a timer callback raised,
  which a real loop only logs, errors the test. Never released:
  it runs from the working tree, as `backend/` does.
  **`tests/scenarios/`** is the door scenarios' Python runner (ADR 0021, phase 2), mirroring
  `backend/testing/scenarios/`: `world.py` builds a scenario's database with the backend's own
  `db/open.create_database` (from `schema/schema.sql`, STAMPED), as `world.ts` calls `createDatabase`, fills it and reads it back — the TypeScript's database cell for
  cell, storage class and stored bytes, all but the stamp's own time (measured ONCE, by hand, over
  all 120 worlds on 2026-11-09: no gate can run both languages), and round-tripped against every
  file by `test_scenario_world.py`, which IS a gate; `compare.py` is the README's "Comparing" (`1` is `1.0`,
  `True` is not `1`, key order is nothing, an extra key is a difference); `doors.py` runs the
  three doors in `doors.ts`'s four steps. **`backend.py` is THE SEAM**: `build(world)` returns the
  Python backend on a world — since phase 3 the HTTP door (`create_app` on the world's database,
  Settings read from its `.env` lines), driven through `httpx2.ASGITransport` on an
  `asyncio.Runner` the service owns, in the caller's thread. Not FastAPI's `TestClient`: it runs the
  app on a loop in a thread of its own, and the database, opened with sqlite3's same-thread check ON
  so that it holds the one-loop rule, refuses the first query there. A door not yet ported must
  RAISE, never do nothing (`sweep` and `handle_update` raise `NotPorted` until phase 4): two
  scenarios expect nothing at all, and an empty backend passes both. `backlog.py` holds the
  shrinking list: a listed scenario that passes FAILS ("take it off the backlog"), one not listed
  must pass, a listed one that no longer exists fails, and the list is written out — a test reads
  its syntax — so a new scenario joins it only in a diff. `test_scenario_runner.py` holds all of
  that against small worlds and a fake backend, because 120 skips cannot show a runner compares
  anything.
  **How it starts**: `python -m optionality_backend --env-file=.env`, which is `__main__.py`, the
  port of `main.ts`, in the order `listen.py`'s docstring gives the lock (.env, port, settings,
  database, vendors, sweep, app, bot, startup line). `entrypoints/http/listen.py` takes the port
  first, as `listen.ts` does — a socket it binds itself and hands to uvicorn, with `SO_REUSEADDR` as
  libuv sets it (without it a restart is refused for ~30s by TIME_WAIT and reads "another backend
  is running") and uvicorn's signal handling, logging and access log off. The bot is started, as
  `main.ts` starts it, only when `OPTIONALITY_BOT=1` AND Telegram has a token and a chat, and is
  stopped first; `tests/test_main.py` boots it against a fake Telegram on 127.0.0.1 (a script
  points `telegram.API` there), never the real one. Every way out is `exit_now` — the exit line,
  then `os._exit`, as `process.exit` leaves — because the interpreter's own exit joins every
  non-daemon thread, and the moomoo SDK's connect retries a dead OpenD for ever on one: a stop
  during an OpenD outage would otherwise wait for launchd's SIGKILL (`tests/test_main.py` boots it
  against TEST-NET-1 and stops it mid-retry). Its logging sends INFO to stdout and WARNING up to
  stderr, as `console` splits them, and holds every library at WARNING: httpx2 logs each request at
  INFO, and Telegram's URL carries the bot token.
  `.env` reaches it as `--env-file=.env`, read by `env.load_env_file`: Node's own reader ported
  branch for branch and held to the real `node --env-file`, because `python-dotenv` reads the same
  file differently (a `#` inside a value, `${VAR}`).

## Invariants — user-ratified in design sessions; do not "fix" without asking

- Every call for **market data** is a single bounded one: the sweep, `/quotes`, `/references`,
  `/positions/values` and the creation probes (`POST /monitors`, `/positions`, `/references` and
  `/spreads`, which probes every leg of every spread in ONE call). Widened from "every call to the Provider" by ADR
  0019, whose Provider-only wording is deprecated: a Reference may name a vendor the rest of the
  service does not use, and left Provider-specific the rule would have permitted an UNBOUNDED
  call to one — a loophole that change itself created. The payoff at expiry (`GET /positions/{id}/payoff`,
  `POST /positions/payoff`, #291) is not on that list because it asks for NO market data: legs,
  an Entry and a count, and its door scenarios run with the Provider down. `/references` makes one bounded call per
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
  dashboard's bell may therefore lead or lag what has been sent. The engine keeps NO cached view of its
  last batch: `MonitorSweeper.cachedQuotes` was the cached alternative, no route ever called it, and it was
  REMOVED for that reason — which is what dropped `watchlist.ts`, `monitors.ts`, `domain/exit.ts` and
  `domain/timefmt.ts` out of the alarm engine's imports entirely (ADR 0010, amended).
- Vocabulary: a **Position** is the stored record of something owned; a **Holding** is that record
  VALUED — what it is worth and where it stands against its exit schedule. One concept at two
  stages, which is why `holdings.ts` is the valuation of positions and keeps its name: both words
  are public, the dashboard asks `/positions/values` and the bot asks `/holdings`, and renaming
  either would be an API change for a glossary's sake (ADR 0020).
- Vocabulary: "quote(s)" = live market data, everywhere. moomoo's "snapshot" jargon stays out of the API.
- A provider is reported two ways, because they measure different things. `DEGRADED_AFTER_FAILURES`
  counts CONSECUTIVE failed sweeps — how long a failure lasted — and `FLAPPING_AFTER_FAILURES`
  counts them inside `FLAPPING_WINDOW_SECONDS` whatever happened between — how often one happens.
  The second exists because the first is blind to a provider that keeps dropping and recovering:
  on 2026-11-08 a watchdog killed OpenD 27s after every start for an hour, every success reset the
  consecutive counter, and the service said nothing while `/quotes` 502ed in the gaps. Only one of
  the two speaks per sweep — two notices about one unavailable provider is the noise that teaches
  somebody to stop reading the channel (`domain/degraded.ts`, `domain/flapping.ts`).
- Alarms: the 🔔 flips truthfully at the EXACT threshold — no value hysteresis. `ALARM_COOLDOWN_SECONDS`
  throttles state-change messages; `ALARM_REPEAT_SECONDS` re-reminds persisting breaches. `compare: abs|signed`
  (signed → negative thresholds legal, exactly 0 never).
- Retention: creation is gated by a live contract-existence probe (strict — rejects while OpenD is down).
  A rule the engine cannot evaluate → quarantine (disable + Telegram notice, NEVER delete), for either
  fault: an unknown contract, or a watched figure that has not arrived for `QUARANTINE_AFTER_SILENT_SWEEPS`
  consecutive sweeps (observed, never declared — what a provider serves depends on the account, not on its
  code; 0 only logs). Expired monitors: mute with notice, auto-delete after `EXPIRED_RETENTION_DAYS`.
  Nothing else is ever auto-deleted. One deletion is the OWNER's, triggered by saving: `POST /spreads`
  recording a spread as HELD replaces a WATCH rule (linked to no holding) on a (code, field) it makes —
  deleted and remade as the holding's in one transaction, named by the form before the save and in
  its answer after (#293). A watched spread, a switched-off default or another holding's rule never
  replaces anything. A holding that ends is CLOSED, not deleted (ADR 0022): kept with
  its samples, out of everything live (`openPositions` — the sweep, `/positions/values`, linking), its
  rules unlinked — handed first to any open holding still holding their contracts (a roll), and
  disabled as `holding-closed` only when nothing open does — so no monitor is ever linked to a closed
  holding. What it made is `realized_points` — points, not P&L, because a closed holding has no quote
  to give a contract size; its Exit is signed like Cost to close (a long's sale is NEGATIVE). A
  backdated close hides later samples from every reader and deletes none. A mistyped close is
  corrected by PATCH (`exit`, `closed_on`); DELETE is for a holding recorded by mistake, and still
  takes the samples.
- Daily samples are the day's CLOSE: written freely only from 09:30 to 16:15 New York, the options'
  close (`inSampleHours`), so the last sweep by then stays and no overnight mark replaces it — on EVERY
  calendar day, weekends included, because the vol chain steps exactly one day (ADR 0011, amended
  2026-11-10). A day with no row is FILLED whatever the hour (a trade recorded after the close, a
  session missed whole); a row observed before its day's 09:30 is PROVISIONAL — restamped in the hours
  even if unchanged, replaced after the close — and a settled row is only ever COMPLETED out of hours
  (missing IV or vega, from a sweep with both), never changed (`takesSample`). Every write stamps
  `observed_at`, so an off-close point is marked.
  Each carries per-leg IV, vega and delta, all-or-nothing per map, each gated on its own.
  And SPX's price as that sweep's batch implied it (`derivedSpx`, ADR 0024), null where it could not;
  it is never taken from a Reference, here or on `/quotes` and `/positions/values`, which carry it too.
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

- **`backend/testing/harness.ts`** (NOT under `src/`, which is the service) — its `harness` injects an
  echo quote fetcher by default, so tests must NEVER reach the real moomoo SDK (it blocks
  indefinitely on dead ports; a missing fake looks like a hung suite). Everything in it is correct
  in a test and a lie in production — a Provider that prices every code asked for, a sweeper that
  has never swept, a bearer token of `"tok"` — and it sat in `src/` beside the modules it fakes,
  loaded by `check-loads` along with them, until #221. **`make check-test-support`** (part of
  `make lint`) refuses any non-test file that imports a `testing/` directory, in any package,
  because a directory's meaning that nothing checks is a convention.
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
- **`com.optionality.api` runs ONE backend under one label** (ADR 0021, Decision 3), so exactly one
  is ever loaded: one port (each backend takes it FIRST, and it is the lock), one database, one
  `getUpdates` consumer. `make use BACKEND=ts|python` switches it: `tools/use-backend.mjs` renders
  the plist from `deploy/macos/optionality-api.launchd.plist.template` (never by hand), the
  backup is `make deploy`'s, and the switch boots the running backend out, waits for it and its
  port to be gone (so a 200 cannot come from something else holding 31415), boots the chosen one in
  and waits for `/health` — saying, if any step fails, that NOTHING is loaded and that
  `make use BACKEND=ts` puts the TypeScript back. The two renderings differ in what runs and nothing
  else: `node --env-file=.env backend/src/main.ts`, or `<repo>/.venv/bin/python -m
  optionality_backend --env-file=.env` — the uv environment's interpreter by absolute path,
  because launchd's PATH is minimal, running the working tree because uv installs the workspace
  editable, plus `PYTHONUNBUFFERED=1` because the log is the only witness of a boot that failed.
  **The guard** refuses the Python while `python-backend/tests/scenarios/backlog.py` names any
  scenario (it prints `N of M door scenarios ported` and each door still missing), while any
  TypeScript backend module has no Python port (`N of M backend modules ported`, each one named —
  measured from the TREE by `check-module-map.mjs`'s `unported`), while
  `python-backend/src/optionality_backend/__main__.py` does not exist, or while `.venv/bin/python`
  is not installed. The modules as well as the scenarios, because the scenarios hold what the two
  backends DO and reach only what a door reaches: `openapi.ts` was the last module ported, and until
  its scenarios came with it `/docs` and `/openapi.json` were nobody's door.
  Every road to a Python plist goes through it — `make use`, `make launchd-api-install
  BACKEND=python` and `make deploy`'s restart — and there is no override. Since 2026-11-10 it
  refuses nothing — every scenario passes (143 of 143) and every module is ported — and it stays,
  because a TypeScript change that lands without its Python is a tree it must refuse.
  **A drill** — the
  Python live for a while, by hand, then back — is run when the owner asks and never on a
  schedule: only a drill shows launchd, the real vendors and the switch itself working, and it
  waits for the guard. `DRY_RUN=1 node tools/use-backend.mjs switch <backend>` prints the switch
  without doing any of it.
- **OpenD's config is outside the repo and an OpenD upgrade resets it.** The service reaches OpenD
  only over its websocket (`MOOMOO_WS_PORT`, 33333), authenticated by `MOOMOO_WS_KEY` — a secret
  we make up, held in `.env` in clear and in `~/_workspace/OpenD/OpenD.xml` as its MD5
  (`.env.example` shows the lines). OpenD's console `update` rewrites `OpenD.xml` with the stock
  file, which comments out the websocket and the telnet console: on 2026-11-11 the sweep then failed
  for an hour with "OpenD login timed out" while OpenD said "Login successful". After any OpenD
  upgrade, check that something listens on 33333.
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
