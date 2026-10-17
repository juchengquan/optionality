/** `/health`, the one route that needs no token (ADR 0009, phase 5).
 *
 *  It is what the dashboard's Service panel reads: the database, OpenD and the sweep's state. The
 *  queue and the last run went with the run pipeline in phase 10 (ADR 0014). It carries no
 *  `contract_version` — that and the skew banner it fed went in ADR 0009 phase 8, when the frontend started taking its types FROM this API (`hc<AppType>`), so a
 *  response that has changed shape is a compile error in the frontend's workspace rather than a
 *  runtime notice. The two services still deploy separately (ADR 0006); `make deploy` restarting
 *  both is what addresses that.
 *
 *  Every branch reports rather than raises. A health endpoint that 500s when the database is gone
 *  tells you less than one that says `db: false`.
 */
import { Hono } from "hono";
import { z } from "zod";

import type { Deps } from "../deps.ts";
import { databaseResponds } from "../db/queries.ts";
import { documented } from "../openapi.ts";
import { displayTime } from "../domain/timefmt.ts";

export const HealthResponse = z.object({
  db: z.boolean(),
  opend: z.boolean(),
  monitor: z.object({
    last_sweep_at: z.string().nullable(),
    last_sweep_ok: z.boolean(),
    consecutive_failures: z.number(),
    alarms: z.object({ label: z.string(), bad: z.boolean() }),
    fetched_at: z.string().nullable(),
  }),
  settings: z.object({
    /** the horizon the dashboard weighs a fill against when it is reading pressure rather than
     *  distance — one definition, because a second copy of 21 in the frontend drifts the first
     *  time EXIT_MANAGE_BY_DTE moves */
    manage_by_dte: z.number(),
    sweep_seconds: z.number(),
    expired_retention_days: z.number(),
    display_tz: z.string(),
  }),
});

const health = documented("Service health; needs no token", { 200: HealthResponse });

export function healthRoutes(deps: Deps) {
  return new Hono().get("/health", health, async (c) => {
    const { settings, db, sweeper } = deps;
    const tz = settings.displayTz;
    const ok = databaseResponds(db);

    return health.reply(c, 200, {
        db: ok,
        // What the last batch did, falling back to the port probe only while nothing has been
        // asked for yet. The probe alone was a green light for a gateway this service could not
        // speak to: on 2026-10-16 OpenD held the WEBSOCKET port open and timed out every login, so
        // this read true while every OpenD-backed route returned 502. An answered request is the
        // only evidence that matters, and reusing the sweep's costs no extra call (ADR 0010).
        opend: sweeper.lastFetchOk()
          ?? await deps.opendReachable(settings.opendHost, settings.moomooWsPort),
        monitor: {
          last_sweep_at: displayTime(sweeper.lastSweepAt(), tz),
          last_sweep_ok: sweeper.lastSweepOk(),
          consecutive_failures: sweeper.consecutiveFailures(),
          alarms: sweeper.alarmState(),
          fetched_at: displayTime(sweeper.lastFetchAt(), tz),
        },
        // knobs a client cannot guess: the sweep cadence the meta line names, and the retention
        // window the muted table counts down to
        settings: {
          manage_by_dte: settings.exitManageByDte,
          sweep_seconds: settings.monitorIntervalSeconds,
          expired_retention_days: settings.expiredRetentionDays,
          display_tz: settings.displayTz,
        },
      });
  });
}
