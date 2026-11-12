/** `/monitors` and `/quotes` (ADR 0009, phase 5).
 *
 *  A Monitor exists to warn, never to record what you own (CONTEXT.md). That is why creating one
 *  links it to whatever Position already holds its contracts rather than bringing a Position into
 *  being, and why deleting one leaves the Position alone.
 */
import { Hono } from "hono";
import { z } from "zod";

import type { Deps } from "../deps.ts";
import {
  clearMonitorLinks, deleteMonitorRow, findMonitor, findMonitorByCodeField,
  listMonitors, positionsForMonitors, updateMonitorFields,
} from "../../../db/queries/index.ts";
import { atomic } from "../../../db/open.ts";
import {
  type CreateFault, createComboMonitor, createSingleMonitor, isFault,
} from "../../../create-monitor.ts";
import type { MonitorRow } from "../../../db/rows.ts";
import { fromSqliteBool, toSqliteBool } from "../../../db/values.ts";
import { exitPolicy } from "optionality/domain/exit";
import { httpError, notFound, providerFailed } from "../errors.ts";
import { applyTotalEntry, watchlistQuotes } from "../../../monitors.ts";
import {
  ComboMonitorIn, MonitorCreateIn, MonitorIn, MonitorPatch, TotalEntryIn, isCombo,
  monitorCreateMember, patchThresholdError, thresholdError,
} from "../../../schemas/monitor.ts";
import { displayStored } from "../../../db/time.ts";
import { documented } from "../openapi.ts";
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

const list = documented("List monitors", { 200: z.array(MonitorOut) });
const create = documented("Create a monitor, single or combo", { 201: MonitorOut }, [409]);
const update = documented("Update a monitor", { 200: MonitorOut }, [404, 409]);
const totalEntry = documented("Spread a total entry across the holding", { 200: z.object({ ok: z.literal(true) }) }, [404]);
const remove = documented("Delete a monitor", { 204: null }, [404]);

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

  /** One row, with the holdings linked to it READ BACK rather than assumed.
   *
   *  Every write answers through this. `out` alone defaults the map to empty, which is right for a
   *  batch — the list route reads all the links in one query — and wrong for a single reply: it
   *  answered `positions: []` beside the `scope: "all"` the same transaction had just set, so the
   *  reply contradicted itself and a client re-rendering a row from it lost the holding's name and
   *  its leg badge. One extra query per write, on the id that was just written.
   */
  const one = (row: MonitorRow) => out(row, positionsForMonitors(db, [row.id]));

  /** What create-monitor.ts needs, which is the database, one Provider, a clock and the ids. */
  const creating = {
    db, fetchQuotes: deps.provider.fetchQuotes, now: deps.now, newId: deps.newId,
  };

  return new Hono()
    .get("/", list, (c) => {
      const rows = listMonitors(db);
      const owned = positionsForMonitors(db, rows.map((r) => r.id));
      return list.reply(c, 200, rows.map((r) => out(r, owned)));
    })

    .post("/", create, valid("json", MonitorCreateIn, monitorCreateMember), async (c) => {
      const payload = c.req.valid("json");
      // the payload shape decides: single-leg (option_type + strike) or combo (name + legs).
      // `monitorCreateMember` put the same question before validating, so a refusal is the
      // chosen shape's own rather than the union's "Invalid input"
      return isCombo(payload) ? createCombo(payload) : createSingle(payload);

      /** Both faults and the row come back as values (create-monitor.ts); this is where they
       *  become statuses. 422 for anything the rule itself is wrong about, 409 for a rule that
       *  is already there — the wording is the API's, as the bot's is the bot's. */
      async function reply(result: MonitorRow | CreateFault) {
        if (!isFault(result)) return create.reply(c, 201, one(result));
        if (result.kind === "duplicate") {
          throw httpError(409, `monitor for (${result.code}, ${result.field}) already exists`);
        }
        throw httpError(422, result.kind === "threshold"
          ? thresholdError(result.compare, result.threshold)!
          : result.message);
      }

      async function createSingle(p: z.output<typeof MonitorIn>) {
        return reply(await createSingleMonitor(creating, {
          strike_date: p.strike_date,
          option_type: p.option_type,
          strike: p.strike,
          field: p.field,
          threshold: p.threshold,
          direction: p.direction,
          compare: p.compare,
          enabled: p.enabled,
        }));
      }

      async function createCombo(p: z.output<typeof ComboMonitorIn>) {
        return reply(await createComboMonitor(creating, {
          name: p.name,
          strike_date: p.strike_date,
          legs: p.legs,
          field: p.field,
          threshold: p.threshold,
          direction: p.direction,
          compare: p.compare,
          enabled: p.enabled,
        }));
      }
    })

    .patch("/:id", update, valid("json", MonitorPatch), (c) => {
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
      return update.reply(c, 200, one(updateMonitorFields(db, id, changes)));
    })

    .post("/:id/total-entry", totalEntry, valid("json", TotalEntryIn), async (c) => {
      const id = c.req.param("id");
      if (!findMonitor(db, id)) throw notFound("monitor");
      const why = await applyTotalEntry(db, id, c.req.valid("json").entry);
      if (why) throw httpError(422, why);
      return totalEntry.reply(c, 200, { ok: true });
    })

    .delete("/:id", remove, async (c) => {
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
 *  typed because the service KNOWS they are numbers — each Provider maps its own vendor's figures
 *  onto these names (`opend/snapshot.ts`, `ibkr/fields.ts`). Whatever else the Provider returns
 *  passes through untouched, for a human reading JSON.
 *
 *  Declared at all because of what phase 8 found: the frontend used to declare `mid_price?: number`
 *  while the service promised nothing of the kind, so the hand-written interface was a claim rather
 *  than a fact. With `hc` reading this, it is a fact.
 */
const QuoteOut = z.looseObject({
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
/** A spread's short strike placed against SPX (`strikeDistances`, #297): what the strike strip
 *  draws. Shared with `/positions/values`, whose holdings carry the same list. */
export const StrikeDistanceOut = z.object({
  code: z.string(),
  option_type: z.enum(["CALL", "PUT"]),
  strike: z.number(),
  /** the leg's own delta from the same batch, or null where it served none */
  delta: z.number().nullable(),
  /** how far SPX has still to move to reach the strike: positive while it has not, negative by
   *  how far past. Null where there is no SPX, which `spx_reason` explains. */
  points: z.number().nullable(),
  /** `points` in σ to expiry, from the leg's own IV: points / (SPX × IV% / 100 × √(DTE / 365)).
   *  Null without points, an IV, or a day left to expiry. */
  sigma: z.number().nullable(),
});

const EntryOut = z.object({
  id: z.string(),
  code: z.string(),
  strike_date: z.string(),
  /** CALL or PUT, and CMB for a combo. Named here as well as on the entry because `.parse()`
   *  STRIPS what this object does not list: a field computed in the service and left out of the
   *  schema vanishes between the two with nothing failing. */
  option_type: z.string(),
  field: z.string(),
  threshold: z.number(),
  direction: z.string(),
  compare: z.string(),
  /** breaching NOW, by the figures in this same row. The engine's own verdict and its last value
   *  live on /monitors, which is what that endpoint is for (ADR 0010). */
  triggered: z.boolean(),
  quote: QuoteOut.nullable(),
  legs: z.array(z.object({
    sign: z.number(), option_type: z.string(), strike: z.number(),
  })).optional(),
  combo_value: z.number().nullable().optional(),
  combo_greeks: z.record(z.string(), z.number().nullable()).optional(),
  error: z.string().optional(),
  dte: z.number(),
  scope: z.string().nullable(),
  positions: z.array(z.object({ id: z.string(), name: z.string() })),
  /** whether any Contract this rule watches is a Leg of an OPEN holding, linked or not — a fact
   *  about Contracts, true on a roll day where `positions` names nothing, and true for a candidate
   *  sharing one Contract with a holding. What tells a risk alarm from an entry signal (ADR 0023). */
  held: z.boolean(),
  /** the ids of the combos in this watchlist whose legs include this row's Contract, sorted; empty
   *  on a combo's row. DISCOVERED from the legs each combo names, as `positions` is from what is
   *  held, and recorded nowhere: it is what sits a short leg's rule under its spread (ADR 0023). */
  in_combos: z.array(z.string()),
  cost_to_close: z.number().nullable(),
  /** the exit schedule, null where there is no single declared holding to schedule (ADR 0011) */
  schedule: z.object({
    dte_at_open: z.number(),
    /** the holding this schedule is FOR, so a client never has to infer it from `positions` */
    position_id: z.string(),
    on_pace: z.number().nullable(),
    pace_gap: z.number().nullable(),
    target: z.number().nullable(),
    stop: z.number().nullable(),
    target_dte: z.number().nullable(),
    manage_by_dte: z.number(),
    /** which Level the Cost to close has reached, null for neither (CONTEXT.md: Level) */
    reached: z.enum(["target", "stop"]).nullable(),
    manage_by_due: z.boolean(),
  }).nullable(),
  entry: z.number().nullable(),
  pnl: z.number().nullable(),
  fill: z.number().nullable(),
  /** the figure this row is about: the one reading `fill` and `triggered` are drawn from, raw and
   *  SIGNED — under compare "abs" those measure its magnitude. Null where it was not priced, or
   *  where JSON cannot write it; an infinite reading still rings. */
  watched: z.number().nullable(),
  /** how far `watched` has still to move to breach, in the field's own units: wherever it is a
   *  number, at or below zero exactly when `triggered`, and negative by how far past. Null
   *  wherever `watched` is, which says nothing about the bell. */
  distance: z.number().nullable(),
  /** SPX's price as this response's one batch implies it, from its options' premiums (ADR 0024):
   *  the same on every row. Null where the batch cannot give it, never a Reference's figure. */
  spx: z.number().nullable(),
  /** why `spx` is null, in words; null when there is a figure */
  spx_reason: z.string().nullable(),
  /** a combo's short legs placed against `spx` (#297); empty for a single contract */
  short_strikes: z.array(StrikeDistanceOut),
});

const quotes = documented("Live quotes for the whole watchlist", { 200: z.array(EntryOut) }, [502]);

/** `/quotes` — a live call for the whole watchlist, and the DASHBOARD is its main caller: one
 *  batch per poll per open tab, which is what makes polling faster cost something (ADR 0010). The
 *  bot's `/quotes`, `/greeks` and `/vol` answer the same question but go straight to
 *  `watchlistQuotes` rather than through this route. */
export function quoteRoutes(deps: Deps) {
  return new Hono().get("/quotes", quotes, async (c) => {
    try {
      return quotes.reply(c, 200,
        await watchlistQuotes(deps.db, deps.settings.displayTz, deps.provider.fetchQuotes, {
          includeCombos: true,
          now: deps.now(),
          policy: exitPolicy(deps.settings),
        }),
      );
    } catch (err) {
      throw providerFailed(deps.provider.name, err);
    }
  });
}
