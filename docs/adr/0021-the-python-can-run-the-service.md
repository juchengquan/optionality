# 21. The Python can run the service, one backend at a time

Date: 2026-11-09

## Status

Accepted, not built. Decided with the owner on 2026-11-09 in a design session of seventeen
questions, each answered in turn. Built in six phases (Decision 9); each phase updates CLAUDE.md
when it lands, so CLAUDE.md describes what exists rather than what is planned.

Reverses the part of **ADR 0014** that rejected "both backends behind one frontend", and the
sentence of **ADR 0017** that "a second service is still refused". Scopes **ADR 0019**'s "there is
no order message and none is importable" to the TypeScript: the Python backend replaces it with
three locks (Decision 8). **ADR 0015**'s "out of scope, explicitly: placing orders" stands until a
trading ADR replaces it. ADR 0016 is untouched: it releases `python/`, and the new backend is not
released.

## Context

ADR 0014 brought the Python back as a library: the domain's maths for the owner's notebooks, held
to the TypeScript by golden cases. ADR 0017 widened the cases to the decisions and looked again at
a second service, and refused it. The owner has reconsidered: the Python should be able to run the
whole service, the sweep and its alarms, the database, the API the dashboard calls and the bot,
so that either backend can be the live one.

**Where the two stand, measured on 2026-11-09.** Non-test TypeScript source under `backend/src`,
by what the Python has for it:

| lines | TypeScript | Python today |
| ---: | --- | --- |
| 2,485 | `domain/` (1,712), the OpenD client (517), the Yahoo client (171), `quotes.ts` and the field doors (85) | ported; the domain held by golden cases, 52 of 56 functions cased |
| 1,307 | the IB Gateway client | the field mapping only, held by `testdata/vendors/` |
| 5,618 | `db/` 879, `engine/` 892, `entrypoints/http` 1,382, `entrypoints/bot` 807, the service calculations 851, the vendor door 284, `main`, `env`, `notify`, `telegram`, `ports` 523 | nothing |
| 1,042 | `cases/`, the case generator | stays TypeScript, which writes the cases |

The 5,618 lines to port carry 7,471 lines of tests, not counting the vendor door's. ADR 0017
estimated about 5,000; the measurement agrees.

**Each reason the earlier ADRs gave, and where it stands.**

| reason | from | now |
| --- | --- | --- |
| the schemas diverge | 0014 | expired, as ADR 0017 recorded: the old database was archived and a port reads the same `schema.sql` and migrations |
| one bot token allows one `getUpdates` consumer | 0014, 0017 | holds. Answered by running one backend at a time, enforced by the port (Decision 3) |
| one live database tolerates no second writer | 0014, 0017 | holds. Same answer, and the port is taken before the database is touched |
| switching is the rollback measured on 2026-10-15 as a trap | 0014, 0017 | holds for what it measured, which was a SECOND DATABASE: a frozen copy with an older schema, where switching lost a holding, brought back four closed ones, and dropped all seven alarm rules, every exit schedule and the vol history. Answered by one shared file and one set of migrations, so a standby never has a database of its own to fall back to (Decision 3) |
| a contract describes shapes, and this project's bugs are about behaviour (#129, #120, #116) | 0014 | holds. Answered by checking behaviour at the doors rather than sharing an OpenAPI contract (Decision 4) |
| the dashboard takes its types from the TypeScript through `hc<AppType>`, so a Python service brings runtime skew back | 0017 | holds. Answered by running the HTTP scenarios against both servers in `make check`, so skew fails a gate rather than a page |
| the cost: about tenfold growth of the package | 0017 | measured above and accepted. Lockstep (Decision 4) spends it per change rather than all at once |

Two facts found while deciding shaped Decision 3:

- **Nothing stops two backends running at once today.** `main.ts` applies migrations, opens the
  vendors (connecting to IB Gateway on the one client id the gateway allows, which silently
  displaces any other holder), and only then binds port 31415. The bind fails asynchronously, so a
  second process has also launched a sweep (it sweeps at once on start) and begun starting the bot
  before the error lands; how much of either completes before it dies is a race. Only launchd
  loading a single agent prevents it.
- **The migrations are already language-neutral**: plain `.sql` files applied in name order and
  recorded in `schema_migrations`. A second runner can apply the same files.

## Decision

**1. Scope and role.** The Python gains a backend that can run the whole service, not only a
library. The two are interchangeable: either can be the live one. The TypeScript is live by
default and the Python is the standby.

**2. Who writes.** For now the TypeScript writes: a change lands there first, the expectations are
regenerated, and the Python is red until it is ported, as the domain already works. In the long
run a shared spec writes, with hand-written expectations both implementations must meet. The
trigger for that switch is not named. Every new kind of case is therefore plain JSON a person can
read and could later write by hand, generated by the TypeScript until then.

**3. One backend at a time.**

- **The port is the lock, taken first.** Each backend binds `127.0.0.1:31415` before it applies a
  migration, opens a vendor, arms the sweep or polls Telegram, and exits having touched nothing if
  the port is taken. Routes are served only once the backend is ready. The TypeScript changes
  first; that change closes today's double-start window whether or not anything else follows.
- **One database file**, one schema, the same `.sql` migrations, recorded in the same
  `schema_migrations` table by whichever backend starts first after a change.
- **One launchd agent**, `com.optionality.api`, running whichever backend is chosen. A make target,
  `make use BACKEND=python|ts`, backs the database up as `make deploy` does, stops one backend,
  starts the other and waits for `/health`.
- **A drill, run by hand when the owner asks and never on a schedule**, proves what the gates
  cannot: launchd, the real vendors, a real session's timing and the switch itself.

**4. How parity is held.**

- **Ported module for module**, `snake_case` the only translation, as the domain was. A test holds a
  mapping table from every TypeScript backend module to its Python counterpart and fails on a
  module with no row.
- **Checked at the three doors**, the entry points ADR 0020 separates, with scenarios under
  `testdata/scenarios/`:
  - **HTTP**: a starting database and recorded quotes, a request, and the exact JSON response.
  - **Bot**: the same world, a command, and the exact reply text.
  - **Sweep**: the same world and a clock, one tick, and the rows it wrote and the messages it sent.
- The golden cases and the vendor corpus continue as they are, underneath.
- **Lockstep.** A TypeScript change that alters a scenario turns `make check` red until the Python
  passes too, so the same pull request carries both. During the first port, a door's unported
  scenarios sit on one list that may only shrink and is empty when the port is done.

**5. Layout.** The TypeScript is split the way the Python already is, so each Python package mirrors
exactly one TypeScript package:

| | TypeScript | Python |
| --- | --- | --- |
| library | `typescript/`, package `optionality` | `python/`, package `optionality` |
| backend | `backend/` | `python-backend/`, package `optionality_backend` |

- **The line**: the library is everything callable with no service running; the backend is
  everything that needs Settings, the database, the sweep loop or a way to deliver. So
  `domain/`, `quotes.ts`, the OpenD, IBKR and Yahoo clients with their field mappings, the fake
  IB Gateway, `cases/` and the golden stamp move to `typescript/`. `main`, `env`, `db/`,
  `engine/`, `entrypoints/`, the service calculations, `notify`, `telegram`, and the vendor door
  with its descriptors (they read Settings) stay in `backend/`. `check-boundaries` then holds the
  library away from the service, as `test_standalone.py` does for the Python.
- **One naming exception.** Workspace package names are their directory names, except the
  TypeScript library: `typescript` is the compiler's own npm package, so the directory is
  `typescript/` and the package is `optionality`, which is also the Python library's name.
- **`python-backend/`** is a uv workspace member beside `python/`, runs from the working tree as
  the TypeScript does, and imports only `optionality`'s public modules, which a lint holds.

**6. Stack.** One `asyncio` loop runs the routes, the sweep and the bot, matching Node's single
thread, so the Python has no interleavings the TypeScript does not. FastAPI on uvicorn, built on
the `pydantic` the library already uses. `sqlite3` from the standard library, blocking, as
`node:sqlite` is. `httpx2`, Pydantic's maintained continuation of `httpx`, for Telegram. The
scheduler, the bot transport and the vendor door are ported rather than replaced by frameworks,
because their behaviour is what the scenarios check. The moomoo SDK blocks, so it runs in a worker
thread with a timeout, keeping every market-data call bounded.

**7. IB Gateway from the Python.** The Python client uses `ib_async`, the maintained library that
speaks protocol 178, rather than a port of the hand-written TypeScript client, because trading
should remain possible later. The two clients are held by **the same recording in, the same quote
batch out**: conversations recorded from the real gateway live under `testdata/`, the TypeScript
client generates the expected batch for each, and a Python stub replays the same bytes to
`ib_async`. The first recordings are a normal answer with greeks, an unknown contract, a link down
behind an open socket (`2110`), an unentitled account, a feed held by another session (both
silent), and a contract that never answers.

**8. Trading.** It stays out of scope, as ADR 0015 says, and must be possible to add later without
being possible by accident. Until an ADR designs it, three locks:

- **IB Gateway's Read-Only API switch**, which refuses every order request with `321`. Confirmed on
  2026-11-09 by asking the gateway to cancel an order nobody placed. It lives in a settings folder
  the gateway can replace, so it is rechecked after restarts and in every drill.
- **A lint over `python-backend/`** refusing any call that places, modifies, cancels or exercises an
  order (`placeOrder`, `cancelOrder`, `reqGlobalCancel`, `exerciseOptions` and their kin) outside a
  `trading/` module that does not exist until an ADR creates it. Built like `check-seams`, with a
  `never` the module cannot widen from inside and tests against a fixture tree, so loosening it
  fails a test.
- **The TypeScript client keeps no order message.** `ib_async`'s `readonly=True` is used as well,
  but it is one flag, so it is not counted as a lock.

The trading ADR must also say which side writes trading first. Under Decision 2 that is the
TypeScript, whose client would need order messages before the Python could trade.

**9. Order of work.** Each phase is one or a few pull requests, merged by the owner:

| phase | work |
| --- | --- |
| 0 | this ADR |
| 1 | TypeScript groundwork, no Python yet: (a) the port lock, first and alone; (b) the `typescript/` split with the boundary and seam lints updated; (c) the door scenarios, generated, checked for staleness, with a coverage guard per door; (d) the fake gateway's replies moved into a shared recording |
| 2 | the Python skeleton: the uv workspace, the import-boundary lint, the mapping test, the no-trading lint and its fixture tree, the scenario runner, the shrinking list |
| 3 | a tracer bullet: `GET /positions` served by the Python end to end and passing its scenarios |
| 4 | the port, bottom up: settings, the database and its migration runner, row loading, notify and Telegram, the service calculations, the vendor door and the `ib_async` client, the engine with the sweep, the remaining HTTP routes, the bot, `main` |
| 5 | operations: `make use`, `make deploy` installing both and restarting the chosen one, the launchd template, `~/recovery.sh`, every suite in `make check`, and the first drill |

## Rejected

- **Library parity only**, everything computable without the service but nothing that runs. It
  answers every question a notebook asks and none of what the owner wants: a backend that can take
  over.
- **The Python as successor**, retiring the TypeScript. Rewrites a working service to arrive where
  it already is.
- **Interchangeable with no reference**, every fix written twice with nothing forcing agreement.
  Decision 2's long-run shared spec is that reference, written down instead of absent.
- **An offline runner** of the sweep over recorded data. Research, not a backend.
- **A live shadow** making the same decisions alongside the live backend. It fights the port lock,
  doubles every market-data call, and needs a mode that exists only for itself.
- **Replaying recorded sweeps nightly.** The journal would also have to capture every edit made
  through the API, or the replay starts from the wrong state.
- **Gates alone.** The first real switch would be the first time the Python ever ran live.
- **A database file each.** The daily samples fork, and the samples are the one thing that cannot
  be re-entered.
- **A lock file, or a lock row in the database.** Node has no `flock` without a native module, a
  crash leaves a stale lock, and the database is the thing being protected.
- **Checking every module, or HTTP alone.** Per-module cases drag a database, a clock and vendors
  into every case, thousands of them; HTTP alone misses alarms, cooldowns, quarantine and the bot,
  which is where this project's bugs have been.
- **Lag with recorded debt, or porting in batches.** The standby is behind on exactly the day it is
  needed.
- **The backend inside the library**, behind an extra. Notebooks and launchd need different release
  rules, pinned tags against the working tree, and the library's promise to import with no service
  would have a service inside it.
- **Other TypeScript layouts**: matching names only (looks symmetrical, guarantees nothing); a
  language-first tree (moves every path, the agent and the deploy); no change with a mapping table
  (works, but leaves the TypeScript library free to import the service).
- **`core/` as the library's name.** Says nothing, and differs from the Python's.
- **Porting the TypeScript IBKR client to Python.** Keeps "no order message", which the owner does
  not want to rule out.
- **Moving the TypeScript to a third-party client too**, or **holding the IBKR clients by field
  mapping alone.** The first loses the TypeScript's lock as well; the second lets a silent gateway
  become "every contract unknown" in one language, which quarantines rules.
- **Flask or Django, and `python-telegram-bot`.** Threads or their own update handling, both
  behaviours the scenarios would have to reconcile.

## Consequences

- **Every service change is written twice**, in the same pull request. That is the price of
  "interchangeable", paid per change while it is fresh rather than during an outage.
- **The read-only property splits by language.** The TypeScript cannot trade because no order
  message exists. The Python cannot trade because of three locks, one of which is configuration.
  CLAUDE.md's wording changes when `python-backend/` lands.
- **`make check` grows by the Python backend's suite** and the scenario corpus, and stays the one
  gate.
- **Readiness is shown only by drills.** The gates show the Python behaves like the TypeScript; only
  a drill shows it can run. Drills happen when the owner asks.
- **Left open, on purpose**: which side writes trading first; when the shared spec takes over;
  whether `/openapi.json` and `/docs` must match, since the scenarios hold response bodies and
  nothing yet holds the generated description; a neutral name for `data/optionality-ts.db`; and
  saving real alarms and quarantines as candidate scenarios.
