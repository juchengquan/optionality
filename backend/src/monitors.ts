/** Monitor operations that are more than a query (ADR 0009, phase 5).
 *
 *  Ported from the non-sweeper half of monitor.py. The sweeper itself is phase 6.
 */
import type { DatabaseSync } from "node:sqlite";

import { positionsHolding } from "./domain/position.ts";
import { atomic } from "./db/open.ts";
import {
  enabledMonitors, linkMonitorToPositions, listPositions, positionsForMonitor,
  positionsForMonitors, setPositionEntry, solelyWatchedPositions, updateMonitorFields,
} from "./db/queries.ts";
import { toMonitor, toPosition } from "./hydrate.ts";
import { displayRecords, fetchResilient, type QuoteFetcher } from "./quotes.ts";
import { buildEntries, codesFor, type MonitorForEntry, type WatchlistEntry } from "./watchlist.ts";
import type { Position } from "./domain/position.ts";

/** Attach a new Monitor to whatever Position already holds its contracts.
 *
 *  Without this a monitor created through the API is linked to nothing, and everything the Position
 *  work built — entry, P&L, the derived total — applies only to monitors that predate the migration
 *  which backfilled these rows. See positionsHolding for the two cases that deliberately link
 *  nothing: a contract nothing holds, and a contract something holds twice.
 */
export function linkToPositions(db: DatabaseSync, monitorId: string, contracts: string[]): void {
  const positions = listPositions(db).map(toPosition);
  const { found, scope } = positionsHolding(positions, contracts);
  if (found.size === 0) return;
  updateMonitorFields(db, monitorId, { scope });
  linkMonitorToPositions(db, monitorId, [...found]);
}

/** Record a credit taken in across everything a rule spans, by deriving the one wing that has no
 *  rule of its own — the one that cannot be edited directly.
 *
 *  Returns an error message, or null on success. The per-wing credits stay the single source of
 *  truth: the total is a way of REACHING them, not a second place to keep them, so the two can
 *  never disagree.
 */
export async function applyTotalEntry(
  db: DatabaseSync, monitorId: string, total: number,
): Promise<string | null> {
  const positions = positionsForMonitor(db, monitorId);
  if (positions.length === 0) return "no holdings attached to this rule";
  const editable = solelyWatchedPositions(db);
  const targets = positions.filter((p) => !editable.has(p.id));
  if (targets.length !== 1) {
    return targets.length === 0
      ? "every wing here has a rule of its own — set them individually"
      : `cannot split a total across ${targets.length} wings that have no rule of their own`;
  }
  const target = targets[0]!;
  const others = positions.filter((p) => p.id !== target.id).map((p) => p.entry);
  if (others.some((e) => e === null)) return "set the other wings' credits first";
  const rest = (others as number[]).reduce((a, b) => a + b, 0);
  // 4dp: a credit is quoted in points to two or three places, and rounding here is only to keep
  // float noise out of a figure the owner reads back
  await atomic(db, () => setPositionEntry(db, target.id, round4(total - rest)));
  return null;
}

function round4(value: number): number {
  return Number(value.toFixed(4));
}

/** A monitor row in the shape buildEntries needs — which no longer includes the engine's
 *  `triggered` or `last_value`. An entry describes the row as of the batch it is built from, and
 *  those two describe the last sweep (ADR 0010). */
export function forEntry(row: {
  id: string; code: string; strike_date: string; option_type: string; strike: number; field: string;
  threshold: number; direction: string; compare: string; legs: string | null; scope: string | null;
}): MonitorForEntry {
  return { ...toMonitor(row as never), scope: row.scope };
}

/** Live quotes for every enabled monitor — one call for the whole watchlist.
 *
 *  Used by the bot's `/quotes` family AND by the dashboard, which polls it. This comment said the
 *  opposite for as long as the route existed: that the dashboard rendered the sweeper's cached
 *  records instead. It never did — `MonitorSweeper.cachedQuotes` is that path and no route calls
 *  it. The owner ratified the live reading in ADR 0010, so a row's figures come from THIS call and
 *  its bell is derived from them rather than from the engine's stored verdict.
 */
export async function watchlistQuotes(
  db: DatabaseSync, displayTz: string, fetch: QuoteFetcher,
  options: { includeCombos?: boolean; now?: Date } = {},
): Promise<WatchlistEntry[]> {
  const rows = enabledMonitors(db, options.includeCombos ?? false);
  if (rows.length === 0) return [];
  const monitors = rows.map(forEntry);
  const ownedRows = positionsForMonitors(db, monitors.map((m) => m.id));
  const owned: Record<string, (Position & { id: string })[]> = Object.fromEntries(
    Object.entries(ownedRows).map(([id, ps]) => [id, ps.map(toPosition)]),
  );
  const now = options.now ?? new Date();
  const { records, bad } = await fetchResilient(codesFor(monitors, owned), fetch);
  return buildEntries({
    monitors,
    byCode: displayRecords(records, displayTz, now),
    bad: new Set(bad),
    owned,
    now,
  });
}
