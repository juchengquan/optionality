---
status: accepted
---

# The backend moves to TypeScript

The service works. It has run unattended for months, it has 3,278 lines of tests, and nothing
about it is failing. It is being rewritten anyway, on the owner's call, because they would
rather maintain one language than two and would rather write TypeScript than Python. That is a
legitimate thing to want from a tool you maintain alone, and this ADR exists because a future
reader will otherwise assume there was a technical forcing function. There was not.

## The cheaper answer was declined knowingly

The stated goal was sharing structures between backend and frontend. Concretely that is **six
hand-written interfaces** in `frontend/src/api.ts` — `PositionRef`, `Snapshot`, `Leg`, `Entry`,
`Monitor`, `Health` — maintained against Python dictionaries with nothing checking they agree.
No route declares a `response_model`, so the OpenAPI schema describes the 13 input shapes and
not one response. `contract.json` and the skew banner exist precisely because nothing checks.

That could have been fixed for a fraction of the cost: declare response models, generate
TypeScript from the schema. It was put to the owner and declined. The rewrite is wanted for
itself as well as for the types.

## Feasibility, established before committing

The one dependency that could have blocked this is moomoo's SDK, and the service uses a
remarkably small part of it: connect, `get_option_chain`, `get_market_snapshot`, close.

- `moomoo-api` exists on npm at the same version as the Python package, carrying both protocol
  commands (`Qot_GetSecuritySnapshot` 3203, `Qot_GetOptionChain` 3209).
- **It speaks only WebSocket.** OpenD's WebSocket port is a config option and is currently
  commented out — port 22222 is the telnet console, and 33333 is not listening. Enabling it
  means editing `OpenD.xml`, setting an auth key, and restarting the gateway to the owner's
  brokerage account.
- Everything else has a mainstream equivalent. Pandas is only converting frames to dicts and
  formatting one date; nothing statistical.

A Python sidecar owning the OpenD connection was considered and rejected: it would leave a
Python process running for ever, which defeats the point.

## The constraint that shapes everything: no side-by-side run

**Quotes are never persisted.** There is no quotes table; `last_records` lives in memory on the
sweeper so that a row's value and its bell come from the same instant. A second service with no
sweeper has no figures to serve, so the API and the alarm engine cannot be separated.

Combined with the ratified invariants — one `getUpdates` consumer, one worker owning runs, one
batched quote call per sweep — there is no safe overlap period. Two services would double-alarm
and double-write.

So this is a cutover, and verification has to happen before it rather than during it. The
proposal was a week of recording the running service's decisions and replaying them. The owner
declined, on the grounds that a missing monitor can be re-added. **That reasoning does not cover
the risk**, which is a monitor that is present, looks right, and quietly never fires — a sign
flipped, `signed` compared as `abs`. It is recorded here as the owner's decision, knowingly
taken. The mitigation instead is to port the 3,278 lines of tests FIRST and let them be the
contract; many encode the stated invariants directly rather than the implementation.

### Ported tests turned out not to be enough on their own

Phase 3 showed the limit of that mitigation. Every ported test passed, and the port was still
wrong in four ways — because **a ported test can only check what the Python thought to check.**
`positions_holding` has no Python test, so porting test-by-test skipped the function entirely and
the suite stayed green. The faithfulness bugs were worse than that: CPython's `sum()` has carried
a compensation term since 3.12, so a plain `reduce` gives a different combined delta; `round()`
rounds the stored double rather than the decimal, so `Math.round(v * 100) / 100` disagrees on
twelve values in four hundred; and `build_spx_code` accepted one date spelling where Python takes
two and would have built a code for the 30th of February.

None of those are the kind of mistake a test written from the invariants would catch, because none
of them is about the invariants. They are about one language's arithmetic quietly differing from
another's. So the mitigation gained a second half: `backend/tools/differential` puts the same
inputs through both implementations and compares them **exactly** — bit-for-bit, because both
sides do the same arithmetic in the same order on the same doubles. It runs over generated inputs
and over the owner's real positions against one live quote set.

It is a porting tool, not a suite: the Python goes away in phase 10, so whatever it finds has to be
written into a committed TypeScript test before the branch merges. And it is itself verified by
breaking what it guards — ten mutations, ten caught, on the harness and on the committed tests
alike. That discipline is here because this project has already shipped three assertions that
could never fail (ADR 0008).

## What was chosen

- **Faithful port, not a redesign.** Every ratified invariant stays. Two hard changes at once
  means not knowing which one broke something.
- **Hono with Zod**, because `hc<AppType>` gives the frontend the server's own types with no
  generation step — the only option that pays back the stated reason. Fastify was the serious
  alternative: more mature, better logging, and a Zod type provider — but its type sharing
  needs an OpenAPI generation step, which is where the project already is.
- **Node 25**, which runs TypeScript directly with no build step and no flags, and ships
  `node:sqlite` so SQLite needs no native compilation. Bun is installed and faster, but is a
  second runtime to maintain and the moomoo SDK is untested on it.
- **Drizzle**, **croner** (timezone verified: NY 09:30 resolves correctly), **Vitest**, **npm
  workspaces**.
- **A fresh database with the 24 live rows copied in by script.** Nine Alembic migrations built
  the current schema; matching it exactly from TypeScript is a silent risk, and 24 rows is small
  enough to verify completely — every row, every field.

## Correction: Drizzle was chosen on a premise that does not hold

This ADR chose Drizzle alongside Node 25's built-in `node:sqlite`. **Those two do not go
together.** Stable Drizzle (0.45.3) ships no `node:sqlite` driver at all — only `better-sqlite3`,
`bun-sqlite`, `libsql` and a generic proxy. The pairing exists in `1.0.0-rc.5`, and in that release
candidate the driver's `transaction()` is written synchronously around async query builders:

```js
const result = transaction(tx);   // the callback is async; this is a promise
this.run(sql`commit`);            // committed before the body has done anything
return result;                    // the rejection is never seen, so nothing rolls back
```

Verified directly: a throwing transaction leaves its row behind, and so does an explicit
`tx.rollback()`. `node:sqlite`'s own `begin`/`rollback` is correct, so this is Drizzle's.

`better-sqlite3` was the remaining stable route and has its own cost: no prebuilt binary for Node
25 (ABI 141 is a 404), so it compiles from source on install and must be rebuilt after every Node
upgrade. That puts a build step on the deploy path, which is the thing committing the frontend
bundle was meant to avoid (ADR 0005, ADR 0006).

**So: `node:sqlite` directly, no ORM.** Hono has no dependencies and neither does this, which
leaves the backend with nothing to recompile when Node moves. The cost is real — hand-written SQL,
no generated migrations, and no schema declared once that both the database and the types derive
from. The last of those is the only one worth mitigating, and `db/rows.ts` does it: `schema.sql` is
the database's truth, `COLUMNS`/`NULLABLE` the runtime's, and the row interfaces the compiler's,
with the compiler tying the second to the third and `rows.test.ts` tying the first to the second.
Nine kinds of drift between them were introduced on purpose; eight failed a test and one failed
the typecheck.

It also removes the argument for the ORM that was never strong here: the Python uses SQLAlchemy as
a query builder (`session.scalars(select(...))`), not as an object graph, and `monitor_positions`
is deliberately a plain table.

## Correction: the stored formats stay SQLAlchemy's

Datetimes stay as naive-UTC text with six fractional digits (`2026-09-01 15:39:11.940183`),
booleans stay as 0 and 1, and the copy carries JSON across byte for byte including Python's
spacing. Epoch-millisecond integers and native booleans would be pleasanter to work with.

The reason not to is the cutover. There is no side-by-side run and no recording week, so if the
TypeScript service misbehaves the only rollback is to point the Python at the new file and start
it. That only works if the formats match, and it is verified rather than asserted:
`python_can_read.py` opens the copy with SQLAlchemy, compares all 194 mapped field values
including their Python types, and checks `alembic current` reports the head rather than an empty
table. The schema therefore also carries `alembic_version`, stamped from the source.

New rows written by TypeScript will differ from copied ones in one visible way: `JSON.stringify`
writes `[{"sign":-1,...,"strike":8050}]` where Python writes `[{"sign": -1, ..., "strike": 8050.0}]`.
The values are identical and both sides parse the other's text. Matching Python's formatting would
mean writing a JSON serialiser to imitate another language's repr, and nothing reads those bytes
except a JSON parser.

## A note on the typed client, which is the whole point

`hc` types a request from the schema's PARSED shape, not its input shape. A field written
`z.string().default("x")` is optional at runtime and **required of a typed client** — so the
dashboard would have to send `tz` and `enabled` on every schedule, and `notify` on every run.

Hono's `validator` has an `InputType` parameter for exactly this, and it cannot be inferred: the
place it would be inferred from is itself guarded by a conditional on `InputType`, which is
circular, so it resolves to `unknown` and the parsed branch wins. Passing it explicitly means
passing the route path too, and a `string` there loses the path the client is keyed by — `$post`
simply disappears from the client.

So optional fields are written `.optional()` and their defaults applied where the value is used,
named once. The schema then states what the API actually accepts, which is what `hc` is for.
`@hono/zod-validator` would have handled it, but npm hoists the shadcn CLI's zod 3 to the workspace
root and that package's types bind to it rather than to the backend's zod 4 — it will not compile
against a version it declares support for. Hono's own validator couples to nothing, so the backend
keeps four runtime dependencies: hono, zod, croner, and the node server adapter.

## Correction: Node runs TypeScript by ERASING it, which is narrower than it sounds

"Node 25 runs TypeScript directly with no build step" is true, and the mechanism matters: it **strips
types**. Any syntax that would have to EMIT code is rejected outright at load time — parameter
properties, enums, namespaces, decorators, `import =`.

`tsc` accepts all of them, and vitest transforms them properly, so neither the typecheck nor the test
suite notices. Two classes reached main with `constructor(private readonly deps: Deps) {}` and could
not be loaded by Node at all: 329 tests passed and `tsc --noEmit` was clean. `node --check` does not
help either — it parses the syntax happily.

`make check-api` loads every module in a short-lived subprocess, which is the only honest check. It is
part of the gates from now on.

## Consequences

- The Python database is never written to, which makes the first week genuinely reversible:
  stop Node, start Python, and nothing has moved. Anything entered while Node was live is lost
  on rollback, which for a few rows is retypable.
- `contract.json` and the version-skew banner retire. The compiler replaces them.
- Python stays on disk and runnable for a month before `src/optionality/`, `tests/` and
  `alembic/` are deleted — about how long it takes to meet a weekly edge case.
- One test cannot be automated: that a real alarm reaches a real phone. The owner fires one
  deliberately at cutover.
