/** The positions table: what is actually held.
 *
 *  A Position exists whether or not anything watches it, and nothing in this service deletes one
 *  as a side effect (ADR 0001) — which is why there is no "delete the positions of" anything
 *  here, only a delete by id that a route asks for explicitly.
 */
import type { DatabaseSync } from "node:sqlite";

import type { PositionRow } from "../rows.ts";
import { insertRow, row, rows, updateFields } from "./sql.ts";

/** Every position, in the order the dashboard lists them: expiry groups, then name.
 *
 *  One function, not two. There were briefly two with identical SQL — one for the listing route
 *  and one for the linkage code that does not care about order — and the duplicate hid a
 *  mutation: breaking the order in one left the other intact, so no test noticed. */
export function listPositions(db: DatabaseSync): PositionRow[] {
  return rows<PositionRow>(db, "select * from positions order by strike_date, name");
}

/** The positions still HELD — every one not closed — in the same order.
 *
 *  Not the duplicate `listPositions`'s comment warns about: the two differ in what they answer, not
 *  only in how. A closed holding is kept with its history (ADR 0022), so everything that asks
 *  "what do I hold right now" — the sweep's batch and its samples, the valuation, a rule looking
 *  for the holding it watches — must ask this, and only the listing asks for everything. */
export function openPositions(db: DatabaseSync): PositionRow[] {
  return rows<PositionRow>(
    db, "select * from positions where closed_on is null order by strike_date, name",
  );
}

export function findPosition(db: DatabaseSync, id: string): PositionRow | undefined {
  return row<PositionRow>(db, "select * from positions where id = ?", id);
}

export function findPositionByName(db: DatabaseSync, name: string): PositionRow | undefined {
  return row<PositionRow>(db, "select * from positions where name = ?", name);
}

export function insertPosition(db: DatabaseSync, value: PositionRow): PositionRow {
  insertRow(db, "positions", value);
  return findPosition(db, value.id)!;
}

export function updatePositionFields(
  db: DatabaseSync, id: string, changes: Partial<PositionRow>,
): PositionRow {
  updateFields<PositionRow>(db, "positions", id, changes);
  return findPosition(db, id)!;
}

export function deletePositionRow(db: DatabaseSync, id: string): void {
  db.prepare("delete from positions where id = ?").run(id);
}

export function setPositionEntry(db: DatabaseSync, id: string, entry: number): void {
  db.prepare("update positions set entry = ? where id = ?").run(entry, id);
}

/** Stamp a Position as having had its manage-by notice, so it is said once and not once a
 *  sweep. */
export function stampManageNotified(db: DatabaseSync, id: string, at: string): void {
  db.prepare("update positions set manage_notified_at = ? where id = ?").run(at, id);
}
