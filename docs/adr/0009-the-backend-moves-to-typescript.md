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

## Consequences

- The Python database is never written to, which makes the first week genuinely reversible:
  stop Node, start Python, and nothing has moved. Anything entered while Node was live is lost
  on rollback, which for a few rows is retypable.
- `contract.json` and the version-skew banner retire. The compiler replaces them.
- Python stays on disk and runnable for a month before `src/optionality/`, `tests/` and
  `alembic/` are deleted — about how long it takes to meet a weekly edge case.
- One test cannot be automated: that a real alarm reaches a real phone. The owner fires one
  deliberately at cutover.
