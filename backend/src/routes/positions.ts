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
  clearPositionLinks, deletePositionRow, findPosition, findPositionByName, insertPosition,
  listPositions, updatePositionFields,
} from "../db/queries.ts";
import { atomic } from "../db/open.ts";
import type { PositionRow } from "../db/rows.ts";
import { toSqliteJson } from "../db/values.ts";
import { toSqlDatetime } from "../db/time.ts";
import { httpError, notFound } from "../errors.ts";
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
});

const PositionValues = PositionOut.extend({
  cost_to_close: z.number().nullable(),
  pnl: z.number().nullable(),
  contract_size: z.number().nullable(),
  greeks: z.record(z.string(), z.number().nullable()),
  fetched_at: z.string().nullable(),
});

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
  });

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
          };
        })),
        200,
      );
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
      return c.json(PositionOut.parse(out(updatePositionFields(db, id, changes))), 200);
    })

    .delete("/:id", async (c) => {
      const id = c.req.param("id");
      if (!findPosition(db, id)) throw notFound("position");
      // the same foreign-key fault the monitor side had: monitor_positions is a plain table, so the
      // links must go first or the DELETE is refused. Every Position in the live database is linked,
      // so this was broken for all of them (#71).
      //
      // The Monitors survive — nothing here deletes a rule as a side effect. They simply stop knowing
      // what they were watching, and would be adopted again if the holding came back.
      await atomic(db, () => {
        clearPositionLinks(db, id);
        deletePositionRow(db, id);
      });
      return c.body(null, 204);
    });
}
