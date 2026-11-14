/** `hc<AppType>` against a hand-written call for EVERY endpoint (ADR 0009, phase 5).
 *
 *  This is the file the rewrite exists for. The dashboard and the API deploy separately, so until now
 *  the only thing keeping them in step was an integer on /health and a banner when it disagreed
 *  (ADR 0006). With `hc`, a route whose shape changed is a compile error in the frontend instead of a
 *  blank cell at the end of a sweep.
 *
 *  It is a .ts file rather than a .test.ts because its assertions are for the compiler: `npm run
 *  typecheck` is what runs them, and nothing here executes.
 *
 *  "EVERY endpoint" is now CHECKED rather than claimed — `hc.types.test.ts` takes the endpoint list
 *  from `/openapi.json`, which is built from the routes, and names any this file does not call. It
 *  was complete before that test existed, but complete by diligence: nothing imports this file, so
 *  there was nothing a seventeenth endpoint would have broken. The checks are written so that `any`
 *  FAILS them — a response typed `any` satisfies every ordinary annotation, which is exactly how this
 *  could pass while proving nothing.
 */
import { hc } from "hono/client";

import type { AppType } from "./app.ts";

const client = hc<AppType>("http://127.0.0.1:31417");

/** True only for a type that is neither `any` nor `never`. */
type IsAny<T> = 0 extends 1 & T ? true : false;
type Known<T> = IsAny<T> extends true ? never : [T] extends [never] ? never : true;
type Checked<T extends true> = T;
type Exactly<Actual, Expected> = [Actual] extends [Expected]
  ? [Expected] extends [Actual]
    ? true
    : { actualIsWider: Actual }
  : { actualIsNarrower: Actual };

/** The failure body every route can answer with, which a caller must narrow past. */
type ErrorBody = { detail: string };

/** Strip the error arm, the way a caller does after checking `res.ok`. */
type Ok<T> = T extends ErrorBody ? never : T;

/** A short strike against SPX as both `/quotes` and `/positions/values` serve it (#297), written
 *  out rather than imported, so a change to the domain's own type is a change to this pin too. */
type StrikeDistance = {
  code: string; option_type: "CALL" | "PUT"; strike: number;
  delta: number | null; points: number | null; sigma: number | null; one_sigma: number | null;
};

/** Every endpoint, called the way the dashboard will call it.
 *
 *  EVERY one of them. A route added without a line here is a route nothing has type-checked, which is
 *  the only way the guarantee quietly stops being true.
 */
async function endpoints() {
  const id = { id: "x" };

  return {
    // --- health, and the live watchlist -------------------------------------------------
    health: await (await client.health.$get()).json(),
    quotes: await (await client.quotes.$get()).json(),

    // --- monitors ----------------------------------------------------------------------
    monitors: await (await client.monitors.$get()).json(),
    monitorCreated: await client.monitors.$post({
      json: { strike_date: "2026-12-18", option_type: "CALL", strike: 6500, threshold: 0.6 },
    }),
    comboCreated: await client.monitors.$post({
      json: {
        name: "sep-condor", strike_date: "2026-12-18", threshold: 10,
        legs: [
          { sign: 1, option_type: "CALL", strike: 8100 },
          { sign: -1, option_type: "CALL", strike: 8150 },
        ],
      },
    }),
    monitorPatched: await client.monitors[":id"].$patch({ param: id, json: { threshold: 0.5 } }),
    totalEntry: await client.monitors[":id"]["total-entry"].$post({ param: id, json: { entry: 3.21 } }),
    monitorDeleted: await client.monitors[":id"].$delete({ param: id }),

    // --- references ---------------------------------------------------------------------
    references: await (await client.references.$get()).json(),
    referenceCreated: await client.references.$post({
      json: { code: "US.SPY", label: "SPY", source: "moomoo" },
    }),
    referenceDeleted: await client.references[":id"].$delete({ param: id }),

    // --- positions ---------------------------------------------------------------------
    positions: await (await client.positions.$get()).json(),
    values: await (await client.positions.values.$get()).json(),
    positionCreated: await client.positions.$post({
      json: {
        name: "1016_IC", strike_date: "2026-12-18",
        legs: [{ side: "short", option_type: "CALL", strike: 8050 }],
      },
    }),
    positionPatched: await client.positions[":id"].$patch({ param: id, json: { entry: 3.0 } }),
    // a close keeps the holding (ADR 0022); the page reads what it made and which rules it took
    positionClosed: await (await client.positions[":id"].close.$post({
      param: id, json: { exit: 0.4 },
    })).json(),
    positionDeleted: await client.positions[":id"].$delete({ param: id }),
    // the only route reading history. Added in #110 and missed here until a code review pointed
    // at the rule above — the one new route was the one route nothing type-checked, and renaming
    // `days` would have compiled on both sides and landed as a missing line in the sheet.
    vol: await (await client.positions[":id"].vol.$get({ param: id })).json(),
    // the payoff at expiry (#291): a holding's, and draft legs' — the add form's preview and a
    // watched spread drawn at its current value
    payoff: await (await client.positions[":id"].payoff.$get({ param: id })).json(),
    // the daily samples (#295): a holding's history charts, read once when that history is drawn
    samples: await (await client.positions[":id"].samples.$get({ param: id })).json(),
    draftPayoff: await client.positions.payoff.$post({
      json: { legs: [{ side: "short", option_type: "PUT", strike: 7100 }], entry: 1.5 },
    }),

    // --- spreads -----------------------------------------------------------------------
    // a spread, held, with its two usual Monitors, in one step and all or nothing (#293)
    spreadsAdded: await client.spreads.$post({
      json: {
        strike_date: "2026-12-18",
        spreads: [{
          name: "1218_P7150_P7100", held: true, entry: 1.5, opened_at: "2026-11-11",
          legs: [
            { side: "short", option_type: "PUT", strike: 7150 },
            { side: "long", option_type: "PUT", strike: 7100 },
          ],
          monitors: [{ threshold: 3 }, { option_type: "PUT", strike: 7150, threshold: 0.3 }],
        }],
      },
    }),
  };
}

type E = Awaited<ReturnType<typeof endpoints>>;

/** Each field named here is one the dashboard reads. If a route stops returning it, or returns it
 *  under another name or another type, this stops compiling — which is the point. */
export type HcChecks = [
  // /health ---------------------------------------------------------------------------
  Checked<Exactly<E["health"]["db"], boolean>>,
  Checked<Exactly<E["health"]["provider"]["name"], string>>,
  Checked<Exactly<E["health"]["provider"]["ok"], boolean>>,
  Checked<Exactly<E["health"]["monitor"]["alarms"]["label"], string>>,
  Checked<Exactly<E["health"]["monitor"]["alarms"]["bad"], boolean>>,
  Checked<Exactly<E["health"]["settings"]["sweep_seconds"], number>>,

  // the watchlist entry the dashboard's table is built from ----------------------------
  Checked<Known<Ok<E["quotes"]>>>,
  Checked<Exactly<Ok<E["quotes"]>[number]["dte"], number>>,
  Checked<Exactly<Ok<E["quotes"]>[number]["fill"], number | null>>,
  Checked<Exactly<Ok<E["quotes"]>[number]["cost_to_close"], number | null>>,
  Checked<Exactly<Ok<E["quotes"]>[number]["pnl"], number | null>>,
  Checked<Exactly<Ok<E["quotes"]>[number]["triggered"], boolean>>,
  Checked<Known<Ok<E["quotes"]>[number]["quote"]>>,
  // The Levels a row has reached, which the dashboard's top line is built from. Asserted here
  // because there are three places this can vanish without a word: the domain can compute it, the
  // route's zod schema can strip it, and the client type can lose it — each with the compiler
  // happy. The route tests cover the middle one; this covers the last.
  Checked<Exactly<
    NonNullable<Ok<E["quotes"]>[number]["schedule"]>["reached"], "target" | "stop" | null>>,
  Checked<Exactly<
    NonNullable<Ok<E["quotes"]>[number]["schedule"]>["manage_by_due"], boolean>>,
  // what a rule's sentence reads on the redesigned page (ADR 0023): the figure, how far it has to
  // go, and the spreads a single Contract is a leg of — each one a field a schema could strip
  Checked<Exactly<Ok<E["quotes"]>[number]["watched"], number | null>>,
  Checked<Exactly<Ok<E["quotes"]>[number]["distance"], number | null>>,
  Checked<Exactly<Ok<E["quotes"]>[number]["in_combos"], string[]>>,
  // risk on something owned, or an entry signal on a candidate: the page files every rule by it
  Checked<Exactly<Ok<E["quotes"]>[number]["held"], boolean>>,
  // SPX's price as the batch implies it, and why not (ADR 0024): what a strike is placed against
  Checked<Exactly<Ok<E["quotes"]>[number]["spx"], number | null>>,
  Checked<Exactly<Ok<E["quotes"]>[number]["spx_reason"], string | null>>,
  // a spread's short strikes against that SPX, in points and σ: what the strike strip draws (#297)
  Checked<Exactly<Ok<E["quotes"]>[number]["short_strikes"], StrikeDistance[]>>,

  // monitors --------------------------------------------------------------------------
  Checked<Known<Ok<E["monitors"]>>>,
  // legs are null for a single leg and an array for a combo, which is how the dashboard decides
  // which row shape to render
  Checked<Exactly<Ok<E["monitors"]>[number]["legs"],
    { sign: number; option_type: string; strike: number }[] | null>>,
  Checked<Exactly<Ok<E["monitors"]>[number]["triggered"], boolean>>,
  Checked<Exactly<Ok<E["monitors"]>[number]["enabled"], boolean>>,
  Checked<Exactly<Ok<E["monitors"]>[number]["last_value"], number | null>>,
  Checked<Exactly<Ok<E["monitors"]>[number]["scope"], string | null>>,
  Checked<Exactly<Ok<E["monitors"]>[number]["positions"], { id: string; name: string }[]>>,
  Checked<Exactly<Ok<E["monitors"]>[number]["disabled_reason"], string | null>>,

  // references -----------------------------------------------------------------------
  Checked<Known<Ok<E["references"]>>>,
  // every one of these is nullable, and the dashboard draws a dash for each null rather than
  // hiding the row: a Reference with no figure is still a Reference (ADR 0018)
  Checked<Exactly<Ok<E["references"]>[number]["figure"], number | null>>,
  Checked<Exactly<Ok<E["references"]>[number]["field"], string | null>>,
  Checked<Exactly<Ok<E["references"]>[number]["change"], number | null>>,
  Checked<Exactly<Ok<E["references"]>[number]["label"], string | null>>,
  Checked<Exactly<Ok<E["references"]>[number]["source"], string>>,
  Checked<Exactly<Ok<E["references"]>[number]["name"], string | null>>,
  Checked<Exactly<Ok<E["references"]>[number]["error"], string | null>>,
  // the vendor's own claim about freshness. Nullable because null is not false: moomoo reports
  // no grade at all, and the strip must not render that as "live" (ADR 0019)
  Checked<Exactly<Ok<E["references"]>[number]["delayed"], boolean | null>>,
  Checked<Exactly<Ok<E["references"]>[number]["last_known"], boolean | null>>,
  Checked<Exactly<Ok<E["references"]>[number]["delayed_by_minutes"], number | null>>,

  // positions -------------------------------------------------------------------------
  Checked<Known<Ok<E["positions"]>>>,
  Checked<Exactly<Ok<E["positions"]>[number]["contracts"], number>>,
  Checked<Exactly<Ok<E["positions"]>[number]["entry"], number | null>>,
  Checked<Exactly<Ok<E["positions"]>[number]["strategy"], string | null>>,
  Checked<Exactly<Ok<E["positions"]>[number]["legs"],
    { side: "short" | "long"; option_type: string; strike: number }[]>>,
  Checked<Exactly<Ok<E["values"]>[number]["cost_to_close"], number | null>>,
  Checked<Exactly<Ok<E["values"]>[number]["pnl"], number | null>>,
  // the share of a credit captured so far, which the redesigned page shows beside the P&L
  Checked<Exactly<Ok<E["values"]>[number]["captured"], number | null>>,
  Checked<Exactly<Ok<E["values"]>[number]["contract_size"], number | null>>,
  Checked<Exactly<Ok<E["values"]>[number]["spx"], number | null>>,
  Checked<Exactly<Ok<E["values"]>[number]["spx_reason"], string | null>>,
  // each leg's own delta: where a short leg's Δ comes from (#318)
  Checked<Exactly<Ok<E["values"]>[number]["legs_delta"], Record<string, number> | null>>,
  Checked<Exactly<Ok<E["values"]>[number]["short_strikes"], StrikeDistance[]>>,
  Checked<Known<Ok<E["values"]>[number]["greeks"]>>,
  // a closed holding, as the Holdings panel's closed list reads it (ADR 0022)
  Checked<Exactly<Ok<E["positions"]>[number]["closed_on"], string | null>>,
  Checked<Exactly<Ok<E["positions"]>[number]["exit"], number | null>>,
  Checked<Exactly<Ok<E["positions"]>[number]["realized_points"], number | null>>,
  Checked<Exactly<Ok<E["positionClosed"]>["disabled_monitors"], { id: string; code: string }[]>>,
  // the payoff at expiry, as the chart draws it: the corners, the slopes past them, the breakevens
  // and the two maximums, null where the curve has no ceiling or no floor
  Checked<Exactly<Ok<E["payoff"]>["at_strikes"], { spx: number; pnl: number }[]>>,
  Checked<Exactly<Ok<E["payoff"]>["slope_below"], number>>,
  Checked<Exactly<Ok<E["payoff"]>["slope_above"], number>>,
  Checked<Exactly<Ok<E["payoff"]>["breakevens"], number[]>>,
  Checked<Exactly<Ok<E["payoff"]>["max_profit"], number | null>>,
  Checked<Exactly<Ok<E["payoff"]>["max_loss"], number | null>>,
  Checked<Exactly<Ok<Awaited<ReturnType<E["draftPayoff"]["json"]>>>["max_loss"], number | null>>,
  // what the add form reads back from a save: what it made, by id and name
  Checked<Exactly<Ok<Awaited<ReturnType<E["spreadsAdded"]["json"]>>>["positions"], { id: string; name: string }[]>>,
  Checked<Exactly<Ok<Awaited<ReturnType<E["spreadsAdded"]["json"]>>>["monitors"],
    { id: string; code: string; field: string }[]>>,
  // the samples as the burndown draws them: the plan is the service's, the timing says which
  // points are not closes, and every reading the sweep may have withheld is nullable
  Checked<Exactly<Ok<E["samples"]>["plan"], { dte: number; on_pace: number }[]>>,
  Checked<Exactly<NonNullable<Ok<E["samples"]>["levels"]>["target"], number | null>>,
  Checked<Exactly<NonNullable<Ok<E["samples"]>["levels"]>["manage_by_dte"], number>>,
  Checked<Exactly<Ok<E["samples"]>["samples"][number]["timing"],
    "close" | "before-open" | "after-close" | "unrecorded">>,
  Checked<Exactly<Ok<E["samples"]>["samples"][number]["observed_at"], string | null>>,
  Checked<Exactly<Ok<E["samples"]>["samples"][number]["cost_to_close"], number | null>>,
  Checked<Exactly<Ok<E["samples"]>["samples"][number]["on_pace"], number | null>>,
  Checked<Exactly<Ok<E["samples"]>["samples"][number]["legs_iv"], Record<string, number> | null>>,
  Checked<Exactly<Ok<E["samples"]>["samples"][number]["spx"], number | null>>,
];

/** The statuses are typed too, so a caller can narrow on them.
 *
 *  Every success status is stated explicitly in its handler. Without that, `hc` hands the caller the
 *  whole ContentfulStatusCode union and `res.status === 422` narrows nothing — which is the only
 *  thing the dashboard wants to ask. A 404 does not appear here because it is thrown rather than
 *  returned, and `{detail}` in the body is what a caller reads either way.
 */
export type StatusChecks = [
  Checked<Exactly<E["monitorCreated"]["status"], 201 | 422>>,
  Checked<Exactly<E["comboCreated"]["status"], 201 | 422>>,
  Checked<Exactly<E["monitorPatched"]["status"], 200 | 422>>,
  Checked<Exactly<E["totalEntry"]["status"], 200 | 422>>,
  Checked<Exactly<E["monitorDeleted"]["status"], 204>>,
  Checked<Exactly<E["positionCreated"]["status"], 201 | 422>>,
  Checked<Exactly<E["positionPatched"]["status"], 200 | 422>>,
  Checked<Exactly<E["positionDeleted"]["status"], 204>>,
  Checked<Exactly<E["referenceCreated"]["status"], 201 | 422>>,
  Checked<Exactly<E["referenceDeleted"]["status"], 204>>,
  Checked<Exactly<E["draftPayoff"]["status"], 200 | 422>>,
  Checked<Exactly<E["spreadsAdded"]["status"], 201 | 422>>,

  // {detail} is IN the union wherever a route VALIDATES its input, so the dashboard cannot read
  // rows without saying what it does when the request was refused. That is the bug class that used
  // to render as a silently empty table.
  //
  // This pointed at /runs until #118 removed it, and the assertion went with the route while the
  // paragraph above stayed — so the file claimed a proof it no longer carried, which a code review
  // caught. It was not the only one: a second paragraph here explained why "the report page" used
  // c.body rather than c.html, and that page was /runs/:id/report.html, which went in the same
  // commit. Found in a sweep for vestigial prose, two reviews later. Nothing lints this — the
  // sentence named no identifier, so check-make-targets' trick does not reach it.
  //
  // Re-pointed, and NARROWER than that paragraph says, which is worth stating rather than
  // papering over. The arm comes from the `valid()` middleware, so only VALIDATED routes declare
  // it. A route that rejects by `throw notFound(...)` or `throw httpError(...)` returns through
  // app.ts's onError, which `hc` never sees in the route's own type — measured: /positions/values,
  // /positions/:id/vol and /quotes carry no {detail} arm at all, while POST /monitors and POST
  // /positions do. So this proves the shape for the routes that validate, and the narrowing on the
  // thrown paths rests on app.ts's onError returning one shape, which its own test asserts.
  //
  // /spx/quote was the third, and the only one that validated a QUERY rather than a body. It went
  // with #199: nothing called it, and the bot's /snapshot answers the same question in-process.
  // The query branch of `valid()` is now exercised by openapi.test.ts against a route built in the
  // test, since no served route carries a query.
  Checked<ErrorBody extends Awaited<ReturnType<E["monitorCreated"]["json"]>> ? true : false>,
  Checked<ErrorBody extends Awaited<ReturnType<E["positionCreated"]["json"]>> ? true : false>,
  Checked<ErrorBody extends Awaited<ReturnType<E["referenceCreated"]["json"]>> ? true : false>,
  Checked<ErrorBody extends Awaited<ReturnType<E["draftPayoff"]["json"]>> ? true : false>,
];
