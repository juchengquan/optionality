/** `monitor_positions`: which holdings each rule covers.
 *
 *  Its own file because it is its own table with its own hazard. SQLAlchemy never managed it and
 *  nothing manages it here either, so the links must be cleared before the row they point at is
 *  deleted or the foreign key refuses — inside the sweep, every sweep, which is how the alarm
 *  engine once stopped altogether (#70, #81). Every row in the live database is linked, so that
 *  is not a rare path.
 */
import type { DatabaseSync } from "node:sqlite";

import type { PositionRow } from "../rows.ts";

export function clearMonitorLinks(db: DatabaseSync, monitorId: string): void {
  db.prepare("delete from monitor_positions where monitor_id = ?").run(monitorId);
}

export function clearPositionLinks(db: DatabaseSync, positionId: string): void {
  db.prepare("delete from monitor_positions where position_id = ?").run(positionId);
}

export function linkMonitorToPositions(
  db: DatabaseSync, monitorId: string, positionIds: string[],
): void {
  const insert = db.prepare(
    "insert into monitor_positions (monitor_id, position_id) values (?, ?)",
  );
  for (const pid of [...positionIds].sort()) insert.run(monitorId, pid);
}

/** Which Positions each Monitor watches. A rule may span several — a combined stop over two
 *  credit spreads belongs to neither alone (ADR 0004).
 *
 *  One query for a batch of ids, because the list route asks about every monitor at once and a
 *  query per row is what made it slow enough to notice.
 */
export function positionsForMonitors(
  db: DatabaseSync, monitorIds: string[],
): Record<string, PositionRow[]> {
  if (monitorIds.length === 0) return {};
  const holes = monitorIds.map(() => "?").join(", ");
  const found = db.prepare(
    `select mp.monitor_id as monitor_id, p.* from monitor_positions mp
     join positions p on p.id = mp.position_id
     where mp.monitor_id in (${holes})
     order by p.name`,
  ).all(...(monitorIds as never[])) as unknown as (PositionRow & { monitor_id: string })[];
  const owned: Record<string, PositionRow[]> = {};
  for (const { monitor_id, ...position } of found) {
    (owned[monitor_id] ??= []).push(position as PositionRow);
  }
  return owned;
}

export function positionsForMonitor(db: DatabaseSync, monitorId: string): PositionRow[] {
  return positionsForMonitors(db, [monitorId])[monitorId] ?? [];
}

/** Positions that some whole-position rule watches ALONE, and which therefore have an entry field
 *  of their own.
 *
 *  A leg rule links to one Position too but offers no field, so counting it would wrongly mark
 *  that Position reachable — which is the difference between "set this wing's credit directly"
 *  and "it can only be reached by splitting a total". */
export function solelyWatchedPositions(db: DatabaseSync): Set<string> {
  const found = db.prepare(
    `select mp.position_id as position_id
     from monitor_positions mp
     join monitors m on m.id = mp.monitor_id
     where m.scope = 'all'
       and mp.monitor_id in (
         select monitor_id from monitor_positions group by monitor_id having count(position_id) = 1
       )`,
  ).all() as { position_id: string }[];
  return new Set(found.map((r) => r.position_id));
}
