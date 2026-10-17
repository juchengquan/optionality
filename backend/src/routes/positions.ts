/** `/positions` — what is actually held, as distinct from what is watched (ADR 0009, phase 5).
 *
 *  A Position is a holding: it exists whether or not anything watches it, and deleting an alarm must
 *  never delete the record of what you own (ADR 0001). That asymmetry is the whole reason legs live
 *  here and not on a Monitor.
 */
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";

import { POSITION_GREEK_FIELDS, contractSize, costToClose, positionGreek, positionLegCodes, positionPnl } from "../domain/position.ts";
import type { Deps } from "../deps.ts";
import {
  clearPositionLinks, clearPositionSamples, clearScopeOfOrphans, deletePositionRow, findPosition,
  findPositionByName, insertPosition,
  listPositionSamples, listPositions, updatePositionFields,
} from "../db/queries.ts";
import { atomic } from "../db/open.ts";
import type { PositionRow } from "../db/rows.ts";
import { toSqliteJson } from "../db/values.ts";
import { toSqlDatetime } from "../db/time.ts";
import { httpError, notFound } from "../errors.ts";
import { dteAtOpen, exitLevels } from "../domain/exit.ts";
import { volAttribution, type VolSample } from "../domain/vol.ts";
import { daysToExpiry } from "../domain/expiry.ts";
import type { Settings } from "../env.ts";
import { toPosition } from "../hydrate.ts";
import { adoptOrphanMonitors } from "../positions.ts";
import { displayRecords, fetchResilient, verifyContracts } from "../quotes.ts";
import { DEFAULT_CONTRACTS, PositionIn, PositionPatch } from "../schemas/position.ts";
import { displayStored, displayTime } from "../timefmt.ts";
import { valid } from "../validate.ts";

const LegOut = z.object({
  side: z.string(), option_type: z.string(), strike: z.number(),
});

const PositionOut = z.object({
  id: z.string(),
  name: z.string(),
  strategy: z.string().nullable(),
  strike_date: z.string(),
  contracts: z.number(),
  entry: z.number().nullable(),
  legs: z.array(LegOut),
  created_at: z.string().nullable(),
  /** the day it was PUT ON, which created_at is not. Null until declared (ADR 0011). */
  opened_at: z.string().nullable(),
});

/** The exit schedule, or null for a Position whose Opened nobody has declared — which is the
 *  opt-in, because nothing is inferred from created_at (ADR 0011). */
const ScheduleOut = z.object({
  dte_at_open: z.number(),
  on_pace: z.number().nullable(),
  pace_gap: z.number().nullable(),
  target: z.number().nullable(),
  stop: z.number().nullable(),
  target_dte: z.number().nullable(),
  manage_by_dte: z.number(),
  /** which Level the Cost to close has reached, null for neither (CONTEXT.md: Level) */
  reached: z.enum(["target", "stop"]).nullable(),
  manage_by_due: z.boolean(),
}).nullable();

const PositionValues = PositionOut.extend({
  cost_to_close: z.number().nullable(),
  pnl: z.number().nullable(),
  contract_size: z.number().nullable(),
  greeks: z.record(z.string(), z.number().nullable()),
  fetched_at: z.string().nullable(),
  /** days left where the option trades, the same reckoning the dashboard's column uses */
  dte: z.number(),
  schedule: ScheduleOut,
});

/** What of a pace gap vol accounts for, measured over this holding's own samples — every field
 *  null together where the chain is not whole enough to say (ADR 0011). */
const VolOut = z.object({
  vol: z.number().nullable(),
  from: z.string().nullable(),
  to: z.string().nullable(),
  days: z.number().nullable(),
});

/** The schedule for one stored Position, or null if its Opened was never declared.
 *
 *  Assembled here rather than in the domain because it is the one place that has the row, the
 *  live Cost to close and the policy at once; `domain/exit.ts` holds the arithmetic and knows
 *  nothing about either.
 */
function scheduleFor(
  row: PositionRow, cost: number | null, now: Date, settings: Settings,
): z.input<typeof ScheduleOut> {
  if (row.opened_at === null) return null;
  const openedDte = dteAtOpen(row.strike_date, row.opened_at);
  const levels = exitLevels(
    row.entry, openedDte, daysToExpiry(row.strike_date, now),
    {
      takeFraction: settings.exitTakeFraction,
      stopMultiple: settings.exitStopMultiple,
      manageByDte: settings.exitManageByDte,
    },
    cost,
  );
  return levels === null ? null : { dte_at_open: openedDte, ...levels };
}

/** uuid4().hex in the Python — 32 hex characters, which the column is sized for. */
const newId = () => randomUUID().replaceAll("-", "");

export function positionRoutes(deps: Deps) {
  const { db, settings } = deps;
  const tz = settings.displayTz;

  const out = (row: PositionRow) => ({
    id: row.id,
    name: row.name,
    strategy: row.strategy,
    strike_date: row.strike_date,
    contracts: row.contracts,
    entry: row.entry,
    legs: JSON.parse(row.legs) as unknown,
    created_at: displayStored(row.created_at, tz),
    // a plain date, NOT displayStored: created_at is an instant and converts to DISPLAY_TZ,
    // while Opened is the calendar day a trade was put on and has no time to convert
    opened_at: row.opened_at,
  });

  /** A stored JSON map, or null — including when it will not parse. Written by the sweeper and
   *  read here, so the two are the only places that know the encoding. */
  const parseMap = (text: string | null): Record<string, number> | null => {
    if (text === null) return null;
    try {
      const parsed: unknown = JSON.parse(text);
      // SHAPE only. A map holding a non-numeric reading used to give vol: NaN, which zod rejects,
      // so the route answered 500 where its own comment promises the figure costs nothing but
      // itself. That is fixed in volAttribution, which now requires every reading to be a finite
      // number — and a value check here as well was unobservable: a mutation sweep removed it and
      // nothing failed, because the domain guard catches the same values. One gate, where the rule
      // lives, rather than two where only one is tested.
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, number>)
        : null;
    } catch {
      return null;
    }
  };

  return new Hono()
    .get("/", (c) => c.json(z.array(PositionOut).parse(listPositions(db).map(out)), 200))

    /** Live cost to close, exposure and P&L for every position.
     *
     *  One bounded snapshot call for every leg of every position, deduped — a documented live-call
     *  exception, like `/quotes` (CLAUDE.md). */
    .get("/values", async (c) => {
      const rows = listPositions(db);
      if (rows.length === 0) return c.json([] as z.output<typeof PositionValues>[], 200);
      const positions = rows.map(toPosition);
      const codes = [...new Set(positions.flatMap((p) => positionLegCodes(p)))].sort();
      let byCode: Record<string, Record<string, unknown>>;
      const now = deps.now();
      try {
        const { records } = await fetchResilient(codes, deps.fetchQuotes);
        byCode = displayRecords(records, tz, now);
      } catch (err) {
        throw httpError(502, `OpenD call failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      const fetched = displayTime(now, tz);
      return c.json(
        z.array(PositionValues).parse(rows.map((row, i) => {
          const p = positions[i]!;
          return {
            ...out(row),
            cost_to_close: costToClose(p, byCode),
            pnl: positionPnl(p, byCode),
            contract_size: contractSize(byCode),
            greeks: Object.fromEntries(
              POSITION_GREEK_FIELDS.map((f) => [f, positionGreek(p, byCode, f)]),
            ),
            fetched_at: fetched,
            dte: daysToExpiry(row.strike_date, now),
            schedule: scheduleFor(row, costToClose(p, byCode), now, deps.settings),
          };
        })),
        200,
      );
    })

    /** What of this holding's pace gap vol accounts for (ADR 0011).
     *
     *  The ONLY route that reads history — every other figure in this service comes from one live
     *  batch. Separate from `/quotes` on purpose: the dashboard polls that every 15 seconds per
     *  open tab and this changes once a market day, so the detail sheet asks for it when opened.
     *
     *  The remainder is NOT returned, because it is not ours to compute: a caller subtracts this
     *  from the gap it is showing, which keeps the gap and the vol part from being measured
     *  against two different instants (ADR 0010).
     */
    .get("/:id/vol", (c) => {
      const id = c.req.param("id");
      const row = findPosition(db, id);
      if (!row) throw notFound("position");
      const samples: VolSample[] = listPositionSamples(db, id).map((s) => ({
        observed_on: s.observed_on,
        dte: s.dte,
        // a corrupt map costs the figure, never the request: the whole sheet would fail to load
        legs_iv: parseMap(s.legs_iv),
        legs_vega: parseMap(s.legs_vega),
      }));
      const a = volAttribution(samples, toPosition(row));
      return c.json(VolOut.parse(a ?? { vol: null, from: null, to: null, days: null }), 200);
    })

    .post("/", valid("json", PositionIn), async (c) => {
      const p = c.req.valid("json");
      if (findPositionByName(db, p.name)) {
        throw httpError(409, `position '${p.name}' already exists`);
      }
      const row: PositionRow = {
        id: newId(),
        name: p.name,
        strategy: p.strategy ?? null,
        strike_date: p.strike_date,
        contracts: p.contracts ?? DEFAULT_CONTRACTS,
        entry: p.entry ?? null,
        legs: toSqliteJson(p.legs),
        created_at: toSqlDatetime(deps.now()),
        opened_at: p.opened_at ?? null,
        manage_notified_at: null,
      };
      // strict gate, as for monitors: nothing enters the table unverified
      const codes = [...new Set(positionLegCodes(toPosition(row)))].sort();
      const error = await verifyContracts(codes, deps.fetchQuotes);
      if (error) throw httpError(422, error);

      const saved = await atomic(db, () => {
        const inserted = insertPosition(db, row);
        // a holding you have just recorded may be the one an existing rule was already watching
        adoptOrphanMonitors(db);
        return inserted;
      });
      return c.json(PositionOut.parse(out(saved)), 201);
    })

    /** Record what was taken in, after the fact. */
    .patch("/:id", valid("json", PositionPatch), (c) => {
      const given = c.req.valid("json");
      if (Object.keys(given).length === 0) throw httpError(422, "nothing to update");
      const id = c.req.param("id");
      if (!findPosition(db, id)) throw notFound("position");
      const changes: Partial<PositionRow> = {};
      if (given.entry !== undefined) changes.entry = given.entry;
      if (given.contracts !== undefined) changes.contracts = given.contracts;
      if (given.strategy !== undefined) changes.strategy = given.strategy;
      if (given.opened_at !== undefined) changes.opened_at = given.opened_at;
      return c.json(PositionOut.parse(out(updatePositionFields(db, id, changes))), 200);
    })

    .delete("/:id", async (c) => {
      const id = c.req.param("id");
      if (!findPosition(db, id)) throw notFound("position");
      // the same foreign-key fault the monitor side had: monitor_positions is a plain table, so the
      // links must go first or the DELETE is refused. Every Position in the live database is linked,
      // so this was broken for all of them (#71).
      //
      // `position_samples` is the THIRD time this key has bitten — #71 here, #81 in the sweep's
      // expiry path, and then ADR 0011 added a child table without touching this line, which made
      // DELETE refuse for every Position the moment the first sweep gave each of them a sample.
      // Adding a table that references this one means coming back here.
      //
      // The Monitors survive — nothing here deletes a rule as a side effect. They simply stop knowing
      // what they were watching, and would be adopted again if the holding came back. The samples do
      // NOT: they describe this holding and mean nothing without it.
      //
      // ...and then the rules this delete just orphaned get a chance at whatever is LEFT. A link is
      // otherwise only ever worked out when something is created, so a rule that lost its holding
      // here stayed orphaned for ever — reported from the live dashboard as `409 position
      // '1120_BS_7100' already exists`, on a rule showing no positions beside a holding that had an
      // entry and an opened date and covered its contracts exactly. The dashboard offered to create
      // the holding it already had, because nothing told it one was there.
      //
      // Safe by adoptOrphanMonitors's own design: it looks only at monitors with no link and only
      // ever adds. "What you already have cannot be taken away by something you subsequently hold"
      // — nor by something you subsequently drop. Inside the transaction, so a rule is never left
      // pointing at a row that is half gone.
      await atomic(db, () => {
        clearPositionLinks(db, id);
        clearPositionSamples(db, id);
        deletePositionRow(db, id);
        adoptOrphanMonitors(db);
        // ...and whatever adoption could not place stops claiming a scope it has no holding for.
        //
        // The ORDER does not matter, though the first spelling of this comment claimed it did —
        // a mutation sweep swapped the two lines and nothing failed, which is how the claim was
        // found. It cannot matter: clearing skips anything with a link, and adoption always sets
        // a scope explicitly on what it places, so each line only ever touches rows the other
        // leaves alone. The link guard is the load-bearing part, not the sequence.
        clearScopeOfOrphans(db);
      });
      return c.body(null, 204);
    });
}
