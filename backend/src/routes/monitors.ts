/** `/monitors` and `/quotes` (ADR 0009, phase 5).
 *
 *  A Monitor exists to warn, never to record what you own (CONTEXT.md). That is why creating one
 *  links it to whatever Position already holds its contracts rather than bringing a Position into
 *  being, and why deleting one leaves the Position alone.
 */
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";

import { buildSpxCode } from "../domain/contract.ts";
import { comboFieldError } from "../domain/monitor.ts";
import type { Deps } from "../deps.ts";
import {
  clearMonitorLinks, deleteMonitorRow, findMonitor, findMonitorByCodeField, insertMonitor,
  listMonitors, positionsForMonitors, updateMonitorFields,
} from "../db/queries.ts";
import { atomic } from "../db/open.ts";
import type { MonitorRow } from "../db/rows.ts";
import { fromSqliteBool, toSqliteBool, toSqliteJson } from "../db/values.ts";
import { toSqlDatetime } from "../db/time.ts";
import { httpError, notFound } from "../errors.ts";
import { applyTotalEntry, linkToPositions, watchlistQuotes } from "../monitors.ts";
import {
  ComboMonitorIn, DEFAULT_COMBO_FIELD, DEFAULT_COMPARE, DEFAULT_DIRECTION, DEFAULT_ENABLED,
  DEFAULT_SINGLE_FIELD, MonitorCreateIn, MonitorIn, MonitorPatch, TotalEntryIn, isCombo,
  patchThresholdError, thresholdError,
} from "../schemas/monitor.ts";
import { verifyContracts } from "../quotes.ts";
import { displayStored } from "../timefmt.ts";
import { valid } from "../validate.ts";

const MonitorOut = z.object({
  id: z.string(),
  code: z.string(),
  strike_date: z.string(),
  option_type: z.string(),
  strike: z.number(),
  field: z.string(),
  threshold: z.number(),
  direction: z.string(),
  compare: z.string(),
  legs: z.array(z.object({
    sign: z.number(), option_type: z.string(), strike: z.number(),
  })).nullable(),
  enabled: z.boolean(),
  scope: z.string().nullable(),
  positions: z.array(z.object({ id: z.string(), name: z.string() })),
  disabled_reason: z.string().nullable(),
  triggered: z.boolean(),
  last_value: z.number().nullable(),
  last_checked_at: z.string().nullable(),
  created_at: z.string().nullable(),
});

/** uuid4().hex in the Python — 32 hex characters, no dashes, which the column is sized for. */
const newId = () => randomUUID().replaceAll("-", "");

export function monitorRoutes(deps: Deps) {
  const { db, settings } = deps;
  const tz = settings.displayTz;

  const out = (row: MonitorRow, owned: Record<string, { id: string; name: string }[]> = {}) => ({
    id: row.id,
    code: row.code,
    strike_date: row.strike_date,
    option_type: row.option_type,
    strike: row.strike,
    field: row.field,
    threshold: row.threshold,
    direction: row.direction,
    compare: row.compare,
    legs: row.legs === null ? null : (JSON.parse(row.legs) as unknown),
    enabled: fromSqliteBool(row.enabled),
    scope: row.scope,
    positions: (owned[row.id] ?? []).map((p) => ({ id: p.id, name: p.name })),
    disabled_reason: row.disabled_reason,
    triggered: fromSqliteBool(row.triggered),
    last_value: row.last_value,
    last_checked_at: displayStored(row.last_checked_at, tz),
    created_at: displayStored(row.created_at, tz),
  });

  /** Strict gate: everything in the monitors table has been verified to exist on moomoo. Rejects
   *  while OpenD is down, which is deliberate — a monitor on a contract that does not exist would
   *  quarantine itself on the first sweep, which is a worse way to find out. */
  const requireExisting = async (codes: string[]) => {
    const error = await verifyContracts(codes, deps.fetchQuotes);
    if (error) throw httpError(422, error);
  };

  const blank = (over: Partial<MonitorRow>): MonitorRow => ({
    id: newId(),
    code: "",
    strike_date: "",
    option_type: "",
    strike: 0,
    field: "",
    threshold: 0,
    direction: DEFAULT_DIRECTION,
    compare: DEFAULT_COMPARE,
    legs: null,
    scope: null,
    enabled: 1,
    disabled_reason: null,
    triggered: 0,
    last_value: null,
    last_checked_at: null,
    last_alarm_at: null,
    created_at: toSqlDatetime(deps.now()),
    ...over,
  });

  return new Hono()
    .get("/", (c) => {
      const rows = listMonitors(db);
      const owned = positionsForMonitors(db, rows.map((r) => r.id));
      return c.json(z.array(MonitorOut).parse(rows.map((r) => out(r, owned))), 200);
    })

    .post("/", valid("json", MonitorCreateIn), async (c) => {
      const payload = c.req.valid("json");
      // the payload shape decides: single-leg (option_type + strike) or combo (name + legs)
      return isCombo(payload) ? createCombo(payload) : createSingle(payload);

      async function createSingle(p: z.output<typeof MonitorIn>) {
        const why = thresholdError(p.compare ?? DEFAULT_COMPARE, p.threshold);
        if (why) throw httpError(422, why);
        const code = buildSpxCode(p.strike_date, p.option_type, p.strike);
        const field = p.field ?? DEFAULT_SINGLE_FIELD;
        if (findMonitorByCodeField(db, code, field)) {
          throw httpError(409, `monitor for (${code}, ${field}) already exists`);
        }
        await requireExisting([code]);
        const enabled = p.enabled ?? DEFAULT_ENABLED;
        const row = blank({
          code,
          strike_date: p.strike_date,
          option_type: p.option_type,
          strike: p.strike,
          field,
          threshold: p.threshold,
          direction: p.direction ?? DEFAULT_DIRECTION,
          compare: p.compare ?? DEFAULT_COMPARE,
          enabled: toSqliteBool(enabled),
          disabled_reason: enabled ? null : "manual",
        });
        const saved = await atomic(db, () => {
          const inserted = insertMonitor(db, row);
          linkToPositions(db, inserted.id, [code]);
          return findMonitor(db, inserted.id)!;
        });
        return c.json(MonitorOut.parse(out(saved)), 201);
      }

      async function createCombo(p: z.output<typeof ComboMonitorIn>) {
        const field = p.field ?? DEFAULT_COMBO_FIELD;
        // checked here rather than in the schema: inside a union, a refinement's message is buried
        // under the other branch's "field required" errors
        const notAdditive = comboFieldError(field);
        if (notAdditive) throw httpError(422, notAdditive);
        const why = thresholdError(p.compare ?? DEFAULT_COMPARE, p.threshold);
        if (why) throw httpError(422, why);
        if (findMonitorByCodeField(db, p.name, field)) {
          throw httpError(409, `monitor for (${p.name}, ${field}) already exists`);
        }
        const legCodes = p.legs.map((leg) => buildSpxCode(p.strike_date, leg.option_type, leg.strike));
        await requireExisting([...new Set(legCodes)].sort());
        const enabled = p.enabled ?? DEFAULT_ENABLED;
        const row = blank({
          code: p.name,
          strike_date: p.strike_date,
          option_type: "CMB",
          strike: 0,
          field,
          threshold: p.threshold,
          direction: p.direction ?? DEFAULT_DIRECTION,
          compare: p.compare ?? DEFAULT_COMPARE,
          legs: toSqliteJson(p.legs),
          enabled: toSqliteBool(enabled),
          disabled_reason: enabled ? null : "manual",
        });
        const saved = await atomic(db, () => {
          const inserted = insertMonitor(db, row);
          // a combo's contracts are its LEGS; its own code is a name the trader chose
          linkToPositions(db, inserted.id, legCodes);
          return findMonitor(db, inserted.id)!;
        });
        return c.json(MonitorOut.parse(out(saved)), 201);
      }
    })

    .put("/:id", valid("json", MonitorIn), async (c) => {
      const id = c.req.param("id");
      const row = findMonitor(db, id);
      if (!row) throw notFound("monitor");
      if (row.legs !== null) {
        throw httpError(422, "combo monitors cannot be edited in place; delete and recreate");
      }
      const p = c.req.valid("json");
      const why = thresholdError(p.compare ?? DEFAULT_COMPARE, p.threshold);
      if (why) throw httpError(422, why);
      const code = buildSpxCode(p.strike_date, p.option_type, p.strike);
      // only probe when the contract actually changed: an edit to a threshold should not fail
      // because OpenD happens to be down
      if (code !== row.code) await requireExisting([code]);
      const field = p.field ?? DEFAULT_SINGLE_FIELD;
      if (findMonitorByCodeField(db, code, field, id)) {
        throw httpError(409, `monitor for (${code}, ${field}) already exists`);
      }
      const updated = updateMonitorFields(db, id, {
        code,
        strike_date: p.strike_date,
        option_type: p.option_type,
        strike: p.strike,
        field,
        threshold: p.threshold,
        direction: p.direction ?? DEFAULT_DIRECTION,
        compare: p.compare ?? DEFAULT_COMPARE,
        enabled: toSqliteBool(p.enabled ?? DEFAULT_ENABLED),
      });
      return c.json(MonitorOut.parse(out(updated)), 200);
    })

    .patch("/:id", valid("json", MonitorPatch), (c) => {
      const id = c.req.param("id");
      // An absent key means "leave it", not "set it to null". The Python needs exclude_none here
      // because Pydantic defaults every optional field to None and includes it; Zod omits an absent
      // key from the parsed object altogether, and rejects an explicit null outright, so what
      // arrives is exactly what was sent.
      const given = c.req.valid("json");
      if (Object.keys(given).length === 0) throw httpError(422, "nothing to update");
      const row = findMonitor(db, id);
      if (!row) throw notFound("monitor");

      const changes: Partial<MonitorRow> = {};
      if (given.name !== undefined) {
        if (row.legs === null) {
          throw httpError(
            422,
            "only combo monitors can be renamed; a single-leg code is derived from its contract",
          );
        }
        if (given.name !== row.code && findMonitorByCodeField(db, given.name, row.field, id)) {
          throw httpError(409, `monitor for (${given.name}, ${row.field}) already exists`);
        }
        changes.code = given.name;
      }
      const compare = given.compare ?? row.compare;
      const threshold = given.threshold ?? row.threshold;
      const why = patchThresholdError(compare, threshold);
      if (why) throw httpError(422, why);
      const field = given.field ?? row.field;
      if (field !== row.field && findMonitorByCodeField(db, changes.code ?? row.code, field, id)) {
        throw httpError(409, `monitor for (${changes.code ?? row.code}, ${field}) already exists`);
      }
      if (given.threshold !== undefined) changes.threshold = given.threshold;
      if (given.direction !== undefined) changes.direction = given.direction;
      if (given.field !== undefined) changes.field = given.field;
      if (given.compare !== undefined) changes.compare = given.compare;
      if (given.enabled !== undefined) {
        changes.enabled = toSqliteBool(given.enabled);
        // re-enabling clears the reason; disabling by hand records that it was by hand, so the
        // sweeper's own quarantine and expiry notices are not overwritten by a manual toggle
        changes.disabled_reason = given.enabled ? null : "manual";
      }
      return c.json(MonitorOut.parse(out(updateMonitorFields(db, id, changes))), 200);
    })

    .post("/:id/total-entry", valid("json", TotalEntryIn), async (c) => {
      const id = c.req.param("id");
      if (!findMonitor(db, id)) throw notFound("monitor");
      const why = await applyTotalEntry(db, id, c.req.valid("json").entry);
      if (why) throw httpError(422, why);
      return c.json({ ok: true } as const, 200);
    })

    .delete("/:id", async (c) => {
      const id = c.req.param("id");
      if (!findMonitor(db, id)) throw notFound("monitor");
      // monitor_positions is a plain table SQLAlchemy never managed, and it is not managed here
      // either: the links must go first or the foreign key refuses the delete. Every row in the
      // live database is linked, so this is not a rare path (#70).
      //
      // The Position itself stays. It is a holding: it exists whether or not anything watches it,
      // and nothing in this service deletes one as a side effect (ADR 0001).
      await atomic(db, () => {
        clearMonitorLinks(db, id);
        deleteMonitorRow(db, id);
      });
      return c.body(null, 204);
    });
}

/** The contract's live figures, as a watchlist row carries them.
 *
 *  A loose object: the fields named here are the ones the dashboard and the bot read, and they are
 *  typed because the service KNOWS they are numbers — it maps them itself (opend/snapshot.ts). The rest
 *  of what moomoo returns passes through untouched for `/spx/quote` and for a human reading JSON.
 *
 *  Declared at all because of what phase 8 found: the frontend used to declare `mid_price?: number`
 *  while the service promised nothing of the kind, so the hand-written interface was a claim rather
 *  than a fact. With `hc` reading this, it is a fact.
 */
const SnapshotOut = z.looseObject({
  code: z.string().nullish(),
  name: z.string().nullish(),
  update_time: z.string().nullish(),
  fetched_at: z.string().nullish(),
  mid_price: z.number().nullish(),
  bid_price: z.number().nullish(),
  ask_price: z.number().nullish(),
  last_price: z.number().nullish(),
  option_delta: z.number().nullish(),
  option_gamma: z.number().nullish(),
  option_theta: z.number().nullish(),
  option_vega: z.number().nullish(),
  option_implied_volatility: z.number().nullish(),
  option_contract_size: z.number().nullish(),
});

/** One watchlist row: everything needed to draw it, with no arithmetic left for the client. */
const EntryOut = z.object({
  id: z.string(),
  code: z.string(),
  strike_date: z.string(),
  field: z.string(),
  threshold: z.number(),
  direction: z.string(),
  compare: z.string(),
  /** breaching NOW, by the figures in this same row. The engine's own verdict and its last value
   *  live on /monitors, which is what that endpoint is for (ADR 0010). */
  triggered: z.boolean(),
  snapshot: SnapshotOut.nullable(),
  legs: z.array(z.object({
    sign: z.number(), option_type: z.string(), strike: z.number(),
  })).optional(),
  combo_value: z.number().nullable().optional(),
  combo_greeks: z.record(z.string(), z.number().nullable()).optional(),
  error: z.string().optional(),
  dte: z.number(),
  scope: z.string().nullable(),
  positions: z.array(z.object({ id: z.string(), name: z.string() })),
  cost_to_close: z.number().nullable(),
  entry: z.number().nullable(),
  pnl: z.number().nullable(),
  fill: z.number().nullable(),
});

/** `/quotes` — a live call for the whole watchlist, which the bot uses and the dashboard does not. */
export function quoteRoutes(deps: Deps) {
  return new Hono().get("/quotes", async (c) => {
    try {
      return c.json(
        z.array(EntryOut).parse(
          await watchlistQuotes(deps.db, deps.settings.displayTz, deps.fetchQuotes, {
            includeCombos: true,
            now: deps.now(),
          }),
        ),
        200,
      );
    } catch (err) {
      throw httpError(502, `OpenD call failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}
