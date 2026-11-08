/** The monitors table: the rules the alarm engine evaluates.
 *
 *  Links to Positions are in `links.ts` — they are a table of their own, and SQLite refuses to
 *  delete a linked monitor until they are cleared, which is a fact about that table rather than
 *  about this one.
 */
import type { DatabaseSync } from "node:sqlite";

import type { MonitorRow } from "../rows.ts";
import { insertRow, row, rows, updateFields } from "./sql.ts";

/** The watchlist's order: expiry groups, combos before single legs, then calls before puts, then
 *  strike. `legs is null` is 0 for a combo and 1 for a single leg, so ascending puts the combos
 *  first — which is what the dashboard shows and what the bot's tables print.
 *
 *  Two combos in the same expiry have no defined order between them, here or in the Python: both
 *  carry option_type 'CMB' and strike 0. */
const WATCHLIST_ORDER = "order by strike_date, legs is null, option_type, strike";

export function listMonitors(db: DatabaseSync): MonitorRow[] {
  return rows<MonitorRow>(db, `select * from monitors ${WATCHLIST_ORDER}`);
}

/** Enabled monitors only, for the live `/quotes` family. Combos are excluded unless asked for
 *  because the bot's narrower tables cannot render a signed sum in four columns. */
export function enabledMonitors(db: DatabaseSync, includeCombos: boolean): MonitorRow[] {
  const combos = includeCombos ? "" : "and legs is null";
  return rows<MonitorRow>(
    db, `select * from monitors where enabled = 1 ${combos} ${WATCHLIST_ORDER}`,
  );
}

export function findMonitor(db: DatabaseSync, id: string): MonitorRow | undefined {
  return row<MonitorRow>(db, "select * from monitors where id = ?", id);
}

/** The (code, field) pair is unique. `exceptId` is for an update, which must not conflict with
 *  itself. */
export function findMonitorByCodeField(
  db: DatabaseSync, code: string, field: string, exceptId?: string,
): MonitorRow | undefined {
  return exceptId
    ? row<MonitorRow>(
      db, "select * from monitors where code = ? and field = ? and id != ?", code, field, exceptId,
    )
    : row<MonitorRow>(db, "select * from monitors where code = ? and field = ?", code, field);
}

export function insertMonitor(db: DatabaseSync, value: MonitorRow): MonitorRow {
  insertRow(db, "monitors", value);
  // re-read, because the database applies the defaults for anything the row left unset
  return findMonitor(db, value.id)!;
}

/** Update named columns of a monitor. The caller decides which, because PATCH changes only what
 *  it was given and PUT replaces a fixed set. */
export function updateMonitorFields(
  db: DatabaseSync, id: string, changes: Partial<MonitorRow>,
): MonitorRow {
  updateFields<MonitorRow>(db, "monitors", id, changes);
  return findMonitor(db, id)!;
}

export function deleteMonitorRow(db: DatabaseSync, id: string): void {
  db.prepare("delete from monitors where id = ?").run(id);
}

/** Monitors with NO link at all. Deliberately not "monitors whose links look wrong": see
 *  adoptOrphanMonitors for why recomputing every link would be worse than the bug it fixed. */
export function orphanMonitors(db: DatabaseSync): MonitorRow[] {
  return rows<MonitorRow>(
    db, "select * from monitors where id not in (select monitor_id from monitor_positions)",
  );
}

/** Forget the scope of every monitor that no longer has a holding.
 *
 *  Scope says HOW a rule covers its holding — "all" the whole structure, "leg" part of one — so it
 *  is meaningless without one. Deleting a holding cleared the links and left the scope behind, and
 *  the live US.SPXW261120C8200000 read scope "leg" while holding nothing at all.
 *
 *  Only the link-less — which is what makes it safe beside adoptOrphanMonitors in either order,
 *  since adoption always sets a scope explicitly on what it places and so leaves nothing here to
 *  undo. Remove that guard and this wipes the scope of every monitor, holding or not. */
export function clearScopeOfOrphans(db: DatabaseSync): void {
  db.prepare(
    `update monitors set scope = null
     where scope is not null and id not in (select monitor_id from monitor_positions)`,
  ).run();
}

export function setMonitorScope(db: DatabaseSync, id: string, scope: string | null): void {
  db.prepare("update monitors set scope = ? where id = ?").run(scope, id);
}

/** Monitors a bot identifier might mean: the exact code, the joined-and-upcased form, an id
 *  prefix, or a short contract like `260918 C8100`.
 *
 *  Deliberately returns every match rather than the first. "Ambiguous" is an answer the owner can
 *  act on; silently picking one is how the wrong alarm gets deleted. */
export function findMonitorsByIdentifier(
  db: DatabaseSync, token: string, joined: string, expandedCode: string | null,
): MonitorRow[] {
  const clauses = ["code = ?", "code = ?", "id like ?"];
  const params: unknown[] = [joined, token, `${token}%`];
  if (expandedCode) {
    clauses.push("code = ?");
    params.push(expandedCode);
  }
  return rows<MonitorRow>(db, `select * from monitors where ${clauses.join(" or ")}`, ...params);
}

export function findComboByName(db: DatabaseSync, name: string): MonitorRow | undefined {
  return row<MonitorRow>(db, "select * from monitors where code = ? and legs is not null", name);
}
