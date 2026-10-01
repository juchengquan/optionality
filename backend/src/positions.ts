/** Position operations that are more than a query (ADR 0009, phase 5). */
import type { DatabaseSync } from "node:sqlite";

import { monitorLegCodes } from "./domain/monitor.ts";
import { positionsHolding } from "./domain/position.ts";
import {
  linkMonitorToPositions, listPositions, orphanMonitors, setMonitorScope,
} from "./db/queries.ts";
import { toMonitor, toPosition } from "./hydrate.ts";

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
  const positions = listPositions(db).map(toPosition);
  for (const row of orphans) {
    const monitor = toMonitor(row);
    const { found, scope } = positionsHolding(positions, monitorLegCodes(monitor));
    if (found.size === 0) continue;
    setMonitorScope(db, monitor.id, scope);
    linkMonitorToPositions(db, monitor.id, [...found]);
  }
}
