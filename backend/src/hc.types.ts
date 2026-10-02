/** `hc<AppType>` against a hand-written call for EVERY endpoint (ADR 0009, phase 5).
 *
 *  This is the file the rewrite exists for. The dashboard and the API deploy separately, so until now
 *  the only thing keeping them in step was an integer on /health and a banner when it disagreed
 *  (ADR 0006). With `hc`, a route whose shape changed is a compile error in the frontend instead of a
 *  blank cell at the end of a sweep.
 *
 *  It is a .ts file rather than a .test.ts because its assertions are for the compiler: `npm run
 *  typecheck` is what runs them, and nothing here executes. The checks are written so that `any`
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

/** Every endpoint, called the way the dashboard will call it.
 *
 *  All twenty-nine. A route added without a line here is a route nothing has type-checked, which is
 *  the only way the guarantee quietly stops being true.
 */
async function endpoints() {
  const id = { id: "x" };

  return {
    // --- health, and the live watchlist -------------------------------------------------
    health: await (await client.health.$get()).json(),
    quotes: await (await client.quotes.$get()).json(),

    // --- configs -----------------------------------------------------------------------
    configs: await (await client.configs.$get()).json(),
    configCreated: await client.configs.$post({
      json: { name: "spx", task_type: "holdings", body: {} },
    }),
    config: await (await client.configs[":name"].$get({ param: { name: "spx" } })).json(),
    configUpdated: await client.configs[":name"].$put({
      param: { name: "spx" }, json: { name: "spx", task_type: "holdings", body: {} },
    }),
    configDeleted: await client.configs[":name"].$delete({ param: { name: "spx" } }),

    // --- schedules ---------------------------------------------------------------------
    schedules: await (await client.schedules.$get()).json(),
    scheduleCreated: await client.schedules.$post({
      json: { cron_expr: "35 9 * * mon-fri", task_type: "holdings", config_name: "spx" },
    }),
    scheduleUpdated: await client.schedules[":id"].$put({
      param: id, json: { cron_expr: "0 9 * * *", task_type: "holdings", config_name: "spx" },
    }),
    scheduleDeleted: await client.schedules[":id"].$delete({ param: id }),

    // --- runs --------------------------------------------------------------------------
    runsResp: await client.runs.$get({ query: {} }),
    runs: await (await client.runs.$get({ query: {} })).json(),
    triggered: await client.runs.$post({ json: { task: "holdings", config: "spx" } }),
    run: await (await client.runs[":id"].$get({ param: id })).json(),
    report: await (await client.runs[":id"].report.$get({ param: id })).json(),
    details: await (await client.runs[":id"].details.$get({ param: id })).json(),
    reportHtml: await client.runs[":id"]["report.html"].$get({ param: id }),

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
    monitorReplaced: await client.monitors[":id"].$put({
      param: id,
      json: { strike_date: "2026-12-18", option_type: "CALL", strike: 6500, threshold: 0.6 },
    }),
    monitorPatched: await client.monitors[":id"].$patch({ param: id, json: { threshold: 0.5 } }),
    totalEntry: await client.monitors[":id"]["total-entry"].$post({ param: id, json: { entry: 3.21 } }),
    monitorDeleted: await client.monitors[":id"].$delete({ param: id }),

    // --- positions ---------------------------------------------------------------------
    positions: await (await client.positions.$get()).json(),
    values: await (await client.positions.values.$get()).json(),
    positionCreated: await client.positions.$post({
      json: {
        name: "1016_IC", strike_date: "2026-12-18",
        legs: [{ side: "sold", option_type: "CALL", strike: 8050 }],
      },
    }),
    positionPatched: await client.positions[":id"].$patch({ param: id, json: { entry: 3.0 } }),
    positionDeleted: await client.positions[":id"].$delete({ param: id }),

    // --- one contract's quote ----------------------------------------------------------
    spx: await (await client.spx.quote.$get({
      query: { strike_date: "2026-12-18", option_type: "CALL", strike: "6500" },
    })).json(),
  };
}

type E = Awaited<ReturnType<typeof endpoints>>;

/** Each field named here is one the dashboard reads. If a route stops returning it, or returns it
 *  under another name or another type, this stops compiling — which is the point. */
export type HcChecks = [
  // /health ---------------------------------------------------------------------------
  Checked<Exactly<E["health"]["db"], boolean>>,
  Checked<Exactly<E["health"]["opend"], boolean>>,
  Checked<Exactly<E["health"]["queue_depth"], number>>,
  Checked<Exactly<E["health"]["monitor"]["alarms"]["label"], string>>,
  Checked<Exactly<E["health"]["monitor"]["alarms"]["bad"], boolean>>,
  Checked<Exactly<E["health"]["settings"]["sweep_seconds"], number>>,
  // nullable where the Python returns None: a run that has not started has no started_at, and the
  // dashboard renders a dash rather than the string "null"
  Checked<Exactly<E["health"]["last_run"],
    { id: string; task_type: string; status: string; created_at: string | null } | null>>,

  // the watchlist entry the dashboard's table is built from ----------------------------
  Checked<Known<Ok<E["quotes"]>>>,
  Checked<Exactly<Ok<E["quotes"]>[number]["dte"], number>>,
  Checked<Exactly<Ok<E["quotes"]>[number]["fill"], number | null>>,
  Checked<Exactly<Ok<E["quotes"]>[number]["cost_to_close"], number | null>>,
  Checked<Exactly<Ok<E["quotes"]>[number]["pnl"], number | null>>,
  Checked<Exactly<Ok<E["quotes"]>[number]["triggered"], boolean>>,
  Checked<Known<Ok<E["quotes"]>[number]["snapshot"]>>,

  // configs ---------------------------------------------------------------------------
  Checked<Known<Ok<E["configs"]>>>,
  Checked<Exactly<Ok<E["configs"]>[number]["name"], string>>,
  Checked<Exactly<Ok<E["configs"]>[number]["created_at"], string | null>>,
  Checked<Exactly<Ok<E["config"]>["task_type"], string>>,

  // schedules -------------------------------------------------------------------------
  Checked<Exactly<Ok<E["schedules"]>[number]["enabled"], boolean>>,
  Checked<Exactly<Ok<E["schedules"]>[number]["id"], number>>,
  Checked<Exactly<Ok<E["schedules"]>[number]["tz"], string>>,

  // runs ------------------------------------------------------------------------------
  Checked<Exactly<Ok<E["runs"]>[number]["notify"], boolean>>,
  Checked<Exactly<Ok<E["runs"]>[number]["attempt"], number>>,
  Checked<Exactly<Ok<E["run"]>["finished_at"], string | null>>,
  Checked<Exactly<Ok<E["run"]>["error"], string | null>>,
  Checked<Known<E["report"]>>,
  Checked<Known<E["details"]>>,

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

  // positions -------------------------------------------------------------------------
  Checked<Known<Ok<E["positions"]>>>,
  Checked<Exactly<Ok<E["positions"]>[number]["contracts"], number>>,
  Checked<Exactly<Ok<E["positions"]>[number]["entry"], number | null>>,
  Checked<Exactly<Ok<E["positions"]>[number]["strategy"], string | null>>,
  Checked<Exactly<Ok<E["positions"]>[number]["legs"],
    { side: string; option_type: string; strike: number }[]>>,
  Checked<Exactly<Ok<E["values"]>[number]["cost_to_close"], number | null>>,
  Checked<Exactly<Ok<E["values"]>[number]["pnl"], number | null>>,
  Checked<Exactly<Ok<E["values"]>[number]["contract_size"], number | null>>,
  Checked<Known<Ok<E["values"]>[number]["greeks"]>>,

  // one contract ----------------------------------------------------------------------
  Checked<Exactly<Ok<E["spx"]>["code"], string>>,
  Checked<Known<Ok<E["spx"]>["snapshot"]>>,
];

/** The statuses are typed too, so a caller can narrow on them.
 *
 *  Every success status is stated explicitly in its handler. Without that, `hc` hands the caller the
 *  whole ContentfulStatusCode union and `res.status === 422` narrows nothing — which is the only
 *  thing the dashboard wants to ask. A 404 does not appear here because it is thrown rather than
 *  returned, and `{detail}` in the body is what a caller reads either way.
 */
export type StatusChecks = [
  Checked<Exactly<E["runsResp"]["status"], 200 | 422>>,
  Checked<Exactly<E["triggered"]["status"], 202 | 422>>,
  Checked<Exactly<E["configCreated"]["status"], 201 | 422>>,
  Checked<Exactly<E["configUpdated"]["status"], 200 | 422>>,
  Checked<Exactly<E["configDeleted"]["status"], 204>>,
  Checked<Exactly<E["scheduleCreated"]["status"], 201 | 422>>,
  Checked<Exactly<E["scheduleUpdated"]["status"], 200 | 422>>,
  Checked<Exactly<E["scheduleDeleted"]["status"], 204>>,
  Checked<Exactly<E["monitorCreated"]["status"], 201 | 422>>,
  Checked<Exactly<E["comboCreated"]["status"], 201 | 422>>,
  Checked<Exactly<E["monitorReplaced"]["status"], 200 | 422>>,
  Checked<Exactly<E["monitorPatched"]["status"], 200 | 422>>,
  Checked<Exactly<E["totalEntry"]["status"], 200 | 422>>,
  Checked<Exactly<E["monitorDeleted"]["status"], 204>>,
  Checked<Exactly<E["positionCreated"]["status"], 201 | 422>>,
  Checked<Exactly<E["positionPatched"]["status"], 200 | 422>>,
  Checked<Exactly<E["positionDeleted"]["status"], 204>>,
  // the report page is served with c.body rather than c.html: `hc` types every other helper's
  // status and body, and c.html alone comes back as ClientResponse<{}, StatusCode, string>
  Checked<Exactly<E["reportHtml"]["status"], 200>>,

  // {detail} is IN the union wherever a route can reject, so the dashboard cannot read rows without
  // saying what it does when the request was refused. That is the bug class that used to render as a
  // silently empty table.
  Checked<ErrorBody extends Awaited<ReturnType<E["runsResp"]["json"]>> ? true : { missing: true }>,
];
