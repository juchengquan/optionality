/** `/health`, the one route that needs no token (ADR 0009, phase 5).
 *
 *  It is also how the dashboard decides whether it was built against the API it is talking to:
 *  the two deploy separately (ADR 0006), so `contract_version` is the only thing both sides read.
 *
 *  Every branch reports rather than raises. A health endpoint that 500s when the database is gone
 *  tells you less than one that says `db: false`.
 */
import { Hono } from "hono";
import { z } from "zod";

import { CONTRACT_VERSION } from "../contract.ts";
import type { Deps } from "../deps.ts";
import { databaseResponds, latestRun } from "../db/queries.ts";
import { displayStored, displayTime } from "../timefmt.ts";

const LastRun = z.object({
  id: z.string(),
  task_type: z.string(),
  status: z.string(),
  created_at: z.string().nullable(),
});

export const HealthResponse = z.object({
  db: z.boolean(),
  contract_version: z.number(),
  opend: z.boolean(),
  queue_depth: z.number(),
  last_run: LastRun.nullable(),
  monitor: z.object({
    last_sweep_at: z.string().nullable(),
    last_sweep_ok: z.boolean(),
    consecutive_failures: z.number(),
    alarms: z.object({ label: z.string(), bad: z.boolean() }),
    fetched_at: z.string().nullable(),
  }),
  settings: z.object({
    sweep_seconds: z.number(),
    expired_retention_days: z.number(),
    display_tz: z.string(),
  }),
});

export function healthRoutes(deps: Deps) {
  return new Hono().get("/health", async (c) => {
    const { settings, db, sweeper, worker } = deps;
    const tz = settings.displayTz;
    const ok = databaseResponds(db);
    // the latest run is only readable if the database answers at all
    const last = ok ? latestRun(db) : undefined;

    return c.json(
      HealthResponse.parse({
        db: ok,
        contract_version: CONTRACT_VERSION,
        opend: await deps.opendReachable(settings.opendHost, settings.opendPort),
        queue_depth: worker.queueDepth(),
        last_run: last
          ? {
              id: last.id,
              task_type: last.task_type,
              status: last.status,
              created_at: displayStored(last.created_at, tz),
            }
          : null,
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
          sweep_seconds: settings.monitorIntervalSeconds,
          expired_retention_days: settings.expiredRetentionDays,
          display_tz: settings.displayTz,
        },
      }),
    );
  });
}
