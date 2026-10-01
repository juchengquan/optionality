/** `hc<AppType>` against a hand-written call for every endpoint (ADR 0009, phase 5).
 *
 *  This is the file the rewrite exists for. The dashboard and the API deploy separately, so until
 *  now the only thing keeping them in step was an integer on /health and a banner when it
 *  disagreed (ADR 0006). With `hc`, a route whose shape changed is a compile error in the frontend
 *  instead of a blank cell at the end of a sweep.
 *
 *  It is a .ts file rather than a .test.ts because its assertions are for the compiler: `npm run
 *  typecheck` is what runs them, and nothing here executes. The checks are written so that `any`
 *  FAILS them — a response typed `any` would satisfy every ordinary annotation, which is exactly
 *  the way this could pass while proving nothing.
 */
import { hc } from "hono/client";

import type { AppType } from "./app.ts";

const client = hc<AppType>("http://127.0.0.1:31417");

/** True only for a type that is not `any` and not `never`. */
type IsAny<T> = 0 extends 1 & T ? true : false;
type Known<T> = IsAny<T> extends true ? never : [T] extends [never] ? never : true;
type Checked<T extends true> = T;
type Exactly<Actual, Expected> = [Actual] extends [Expected]
  ? [Expected] extends [Actual]
    ? true
    : { actualIsWider: Actual }
  : { actualIsNarrower: Actual };

async function endpoints() {
  const health = await (await client.health.$get()).json();
  const configs = await (await client.configs.$get()).json();
  const config = await (await client.configs[":name"].$get({ param: { name: "spx" } })).json();
  const schedules = await (await client.schedules.$get()).json();
  // A route with a validator can answer 422, so its json() is a union with the error shape and a
  // caller cannot reach the rows without saying what it does about the failure. That is the
  // dashboard's bug class made visible — it is how `/runs?limit=x` used to render as an empty table.
  const runsResp = await client.runs.$get({ query: {} });
  const runsOrError = await runsResp.json();
  const runs = "detail" in runsOrError ? [] : runsOrError;
  const run = await (await client.runs[":id"].$get({ param: { id: "x" } })).json();

  const triggered = await client.runs.$post({
    json: { task: "holdings", config: "spx", notify: false },
  });
  const created = await client.configs.$post({
    json: { name: "spx", task_type: "holdings", body: {} },
  });
  const schedule = await client.schedules.$post({
    json: { cron_expr: "35 9 * * mon-fri", task_type: "holdings", config_name: "spx" },
  });

  return { health, configs, config, schedules, runs, runsOrError, run, triggered, created, schedule };
}

type Endpoints = Awaited<ReturnType<typeof endpoints>>;

/** Each field named here is one the dashboard reads. If a route stops returning it, or returns it
 *  under another name or another type, this stops compiling — which is the point. */
/** The failure shape a validated route can return, which a caller must narrow past. */
type ErrorBody = { detail: string };

export type HcChecks = [
  // {detail} is IN the union, so the dashboard cannot read rows without saying what it does when
  // the request was rejected
  Checked<ErrorBody extends Endpoints["runsOrError"] ? true : { missingErrorShape: Endpoints["runsOrError"] }>,
  Checked<Known<Endpoints["health"]["contract_version"]>>,
  Checked<Exactly<Endpoints["health"]["contract_version"], number>>,
  Checked<Exactly<Endpoints["health"]["db"], boolean>>,
  Checked<Exactly<Endpoints["health"]["monitor"]["alarms"]["label"], string>>,
  Checked<Exactly<Endpoints["health"]["settings"]["sweep_seconds"], number>>,
  // nullable where the Python returns None: a run that has not started has no started_at, and the
  // dashboard renders a dash rather than the string "null"
  Checked<Exactly<Endpoints["health"]["last_run"], { id: string; task_type: string; status: string; created_at: string | null } | null>>,

  Checked<Known<Endpoints["configs"]>>,
  Checked<Exactly<Endpoints["configs"][number]["name"], string>>,
  Checked<Exactly<Endpoints["config"]["task_type"], string>>,

  Checked<Exactly<Endpoints["schedules"][number]["enabled"], boolean>>,
  Checked<Exactly<Endpoints["schedules"][number]["id"], number>>,

  Checked<Exactly<Endpoints["runs"][number]["notify"], boolean>>,
  Checked<Exactly<Endpoints["runs"][number]["attempt"], number>>,
  Checked<Exactly<Endpoints["run"]["finished_at"], string | null>>,
  Checked<Exactly<Endpoints["run"]["error"], string | null>>,
];

/** The status codes are typed too, so a client can narrow on them. */
export type StatusChecks = [
  Checked<Exactly<Endpoints["triggered"]["status"], 202 | 422>>,
  Checked<Exactly<Endpoints["created"]["status"], 201 | 422>>,
  Checked<Exactly<Endpoints["schedule"]["status"], 201 | 422>>,
];
