# Rebuilding the backend in TypeScript

Ten phases. Reasoning in [ADR 0009](../../adr/0009-the-backend-moves-to-typescript.md).

Ordered so the riskiest unknown is settled first and the irreversible step is last. Phases 1-8
change nothing that is running: the Python service keeps serving the dashboard throughout.

## What was established before planning

- **~3,500 lines of backend, ~3,300 of tests.** The whole of `src/optionality/` plus `tests/`.
- **moomoo's SDK is four calls** — connect, option chain, market snapshot, close — and
  `moomoo-api` on npm carries both protocol commands at the same version as the Python package.
- **OpenD's WebSocket port is off.** 22222 is the telnet console; 33333 is not listening; the
  settings are commented out in `OpenD.xml`. The Node SDK speaks only WebSocket.
- **Quotes are never persisted**, so the API and the alarm engine cannot be separated and no
  side-by-side run is possible. This is a cutover.
- **24 rows of live data**: 7 monitors, 4 positions, 8 links, 1 config, 2 runs, 2 reports.
- **Node 25 runs TypeScript with no build step**, and ships `node:sqlite`.
- **No route declares a response model**, so six frontend interfaces are hand-maintained.

---

## Phase 0 — Prove Node can talk to OpenD

On a weekend, market shut. Uncomment `websocket_port` and set `websocket_key` in `OpenD.xml`,
restart OpenD, and confirm the Python service reconnects on 11111 as before.

Then the only test that matters here: a throwaway Node script fetches a snapshot for the live
watchlist over WebSocket while the Python service fetches the same over TCP, and the two are
compared **field by field** — bid, ask, mid, every greek, implied volatility, update time.

**Done when** the two transports return identical figures for every contract, or the differences
are understood and written down. If they are not identical, stop: everything after this assumes
the quote source is equivalent.

## Phase 1 — Workspaces and scaffolding

Root `package.json` with `["backend", "frontend"]`, a shared tsconfig base, Vitest configured
once. `backend/` holds an app that serves nothing. Makefile targets gain backend siblings.

Nothing runs in production. **Done when** `npm test` runs both workspaces and `node
backend/src/main.ts` starts and exits cleanly.

## Phase 2 — Port the tests, before the code

The 3,278 lines of Python tests become Vitest tests against stubs that throw. They will all
fail, and that is the point: they are the contract the port must satisfy, written before there
is an implementation to shape them.

Port them as **behaviour**, not as structure. Where a Python test asserts an invariant from
CLAUDE.md — IV never summed, the bell flipping at the exact threshold, cost-to-close signs being
the inverse of exposure — carry the invariant and its comment, not the call sequence.

**Done when** every Python test has a TypeScript counterpart, all failing, and the count matches.

## Phase 3 — The domain, which is pure

`position.py` and the computational half of `monitor.py`: cost to close, position greeks, P&L,
combined figures, `threshold_fill`, the alarm decision. No I/O, no database, no scheduler.

This is where the money bugs live, and it is the part the tests cover best. **Done when** every
ported test of the domain passes and none of the implementation has touched a database.

**Done, with a correction to the premise.** "The part the tests cover best" was true of
`position.py` and wrong about `monitor.py`: `threshold_fill` has one assertion in the whole Python
suite and `positions_holding` has none, so porting test-by-test skipped a function entirely and
left the alarm maths unguarded. Passing tests turned out not to be evidence of a faithful port —
four real divergences survived a green suite. `backend/tools/differential` is what caught them and
is now part of the method for the phases that follow. See ADR 0009.

## Phase 4 — The database

Drizzle schema declared in TypeScript, then a throwaway script that reads the 24 rows out of
`data/optionality.db` and writes them into a new file, asserting every row and every field
matches afterwards.

24 rows is small enough to verify **completely** rather than by sampling — a luxury that will
not exist again.

**Done when** the new database holds the same data, verified field by field, and the Python
database has not been written to.

**Done, and Drizzle is not in it.** Stable Drizzle cannot drive `node:sqlite`, and the release
candidate that can has a transaction method that commits before the callback runs. `node:sqlite`
directly, no ORM — so the backend has no runtime dependencies at all. The stored formats stay
SQLAlchemy's, which keeps the Python usable as a rollback; that is verified, not assumed. See
ADR 0009's two corrections.

## Phase 5 — The HTTP layer

The 18 routes in Hono with Zod schemas, including response schemas — which the Python service
never had, and which is what makes `hc` work. Auth middleware, the same bearer token.

**Done when** every route's ported test passes, and `hc<AppType>` type-checks against a
hand-written call for each endpoint.

**In three PRs, not one.** There are 29 handlers rather than 18 — this plan undercounted — across
1,070 lines of routes and 65 Python tests. One PR would be ~2,500 lines of new TypeScript, which is
not reviewable.

1. the app, the token, the error shape, `/health`, `/configs`, `/schedules`, `/runs` — done (#78)
2. `/monitors` and `/quotes`, with the quote-fetching layer and the watchlist builder — done (#79)
3. `/positions`, `/spx`, and the `hc` proof completed over every endpoint — done

**Done. 29 routes against the Python's 29**, and `hc<AppType>` type-checked against a hand-written
call for every one of them. A route added without a line in `hc.types.ts` is a route nothing has
type-checked, which is the only way the guarantee quietly stops being true.

**Carried deliberately, not forgotten:**

- **`/docs` does not come across.** FastAPI generates it; Hono serves no such page, so
  `test_root_path_prefixes_openapi_url_for_reverse_proxy` has nothing to assert and `ROOT_PATH`
  now has no reader at all. `@hono/zod-openapi` could generate a spec from the schemas already
  written here, but it changes how the app is constructed and therefore how `hc` is typed, so it is
  a decision for phase 8 rather than a detail of this one.
- **`display_time_short` waits for phase 7.** Only the Telegram bot uses it, and it formats a zone
  with Python's `tzname()` — "+08" for Singapore where JavaScript gives "GMT+8". That needs
  deciding, not guessing.
- **The scheduler half of the schedules tests waits for phase 6.** The Python asserts against a
  live APScheduler; what phase 5 can assert is that every write asks for a reload.

## Phase 6 — The sweeper, the worker, the schedule

The sweep, `fetch_resilient`, `verify_contracts`, quarantine, the expiry lifecycle. croner for
the schedule, with `America/New_York` preserved.

**The worker invariant needs re-expressing rather than copying.** "One worker thread owns run
execution" exists because Python threads and SQLite need it to. Node is single-threaded, so the
same guarantee — one run at a time, in order — is a promise queue rather than a thread. Same
promise, different mechanism, and the comment should say so.

**Done when** the sweep's ported tests pass and a manual sweep against live OpenD produces the
same figures the Python service shows at the same moment.

**In three PRs.** Nothing from phase 0 was committed — it was a feasibility spike — so the OpenD
client does not exist yet, and the live comparison cannot happen without it.

1. the sweeper and the schedule, against fakes — done (#82)
2. the moomoo WebSocket client, and the live comparison this phase is done when — done
3. the worker, the Python bridge, and the lifespan that starts all of it — done

**Done.** The service starts, sweeps, serves, and stops on SIGTERM, and both endpoints agree with the
Python service asked within the same second:

```
make diff-services
  /quotes            0 divergences over 62 compared values across 4 rows
  /positions/values  0 divergences over 40 compared values across 4 rows
```

The boundary with Python is `optionality/runner.py`, called as a subprocess with files rather than
pipes — the moomoo SDK writes its own lines to stdout and a JSON document sharing a pipe with them is
one that sometimes does not parse. Two modes: `run` (the scan, and the report notification, which
needs the same config object and the same senders) and `alert` (the failure email, which is SMTP with
an app password).

**`run_task` stays in Python, invoked as a subprocess.** It is the strategy/holdings scan that
produces the HTML report, and porting it means replacing pandas, the option-chain scan and yfinance:
~614 lines across four pandas modules. It has run twice, both on 2026-08-10, with no schedule
configured — while the sweep runs every sixty seconds. So the worker spawns it and stores what comes
back: no divergence risk in the one output the owner reads as money, and everything used daily
becomes TypeScript as intended. The owner's decision, knowingly taken; phase 10 narrows from "delete
Python" to "delete the Python that was ported", and it can be ported later if it starts being used.

**One thing found rather than ported.** The expiry path deletes a monitor without clearing its
`monitor_positions` links, which raises `FOREIGN KEY constraint failed` inside the sweep — every
minute, so the alarm engine stops altogether. Every monitor in the live database is linked; it would
have stalled on 2026-11-07. Fixed in the Python separately (#81) rather than carried across, because
a port cannot reproduce a crash and the live service should not be left waiting for the cutover.

## Phase 7 — The Telegram bot

Long-poll, the command set, the table formatting rules — ~40 monospace characters, four columns
maximum, `<pre>` with HTML parse mode only for tables.

**It cannot be tested against the real token while Python is running**, because the token allows
one `getUpdates` consumer. Tests drive the handler directly with a fake API, exactly as the
Python tests do. The real thing is first exercised at cutover.

**Done when** every bot test passes and the formatting is asserted character-for-character.

**Done.** All thirteen commands, and `format.test.ts` asserts whole strings rather than substrings —
which was not optional. A mutation sweep against the bot's own tests passed with the column padding
removed, with one space between columns instead of two, with the HTML escaping applied in the wrong
order, and with a delta printed to four places. None of those changes whether a substring appears, and
every one is a table that reads wrongly on a phone.

**The bot does not start unless `OPTIONALITY_BOT=1`.** The token allows one getUpdates consumer and the
Python service is holding it; two consumers means each sees a random half of the owner's commands. The
flag is how phase 9 hands it over deliberately rather than by whichever process started first.

**Two formatting facts had to be implemented rather than inherited.** Python's `str()` of a float keeps
the point on an integral value — `100.0`, not `100` — and goes exponential below 1e-4 and at 1e16 where
JavaScript waits until 1e21. Both reach the owner's screen: prices arrive from moomoo as whole numbers,
and a gamma threshold is the sort of figure typed as 0.00001.

**`display_time_short` cannot be made exact, and that is recorded.** Python names a zone with tzdata's
abbreviation; JavaScript uses ICU's, and ICU has fewer. They agree on the owner's Asia/Singapore (+08),
on America/New_York (EDT), on UTC, and on every zone whose abbreviation is itself an offset. They
differ for Asia/Kolkata (IST), Asia/Shanghai, Europe/Paris, a British summer and Newfoundland.
`compare.py` allows exactly that one claim — the date and time must match, Python's side must be
alphabetic and ours an offset — so a wrong time, a wrong offset or a wrong name all still fail.

## Phase 8 — The frontend takes its types from the backend

`frontend/src/api.ts` loses its six interfaces and imports `hc<AppType>`. `contract.json`, the
`/health` contract version and the skew banner all retire — the compiler has replaced them.

This is the phase that delivers the stated reason for the whole exercise. **Done when** the six
interfaces are gone, the frontend's 70 tests pass against the typed client, and changing a
response shape in the backend breaks the frontend's typecheck.

## Phase 9 — Cutover

Stop `com.optionality.service`, start the Node agent on the same port and the same tailscale
path. Nothing else moves.

Then the one test that cannot be automated: **set a threshold that will fire within the hour and
confirm the Telegram message arrives.** Everything else is provable from tests; this crosses into
a phone through a token the agent should not be exercising on the owner's behalf.

**Rollback is one step** while the window lasts: stop Node, start Python. Its database has not
been touched. Anything entered in between lives only in the new database and is retypable.

## Phase 10 — A month later

Delete `src/optionality/`, `tests/`, `alembic/`, `pyproject.toml`, `uv.lock`. Strip the Python
half of the Makefile and CLAUDE.md. A month is about how long it takes to meet a weekly edge
case: a Friday expiry, a quarantined contract, a gap open.

---

## Checklist

- [ ] Phase 0 — OpenD WebSocket proven against TCP, field by field
- [ ] Phase 1 — workspaces, shared tsconfig, one test command
- [ ] Phase 2 — 3,278 lines of tests ported and failing
- [x] Phase 3 — the pure domain, all its tests green, and verified against the Python
- [x] Phase 4 — the schema and the 24 rows, verified completely (no Drizzle — see the phase)
- [x] Phase 5 — 29 routes in Hono with response schemas, hc proved over every one
- [ ] Phase 6 — sweeper, promise-queue worker, timezone-correct schedule
- [ ] Phase 7 — Telegram bot, tested against a fake
- [ ] Phase 8 — frontend on `hc`; contract version retired
- [ ] Phase 9 — cutover, and a real alarm to a real phone
- [ ] Phase 10 — Python deleted
