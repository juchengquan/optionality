/** `/configs` — the task configs a run is driven from (ADR 0009, phase 5). */
import { Hono } from "hono";
import { z } from "zod";

import type { Deps } from "../deps.ts";
import {
  deleteConfig, findConfig, insertConfig, listConfigs, schedulesUsingConfig, updateConfig,
} from "../db/queries.ts";
import { toSqlDatetime } from "../db/time.ts";
import { httpError, notFound } from "../errors.ts";
import { TASK_TYPES, configBodyError } from "../schemas/config-body.ts";
import { displayStored } from "../timefmt.ts";
import { valid } from "../validate.ts";

const ConfigIn = z.object({
  name: z.string(),
  task_type: z.enum(TASK_TYPES),
  /** validated against the task type's own schema, not here: the message should name the field */
  body: z.record(z.string(), z.unknown()),
});

const ConfigSummary = z.object({
  name: z.string(),
  task_type: z.string(),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
});

const ConfigDetail = ConfigSummary.extend({ body: z.unknown() });

export function configRoutes(deps: Deps) {
  const { db, settings } = deps;
  const tz = settings.displayTz;

  const summary = (row: { name: string; task_type: string; created_at: string; updated_at: string }) => ({
    name: row.name,
    task_type: row.task_type,
    created_at: displayStored(row.created_at, tz),
    updated_at: displayStored(row.updated_at, tz),
  });
  const detail = (row: {
    name: string; task_type: string; body: string; created_at: string; updated_at: string;
  }) => ({ ...summary(row), body: JSON.parse(row.body) as unknown });

  return new Hono()
    .get("/", (c) => c.json(z.array(ConfigSummary).parse(listConfigs(db).map(summary)), 200))

    .post("/", valid("json", ConfigIn), (c) => {
      const payload = c.req.valid("json");
      const why = configBodyError(payload.task_type, payload.body);
      if (why) throw httpError(422, why);
      if (findConfig(db, payload.name)) {
        throw httpError(409, `config '${payload.name}' already exists`);
      }
      const at = toSqlDatetime(deps.now());
      // the body is stored exactly as the owner sent it. Validation above is a gate: storing the
      // PARSED value would strip any key the schema does not name, which Pydantic also ignores
      // but never removes from what it writes.
      const row = insertConfig(db, {
        name: payload.name,
        task_type: payload.task_type,
        body: JSON.stringify(payload.body),
        created_at: at,
        updated_at: at,
      });
      return c.json(ConfigDetail.parse(detail(row)), 201);
    })

    .get("/:name", (c) => {
      const row = findConfig(db, c.req.param("name"));
      if (!row) throw notFound("config");
      return c.json(ConfigDetail.parse(detail(row)), 200);
    })

    .put("/:name", valid("json", ConfigIn), (c) => {
      const name = c.req.param("name");
      if (!findConfig(db, name)) throw notFound("config");
      const payload = c.req.valid("json");
      const why = configBodyError(payload.task_type, payload.body);
      if (why) throw httpError(422, why);
      const row = updateConfig(
        db, name, payload.task_type, JSON.stringify(payload.body), toSqlDatetime(deps.now()),
      );
      return c.json(ConfigDetail.parse(detail(row)), 200);
    })

    .delete("/:name", (c) => {
      const name = c.req.param("name");
      if (!findConfig(db, name)) throw notFound("config");
      // a schedule pointing at a config that no longer exists would fail at fire time, in the
      // background, where nobody is looking
      if (schedulesUsingConfig(db, name) > 0) {
        throw httpError(409, "config is referenced by a schedule");
      }
      deleteConfig(db, name);
      return c.body(null, 204);
    });
}
