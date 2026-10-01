/** `/runs` — triggering a run and reading what it produced (ADR 0009, phase 5).
 *
 *  Creating a run and queueing it are two steps because one worker thread owns run execution
 *  (CLAUDE.md): the request writes the row and hands over an id, and the worker decides when.
 */
import { Hono } from "hono";
import { z } from "zod";

import type { Deps } from "../deps.ts";
import { findConfig, findReport, findRun, listRuns } from "../db/queries.ts";
import { fromSqliteBool } from "../db/values.ts";
import { httpError, notFound } from "../errors.ts";
import type { RunRow } from "../db/rows.ts";
import { TASK_TYPES } from "../schemas/config-body.ts";
import { displayStored } from "../timefmt.ts";
import { valid } from "../validate.ts";

/** `notify` is `.optional()` rather than `.default(false)` so that a typed client may omit it —
 *  see validate.ts. Absent means do not send anything: a run that buzzes a phone has to be asked
 *  for. */
const RunIn = z.object({
  task: z.enum(TASK_TYPES),
  config: z.string(),
  notify: z.boolean().optional(),
});

const RunOut = z.object({
  id: z.string(),
  task_type: z.string(),
  config_name: z.string(),
  trigger: z.string(),
  notify: z.boolean(),
  attempt: z.number(),
  status: z.string(),
  error: z.string().nullable(),
  created_at: z.string().nullable(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
});

const Triggered = z.object({ run_id: z.string(), status: z.literal("queued") });

/** A query string carries strings, so that is what this takes; the number is made in the handler.
 *
 *  Typing `limit` as a number here would make Hono derive a REQUIRED query parameter for the
 *  client, because it works back from the parsed shape — and the dashboard asks for `/runs` with
 *  no query at all. */
const RunQuery = z.object({
  status: z.string().optional(),
  limit: z.string().optional(),
});

/** `limit` is capped rather than rejected: the dashboard asks for a page, and a silly number is a
 *  client bug the API should survive. An unparseable one falls back to the default. */
function limitOf(raw: string | undefined): number {
  const n = Number(raw);
  if (raw === undefined || !Number.isFinite(n)) return 50;
  return Math.max(0, Math.min(Math.trunc(n), 500));
}

export function runRoutes(deps: Deps) {
  const { db, settings, worker, runs } = deps;
  const tz = settings.displayTz;

  const out = (row: RunRow) => ({
    id: row.id,
    task_type: row.task_type,
    config_name: row.config_name,
    trigger: row.trigger,
    notify: fromSqliteBool(row.notify),
    attempt: row.attempt,
    status: row.status,
    error: row.error,
    created_at: displayStored(row.created_at, tz),
    started_at: displayStored(row.started_at, tz),
    finished_at: displayStored(row.finished_at, tz),
  });

  const summaryOf = (runId: string): Record<string, unknown> => {
    const report = findReport(db, runId);
    if (!report) throw notFound("report");
    return JSON.parse(report.summary) as Record<string, unknown>;
  };

  return new Hono()
    .post("/", valid("json", RunIn), (c) => {
      const payload = c.req.valid("json");
      const config = findConfig(db, payload.config);
      if (!config) throw httpError(404, `config '${payload.config}' not found`);
      if (config.task_type !== payload.task) {
        throw httpError(
          422,
          `config '${payload.config}' is a '${config.task_type}' config, not '${payload.task}'`,
        );
      }
      const runId = runs.createRun({
        taskType: payload.task,
        configName: payload.config,
        trigger: "api",
        notify: payload.notify ?? false,
      });
      worker.submit(runId);
      return c.json(Triggered.parse({ run_id: runId, status: "queued" }), 202);
    })

    .get("/", valid("query", RunQuery), (c) => {
      const { status, limit } = c.req.valid("query");
      return c.json(z.array(RunOut).parse(listRuns(db, { status, limit: limitOf(limit) }).map(out)), 200);
    })

    .get("/:id", (c) => {
      const row = findRun(db, c.req.param("id"));
      if (!row) throw notFound("run");
      return c.json(RunOut.parse(out(row)), 200);
    })

    .get("/:id/report", (c) => c.json(summaryOf(c.req.param("id")), 200))

    .get("/:id/details", (c) => {
      const details = (summaryOf(c.req.param("id")).details ?? []) as Record<string, unknown>[];
      const code = c.req.query("code");
      return c.json(code ? details.filter((d) => d.code === code) : details, 200);
    })

    .get("/:id/report.html", (c) => {
      const report = findReport(db, c.req.param("id"));
      if (!report) throw notFound("report");
      // c.body rather than c.html, with the same content type. `hc` types every helper's status
      // and body except c.html, which it reports as ClientResponse<{}, StatusCode, string> — so a
      // caller could not narrow on the status at all. Same bytes, same header, a typed contract.
      return c.body(deps.htmlDocument(report.html), 200, {
        "Content-Type": "text/html; charset=UTF-8",
      });
    });
}
