/** Monitor operations that are more than a query (ADR 0009, phase 5).
 *
 *  Ported from the non-sweeper half of monitor.py; the sweeper itself is `sweeper.ts`.
 */
import type { DatabaseSync } from "node:sqlite";

import { positionsHolding } from "optionality/domain/position";
import { monitorLegCodes } from "optionality/domain/monitor";
import { round4 } from "optionality/domain/quote";
import { atomic } from "./db/open.ts";
import {
  enabledMonitors, linkMonitorToPositions, openPositions, orphanMonitors, positionsForMonitor,
  positionsForMonitors, setMonitorScope, setPositionEntry, solelyWatchedPositions,
  updateMonitorFields,
} from "./db/queries/index.ts";
import { toMonitor, toPosition } from "./hydrate.ts";
import type { MonitorRow } from "./db/rows.ts";
import { displayRecords, type QuoteFetcher } from "optionality/quotes";
import type { ExitPolicy } from "optionality/domain/exit";
import { buildEntries, codesFor, type MonitorForEntry, type WatchlistEntry } from "./watchlist.ts";
import type { Position } from "optionality/domain/position";

/** The changes an edit writes, with the alarm state it must forget (#292).
 *
 *  `triggered` and `last_alarm_at` are the sweep's verdict on the rule AS IT WAS: the next sweep
 *  compares the new figure against that flag. Kept across a change of what the rule watches, its
 *  direction or its compare, a ringing rule edited onto a breach never said it crossed, and one
 *  edited off said "back below" about a rule that was never above. So a change that ACTUALLY
 *  differs from what is stored makes it a new rule, unrung. So does switching a rule that was off
 *  back on: muted while ringing, or off with its holding, it comes back as new. A threshold moved
 *  alone keeps the state, as it always has — the bell then flips at the new line on the next sweep.
 */
export function editedMonitor(row: MonitorRow, changes: Partial<MonitorRow>): Partial<MonitorRow> {
  const differs = (["field", "direction", "compare"] as const)
    .some((k) => changes[k] !== undefined && changes[k] !== row[k]);
  const reenabled = changes.enabled === 1 && row.enabled === 0;
  return differs || reenabled ? { ...changes, triggered: 0, last_alarm_at: null } : changes;
}

/** Attach a new Monitor to whatever Position already holds its contracts.
 *
 *  Without this a monitor created through the API is linked to nothing, and everything the Position
 *  work built — entry, P&L, the derived total — applies only to monitors that predate the migration
 *  which backfilled these rows. See positionsHolding for the two cases that deliberately link
 *  nothing: a contract nothing holds, and a contract something holds twice.
 */
export function linkToPositions(db: DatabaseSync, monitorId: string, contracts: string[]): void {
  // only what is still held: a rule watching a contract of a closed holding watches an option,
  // not a holding anyone has any more (ADR 0022)
  const positions = openPositions(db).map(toPosition);
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
  await atomic(db, () => setPositionEntry(db, target.id, round4(total - rest)));
  return null;
}

/** A monitor row in the shape buildEntries needs — which no longer includes the engine's
 *  `triggered` or `last_value`. An entry describes the row as of the batch it is built from, and
 *  those two describe the last sweep (ADR 0010). */
function forEntry(row: {
  id: string; code: string; strike_date: string; option_type: string; strike: number; field: string;
  threshold: number; direction: string; compare: string; legs: string | null; scope: string | null;
}): MonitorForEntry {
  return { ...toMonitor(row as never), scope: row.scope };
}

/** Live quotes for every enabled monitor — one call for the whole watchlist.
 *
 *  Used by the bot's `/quotes` family AND by the dashboard, which polls it. This comment said the
 *  opposite for as long as the route existed: that the dashboard rendered the sweeper's cached
 *  records instead. It never did, and the sweeper's cached view has since been deleted for exactly
 *  that reason. The owner ratified the live reading in ADR 0010, so a row's figures come from THIS
 *  call and its bell is derived from them rather than from the engine's stored verdict.
 */
export async function watchlistQuotes(
  db: DatabaseSync, displayTz: string, fetch: QuoteFetcher,
  /** no default: `policy` is required, so the compiler names any caller that would silently
   *  produce entries with no schedule (ADR 0011) */
  options: { includeCombos?: boolean; now?: Date; policy: ExitPolicy },
): Promise<WatchlistEntry[]> {
  const rows = enabledMonitors(db, options.includeCombos ?? false);
  if (rows.length === 0) return [];
  const monitors = rows.map(forEntry);
  const ownedRows = positionsForMonitors(db, monitors.map((m) => m.id));
  const owned: Record<string, (Position & { id: string })[]> = Object.fromEntries(
    Object.entries(ownedRows).map(([id, ps]) => [id, ps.map(toPosition)]),
  );
  const now = options.now ?? new Date();
  const { records, unknown } = await fetch(codesFor(monitors, owned));
  return buildEntries({
    monitors,
    byCode: displayRecords(records, displayTz, now),
    bad: new Set(unknown),
    owned,
    holdings: readableOpenPositions(db),
    now,
    policy: options.policy,
  });
}

/** Every OPEN holding that can be read, for whether a rule watches anything held.
 *
 *  It joins no batch — holding a Contract needs no quote — but it reads holdings no rule is
 *  linked to, so one that cannot be read costs its own Contracts and nothing else, as it does in
 *  the sweep: a watchlist that failed over a holding it never shows would be the larger harm. */
function readableOpenPositions(db: DatabaseSync): Position[] {
  const readable: Position[] = [];
  for (const row of openPositions(db)) {
    try {
      readable.push(toPosition(row));
    } catch (err) {
      console.warn(`cannot read position ${row.name}:`, err);
    }
  }
  return readable;
}

/** Link monitors that watch something now held, and never unlink anything.
 *
 *  The link is worked out when a thing is created, which handled only one order: position first,
 *  then monitor. Set the alarm before recording the holding and the monitor stayed orphaned for
 *  ever. This is the mirror image, so either order works.
 *
 *  It looks ONLY at monitors that have no link. The tempting alternative — recompute every link on a
 *  schedule — is worse than the bug: rolling a spread leaves the old and the new sharing a strike for
 *  a day, a recomputing job would call that contract ambiguous, and a monitor that had worked for
 *  weeks would silently lose its entry and P&L mid-session. What you already have cannot be taken
 *  away by something you subsequently hold.
 */
export function adoptOrphanMonitors(db: DatabaseSync): void {
  const orphans = orphanMonitors(db);
  if (orphans.length === 0) return;
  // never onto a closed holding: closing one is what ORPHANED the rules it took (ADR 0022), and
  // adopting them straight back would undo the close
  const positions = openPositions(db).map(toPosition);
  for (const row of orphans) {
    const monitor = toMonitor(row);
    const { found, scope } = positionsHolding(positions, monitorLegCodes(monitor));
    if (found.size === 0) continue;
    setMonitorScope(db, monitor.id, scope);
    linkMonitorToPositions(db, monitor.id, [...found]);
  }
}
