# 9. The backend moves to TypeScript

Date: 2026-10-01

## Status

Accepted, and complete: the cutover was 2026-10-02 and phase 10 deleted the Python on 2026-10-17.
The Python returned afterwards as a library checked against this code (ADR 0014).

## Decision

The working Python service was rewritten in TypeScript on the owner's call: one language rather
than two, and TypeScript rather than Python. There was no technical forcing function, and this is
recorded so that nobody assumes one. The cheaper way to the stated goal — sharing types with the
frontend — was to declare response models and generate TypeScript from the OpenAPI schema; it was
put to the owner and declined. The rewrite was wanted for itself.

- **A faithful port, not a redesign.** Every ratified invariant stayed; two hard changes at once
  means not knowing which one broke something.
- **Hono with Zod**, because `hc<AppType>` gives the frontend the server's own types with no
  generation step. Fastify was the serious alternative, but its type sharing needs exactly that step.
- **Node 25**, which runs TypeScript directly and ships `node:sqlite`.
- **`node:sqlite` directly, no ORM.** Drizzle was chosen first, on a premise that did not hold:
  its stable release has no `node:sqlite` driver, and the release candidate's `transaction()`
  commits before an async body has run, so a throwing transaction keeps its rows. `better-sqlite3`
  compiles from source on Node 25, which would put a build step on the deploy path. `db/rows.ts`
  recovers the one thing an ORM would have given — a schema the database, the runtime and the
  compiler agree on.

## What still binds

- **Node runs TypeScript by ERASING types.** Syntax that would have to emit code — parameter
  properties, enums, namespaces, decorators, `import =` — is refused at load time, while `tsc` and
  vitest both accept it. `make check-api` loads every module under Node; two classes once reached
  main unable to load at all.
- **The stored formats are SQLAlchemy's**: datetimes as naive-UTC text with six fractional digits,
  booleans as 0 and 1. Kept at the cutover so the Python could open the file as a rollback; the
  rollback is gone, and changing them now would be a migration with no reason left to make it.
- **A typed client types requests from a schema's PARSED shape**, so a field written
  `.default(x)` is required of `hc` callers. Optional fields are `.optional()`, with the default
  applied where the value is used (`validate.ts`).
- **The port reproduces Python's arithmetic where the Python had it**, because a ported test only
  checks what the Python thought to check. CPython's `sum()` compensates (`pySum`), and `round()`
  rounds the stored double (`roundMoney`) — both disagreed with the obvious JavaScript on real
  values. The golden cases now hold the two implementations together (ADR 0014).

## The phases

Code cites these as "ADR 0009, phase N".

| Phase | What it was |
|---|---|
| 0 | OpenD's WebSocket API proven against the TCP SDK, field by field |
| 1 | npm workspaces, a shared tsconfig, one test command |
| 2 | the Python's 3,278 lines of tests ported, and failing |
| 3 | the pure domain, verified against the Python |
| 4 | the schema, and the 24 live rows copied and verified completely |
| 5 | the HTTP routes in Hono with response schemas, `hc` proved over every one |
| 6 | the sweeper, the worker and the schedule |
| 7 | the Telegram bot, tested against a fake |
| 8 | the frontend on `hc`; the contract version and skew banner retired |
| 9 | the cutover, and a real alarm to a real phone |
| 10 | the Python deleted |

## The cutover happened

2026-10-02, 11:19 UTC: `com.optionality.api` replaced the Python on the same port, behind the same
path, serving the same bundle. There was no side-by-side run — quotes are never persisted, so the
alarm engine and the API cannot be separated, and two engines would double-alarm — so verification
had to come first: four differentials compared the domain over 19,265 values, the OpenD client over
288 live fields, both services' answers, and the copied database field by field.

## Phase 10 happened

2026-10-17, ahead of schedule, for the reason ADR 0014 gives. The run pipeline this ADR had kept in
Python was unused (#118), so it went in both languages, and with it **a ratified invariant — "one
worker thread owns run execution."** It existed to serialise runs; with no runs it protects nothing,
and what it implied for everything else — every OpenD call single and bounded — stays in CLAUDE.md
as an invariant of its own.
