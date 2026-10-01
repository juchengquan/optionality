/** Stored rows into the shapes the domain works in (ADR 0009, phase 5).
 *
 *  The split is deliberate: a row holds `legs` as JSON text and `enabled` as 0 or 1, because that is
 *  what SQLite holds and what the Python wrote. The domain holds parsed legs and real booleans. One
 *  of the two has to be converted, and doing it here means no row type ever claims to be something
 *  it is not and no domain function ever parses JSON.
 */
import type { Leg, Position } from "./domain/position.ts";
import type { Monitor, MonitorLeg } from "./domain/monitor.ts";
import { fromSqliteJson } from "./db/values.ts";
import type { MonitorRow, PositionRow } from "./db/rows.ts";

export function toMonitor(row: MonitorRow): Monitor & { id: string } {
  return {
    id: row.id,
    code: row.code,
    strike_date: row.strike_date,
    option_type: row.option_type,
    strike: row.strike,
    field: row.field,
    threshold: row.threshold,
    direction: row.direction,
    compare: row.compare,
    legs: fromSqliteJson<MonitorLeg[]>(row.legs),
  };
}

export function toPosition(row: PositionRow): Position & { id: string } {
  return {
    id: row.id,
    name: row.name,
    strategy: row.strategy,
    strike_date: row.strike_date,
    contracts: row.contracts,
    entry: row.entry,
    legs: fromSqliteJson<Leg[]>(row.legs) ?? [],
  };
}
