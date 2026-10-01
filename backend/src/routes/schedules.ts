/** `/schedules` — when runs fire on their own (ADR 0009, phase 5).
 *
 *  Every write calls `scheduler.refreshJobs()`, because a schedule row that the running scheduler
 *  has not been told about is a schedule that silently does not happen until the next restart.
 */
import { Hono } from "hono";
import { z } from "zod";

import { cronError } from "../cron.ts";
import type { Deps } from "../deps.ts";
import {
  deleteSchedule, findConfig, findSchedule, insertSchedule, listSchedules, updateSchedule,
} from "../db/queries.ts";
import { fromSqliteBool, toSqliteBool } from "../db/values.ts";
import { httpError, notFound } from "../errors.ts";
import { TASK_TYPES } from "../schemas/config-body.ts";
import { valid } from "../validate.ts";

/** Schedule cron tz stays America/New_York (CLAUDE.md); the field exists so the owner can say so. */
const DEFAULT_TZ = "America/New_York";
const DEFAULT_ENABLED = true;

/** `.optional()` rather than `.default()`, so that a typed client may omit them — see validate.ts.
 *  The defaults are applied in `stored` below, which is the only place the values are written. */
const ScheduleIn = z.object({
  cron_expr: z.string(),
  tz: z.string().optional(),
  task_type: z.enum(TASK_TYPES),
  config_name: z.string(),
  enabled: z.boolean().optional(),
});

const ScheduleOut = z.object({
  id: z.number(),
  cron_expr: z.string(),
  tz: z.string(),
  task_type: z.string(),
  config_name: z.string(),
  enabled: z.boolean(),
});

export function scheduleRoutes(deps: Deps) {
  const { db, scheduler } = deps;

  const out = (row: {
    id: number; cron_expr: string; tz: string; task_type: string; config_name: string; enabled: number;
  }) => ({ ...row, enabled: fromSqliteBool(row.enabled) });

  const check = (payload: z.output<typeof ScheduleIn>) => {
    const why = cronError(payload.cron_expr, payload.tz ?? DEFAULT_TZ);
    if (why) throw httpError(422, why);
    // a schedule pointing at a config that does not exist fires into nothing, in the background
    if (!findConfig(db, payload.config_name)) {
      throw httpError(422, `config '${payload.config_name}' does not exist`);
    }
  };

  const stored = (payload: z.output<typeof ScheduleIn>) => ({
    cron_expr: payload.cron_expr,
    tz: payload.tz ?? DEFAULT_TZ,
    task_type: payload.task_type,
    config_name: payload.config_name,
    enabled: toSqliteBool(payload.enabled ?? DEFAULT_ENABLED),
  });

  return new Hono()
    .get("/", (c) => c.json(z.array(ScheduleOut).parse(listSchedules(db).map(out))))

    .post("/", valid("json", ScheduleIn), (c) => {
      const payload = c.req.valid("json");
      check(payload);
      const row = insertSchedule(db, stored(payload));
      scheduler.refreshJobs();
      return c.json(ScheduleOut.parse(out(row)), 201);
    })

    .put("/:id", valid("json", ScheduleIn), (c) => {
      const id = Number(c.req.param("id"));
      if (!findSchedule(db, id)) throw notFound("schedule");
      const payload = c.req.valid("json");
      check(payload);
      const row = updateSchedule(db, id, stored(payload));
      scheduler.refreshJobs();
      return c.json(ScheduleOut.parse(out(row)));
    })

    .delete("/:id", (c) => {
      const id = Number(c.req.param("id"));
      if (!findSchedule(db, id)) throw notFound("schedule");
      deleteSchedule(db, id);
      scheduler.refreshJobs();
      return c.body(null, 204);
    });
}
