# 20. Delivery is an entrypoint, and the library never depends on it

Date: 2026-11-09

## Status

Accepted and built. Decided with the owner on 2026-11-09, in a design session that began from the owner's
own reading: that the TypeScript backend is two parts, "the library, which is the main logic, like
how data is fetched, and the hosting".

The reading was right and the count was not. There is no single host: `http/` and `bot/` are two
delivery surfaces consuming the same services, which is what makes the split load-bearing rather
than decorative. That measurement is the whole basis of this decision.

Follows the three seams of #235, #239 and #240 (`vendors/`, `engine/`, `http/`) and reuses their
guard rather than adding one.

Amends **CLAUDE.md**'s Layout section, and adds the one glossary sentence this repository has never
had for Position and Holding.

## Context

The split the owner described already existed and was already clean. Measured across `src`,
`testing`, `tools` and the repo-root tools, suites included, exactly two lines in the whole
backend import a delivery surface, and both are in `main.ts`:

    backend/src/main.ts:14: import { type Deps, createApp } from "./http/index.ts";
    backend/src/main.ts:21: import { TelegramBot } from "./bot/bot.ts";

So "logic must not depend on delivery" was true, unwritten and unenforced — the same shape as
every other finding of this review round. What `main.ts` wires is three ways work starts: an HTTP
request, a Telegram message, and a clock tick.

Three further measurements shaped the decision, and two of them ruled options out.

**The hosts reach past the services into the database.** 31 direct `db/` imports from the three
callers — `http/` 16, `bot/` 7, `engine/` 8 — alongside 6, 10 and 7 direct `domain/` imports. The
seven service modules (`monitors.ts`, `positions.ts`, `references.ts`, `watchlist.ts`,
`holdings.ts`, `create-monitor.ts`, `quotes.ts`) form a clean DAG with `quotes.ts` at the bottom
and no cycles, but they are **not** a layer the hosts pass through. They are helpers used beside
direct database access.

**Two of the obvious names are already taken by this codebase.** `host` means a machine we connect
OUTWARD to — `opendHost`, `ibkrHost`, `host` in `env.ts`, and `hostname` as the bind address in
`main.ts` — so a `hosts/` directory of inbound surfaces would invert the word. And `transport` is
used for both directions already: `bot/bot.ts` (inbound) but also `vendors/opend/client.ts` and
`notify.ts` (outbound), so it names "the thing that moves bytes" and cannot name the inbound half.

**`src/` already means the library.** `tools/check-test-support.mjs` exists so that moving the
harness out of `src/` is what makes `src/` mean "the service", and CLAUDE.md says "the service"
throughout. The logic half is not an unnamed sub-part wanting a wrapper; it is what `src/` is.

The cost of wrapping it anyway was measured: 105 files, maximum path depth 5 → 6, and `../../../`
becoming ordinary where it is used three times today.

## Decision

**`backend/src/entrypoints/` holds the delivery surfaces, and nothing else moves.**

    backend/src/
    ├── entrypoints/
    │   ├── http/          the Hono app, routes, deps, validate, openapi, hc.types
    │   └── bot/           the Telegram long-poll and the command table
    ├── domain/  db/  vendors/  engine/  schemas/  cases/
    ├── monitors.ts  references.ts  watchlist.ts  holdings.ts  create-monitor.ts
    ├── quotes.ts  env.ts  ports.ts  hydrate.ts  notify.ts  telegram.ts  golden.ts
    └── main.ts            the only file that wires the two halves

29 files move. `src/` keeps the names that already work.

**An entrypoint is a surface the outside world reaches the service through.** By that definition
the clock is not one: `scheduler.ts` has zero imports — it knows nothing of the sweeper, the
database or anything else, and `main.ts` is what joins them with
`scheduler.startSweep(interval, () => sweeper.sweep(), …)`. It is a timer utility, not an adapter,
and the sweeper it drives genuinely is logic. So `engine/` stays whole, in the library, and its
door keeps withholding `SweepHealth`.

The cost of that definition is one honest asymmetry: the clock, which is what makes the alarms
happen at all, lives in the library rather than beside the other two ways work starts. The
alternative — `entrypoints/` meaning "any way work enters", with the scheduler and `main.ts`'s
sweep wiring moved into `entrypoints/sweep/` — is coherent and was deliberately deferred rather
than rejected.

**The rule is enforced by `check-seams`, through one new field.** `SEAMS` gains `importableBy`:
which files outside a seam may use its doors at all.

    {
      dir: "backend/src/entrypoints",
      doors: ["http/index.ts", "bot/bot.ts"],
      importableBy: ["backend/src/main.ts", "backend/testing/harness.ts"],
      never: /\/(app\.ts|routes\/.*)$/,
      why: "delivery depends on the library and never the reverse; main.ts is the only wiring",
    }

Three things about that shape are deliberate:

- **It locks in today's state for nothing.** All three directories are already main-only, so the
  field costs no change now and catches the first drift. It goes on `engine/` too, whose
  `index.ts` already *claims* "main.ts is the only thing outside that needs any of them" — an
  unenforced sentence, which is this round's whole subject.
- **It attaches to `entrypoints/` rather than to each surface.** A rule on `http/` and `bot/`
  separately would leave a THIRD entrypoint unguarded until somebody remembered to add a line.
  A test therefore asserts that every directory in `entrypoints/` has a declared door, so a new
  surface with no line fails rather than passes. That is the "complete by diligence" failure
  `hc.types.test.ts` was written for, applied in advance.
- **No second script and no new vocabulary.** One guard, one `SEAMS` table, one test file.

**`positions.ts` is split, because it has two audiences.** Three of its four exports are called by
`engine/sweeper.ts` and by nothing else:

| export | called by |
| --- | --- |
| `adoptOrphanMonitors` | `routes/positions.ts`, `monitors.ts` — request time |
| `recordSamples` | `engine/sweeper.ts` only |
| `noticeManageBy` | `engine/sweeper.ts` only |
| `PositionSweepDeps` | `engine/sweeper.ts` only |

The sweep's three (~105 lines) move to `engine/positions.ts`, inside the engine's door, so a route
can no longer write a sample mid-request outside the sweep's one-instant guarantee.
`adoptOrphanMonitors` (~20 lines) moves to `monitors.ts`, which already imports it and which is
what it is about: it links MONITORS to positions they now watch. `positions.ts` disappears, and the
tests follow their subjects — which also undoes an oddity #240 created, a `positions.test.ts` at
`src/` root testing something only the engine calls.

**Position and Holding are one concept at two stages**, and this is the first time the repository
says so. A **Position** is the stored record of something owned; a **Holding** is that record
VALUED — what it is worth and where it stands against its exit schedule. `holdings.ts` is
therefore the valuation of positions and keeps its name, because both words are public: the
dashboard asks `/positions/values` and the bot asks `/holdings`, and renaming either would be an
API change for a glossary's sake.

**`backend/package.json`'s `"."` export becomes `./src/entrypoints/http/index.ts`**, so the
frontend's `import type { AppType } from "backend"` is unchanged. That is also correct under this
model: the dashboard is an HTTP client and should depend on the HTTP entrypoint. It reaches it
through the exports map rather than a relative path, which is `check-boundaries`' business, so
`check-seams` does not see it and `importableBy` does not need an entry for it.

## Consequences

- **A second host costs a folder and a line.** The property this buys is the one the owner asked
  for: a CLI, a worker or a gRPC surface can be added without touching the library, and the guard
  proves the dependency never runs the other way.
- **`backend/src` ends this round at 13 loose files and 7 directories**, from 24 and 9 at its
  start. (The first draft of this ADR said 12: I had left `telegram.ts` out of the count.) The service is `src/`; delivery is one directory inside it.
- **The three-layer alternative is not adopted, and not merely postponed.** Hosts going through
  services would mean 31 import sites and, for most of them, a service function forwarding to a
  single query — a Middle Man per column, and no failure behind it. `db/queries/` is already one
  module per table and `insertRow` already names `COLUMNS[table]`, so a row with a missing column
  fails to bind rather than storing silent defaults: the dangerous thing is guarded at the bottom,
  where it belongs. If the database ever stops being SQLite on this machine, "who owns the
  database" becomes a real seam and this gets revisited.
- **`entrypoints/` is a weaker seam than `vendors/` or `engine/`** by the standard those two set.
  `vendors/` has an incident behind it — IB Gateway allows one connection per client id and the
  second displaces the first in silence. `engine/` makes a mutation that survived a sweep fail to
  compile. This one prevents a direction of dependency that has never actually been violated. It
  is worth the 29 files because the direction is the owner's stated goal and the guard is one
  line, but `http/index.ts` already records that it is the weakest of the three and that sentence
  should stay true rather than be quietly upgraded.
- **The deferred question has a name.** If `entrypoints/` should answer "where does work come
  from?" rather than "what does the outside reach?", the clock moves and `main.ts` shrinks. That
  is a second decision, with its own PR, and nothing here forecloses it.
