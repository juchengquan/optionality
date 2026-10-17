/** The SQL the HTTP layer runs (ADR 0009, phase 5).
 *
 *  Hand-written because there is no ORM: node:sqlite directly, so nothing to rebuild when Node
 *  moves. Gathered here rather than inside the handlers so that the statements are greppable and
 *  the routes stay about HTTP.
 *
 *  Every write that touches more than one row goes through `atomic` from open.ts. Reading is
 *  cheap and uncoordinated; writing is not.
 */
import type { DatabaseSync } from "node:sqlite";

import { COLUMNS } from "./rows.ts";
import type { MonitorRow, PositionRow, PositionSampleRow } from "./rows.ts";

/** Whether the database answers at all — /health reports rather than raising. */
export function databaseResponds(db: DatabaseSync): boolean {
  try {
    db.prepare("select 1").get();
    return true;
  } catch {
    return false;
  }
}

/** The watchlist's order: expiry groups, combos before single legs, then calls before puts, then
 *  strike. `legs is null` is 0 for a combo and 1 for a single leg, so ascending puts the combos
 *  first — which is what the dashboard shows and what the bot's tables print.
 *
 *  Two combos in the same expiry have no defined order between them, here or in the Python: both
 *  carry option_type 'CMB' and strike 0. */
const WATCHLIST_ORDER = "order by strike_date, legs is null, option_type, strike";

export function listMonitors(db: DatabaseSync): MonitorRow[] {
  return db.prepare(`select * from monitors ${WATCHLIST_ORDER}`).all() as unknown as MonitorRow[];
}

/** Enabled monitors only, for the live `/quotes` family. Combos are excluded unless asked for
 *  because the bot's narrower tables cannot render a signed sum in four columns. */
export function enabledMonitors(db: DatabaseSync, includeCombos: boolean): MonitorRow[] {
  const combos = includeCombos ? "" : "and legs is null";
  return db.prepare(`select * from monitors where enabled = 1 ${combos} ${WATCHLIST_ORDER}`)
    .all() as unknown as MonitorRow[];
}

export function findMonitor(db: DatabaseSync, id: string): MonitorRow | undefined {
  return db.prepare("select * from monitors where id = ?").get(id) as unknown as MonitorRow | undefined;
}

/** The (code, field) pair is unique. `exceptId` is for an update, which must not conflict with
 *  itself. */
export function findMonitorByCodeField(
  db: DatabaseSync, code: string, field: string, exceptId?: string,
): MonitorRow | undefined {
  const sql = exceptId
    ? "select * from monitors where code = ? and field = ? and id != ?"
    : "select * from monitors where code = ? and field = ?";
  const params = exceptId ? [code, field, exceptId] : [code, field];
  return db.prepare(sql).get(...params) as unknown as MonitorRow | undefined;
}

export function insertMonitor(db: DatabaseSync, row: MonitorRow): MonitorRow {
  const columns = COLUMNS.monitors;
  db.prepare(
    `insert into monitors (${columns.map((c) => `"${c}"`).join(", ")})
     values (${columns.map(() => "?").join(", ")})`,
  ).run(...columns.map((c) => row[c] as never));
  return findMonitor(db, row.id)!;
}

/** Update named columns of a monitor. The caller decides which, because PATCH changes only what it
 *  was given and PUT replaces a fixed set. */
export function updateMonitorFields(
  db: DatabaseSync, id: string, changes: Partial<MonitorRow>,
): MonitorRow {
  const keys = Object.keys(changes) as (keyof MonitorRow)[];
  if (keys.length === 0) return findMonitor(db, id)!;
  db.prepare(`update monitors set ${keys.map((k) => `"${k}" = ?`).join(", ")} where id = ?`)
    .run(...keys.map((k) => changes[k] as never), id);
  return findMonitor(db, id)!;
}

export function deleteMonitorRow(db: DatabaseSync, id: string): void {
  db.prepare("delete from monitors where id = ?").run(id);
}

export function clearMonitorLinks(db: DatabaseSync, monitorId: string): void {
  db.prepare("delete from monitor_positions where monitor_id = ?").run(monitorId);
}

export function linkMonitorToPositions(
  db: DatabaseSync, monitorId: string, positionIds: string[],
): void {
  const insert = db.prepare("insert into monitor_positions (monitor_id, position_id) values (?, ?)");
  for (const pid of [...positionIds].sort()) insert.run(monitorId, pid);
}

/** Every position, in the order the dashboard lists them: expiry groups, then name.
 *
 *  One function, not two. There were briefly two with identical SQL — one for the listing route and
 *  one for the linkage code that does not care about order — and the duplicate hid a mutation:
 *  breaking the order in one left the other intact, so no test noticed. */
export function listPositions(db: DatabaseSync): PositionRow[] {
  return db.prepare("select * from positions order by strike_date, name")
    .all() as unknown as PositionRow[];
}

/** Which Positions each Monitor watches. A rule may span several — a combined stop over two credit
 *  spreads belongs to neither alone (ADR 0004). */
export function positionsForMonitors(
  db: DatabaseSync, monitorIds: string[],
): Record<string, PositionRow[]> {
  if (monitorIds.length === 0) return {};
  const holes = monitorIds.map(() => "?").join(", ");
  const rows = db.prepare(
    `select mp.monitor_id as monitor_id, p.* from monitor_positions mp
     join positions p on p.id = mp.position_id
     where mp.monitor_id in (${holes})
     order by p.name`,
  ).all(...monitorIds) as unknown as (PositionRow & { monitor_id: string })[];
  const owned: Record<string, PositionRow[]> = {};
  for (const { monitor_id, ...position } of rows) {
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
 *  A leg rule links to one Position too but offers no field, so counting it would wrongly mark that
 *  Position reachable — which is the difference between "set this wing's credit directly" and "it
 *  can only be reached by splitting a total". */
export function solelyWatchedPositions(db: DatabaseSync): Set<string> {
  const rows = db.prepare(
    `select mp.position_id as position_id
     from monitor_positions mp
     join monitors m on m.id = mp.monitor_id
     where m.scope = 'all'
       and mp.monitor_id in (
         select monitor_id from monitor_positions group by monitor_id having count(position_id) = 1
       )`,
  ).all() as { position_id: string }[];
  return new Set(rows.map((r) => r.position_id));
}

export function setPositionEntry(db: DatabaseSync, id: string, entry: number): void {
  db.prepare("update positions set entry = ? where id = ?").run(entry, id);
}

export function findPosition(db: DatabaseSync, id: string): PositionRow | undefined {
  return db.prepare("select * from positions where id = ?").get(id) as unknown as PositionRow | undefined;
}

export function findPositionByName(db: DatabaseSync, name: string): PositionRow | undefined {
  return db.prepare("select * from positions where name = ?").get(name) as unknown as PositionRow | undefined;
}

export function insertPosition(db: DatabaseSync, row: PositionRow): PositionRow {
  const columns = COLUMNS.positions;
  db.prepare(
    `insert into positions (${columns.map((c) => `"${c}"`).join(", ")})
     values (${columns.map(() => "?").join(", ")})`,
  ).run(...columns.map((c) => row[c] as never));
  return findPosition(db, row.id)!;
}

export function updatePositionFields(
  db: DatabaseSync, id: string, changes: Partial<PositionRow>,
): PositionRow {
  const keys = Object.keys(changes) as (keyof PositionRow)[];
  if (keys.length === 0) return findPosition(db, id)!;
  db.prepare(`update positions set ${keys.map((k) => `"${k}" = ?`).join(", ")} where id = ?`)
    .run(...keys.map((k) => changes[k] as never), id);
  return findPosition(db, id)!;
}

export function deletePositionRow(db: DatabaseSync, id: string): void {
  db.prepare("delete from positions where id = ?").run(id);
}

export function clearPositionLinks(db: DatabaseSync, positionId: string): void {
  db.prepare("delete from monitor_positions where position_id = ?").run(positionId);
}

/** Monitors with NO link at all. Deliberately not "monitors whose links look wrong": see
 *  adoptOrphanMonitors for why recomputing every link would be worse than the bug it fixed. */
export function orphanMonitors(db: DatabaseSync): MonitorRow[] {
  return db.prepare(
    "select * from monitors where id not in (select monitor_id from monitor_positions)",
  ).all() as unknown as MonitorRow[];
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

/** Every observation recorded for a Position. They belong to the holding — the foreign key says
 *  so — and a series of what-this-was-worth means nothing once the holding is gone. */
export function clearPositionSamples(db: DatabaseSync, id: string): void {
  db.prepare("delete from position_samples where position_id = ?").run(id);
}

/** Every sample for one Position, oldest first — the order a day-by-day measurement needs. */
export function listPositionSamples(db: DatabaseSync, id: string): PositionSampleRow[] {
  return db.prepare(
    "select * from position_samples where position_id = ? order by observed_on",
  ).all(id) as unknown as PositionSampleRow[];
}

/** Stamp a Position as having had its manage-by notice, so it is said once and not once a
 *  minute. The sweep runs every minute. */
export function stampManageNotified(db: DatabaseSync, id: string, at: string): void {
  db.prepare("update positions set manage_notified_at = ? where id = ?").run(at, id);
}

/** One observation of a Position's Cost to close, keyed on the market day (ADR 0011).
 *
 *  REPLACE, not IGNORE: the sweep runs every minute and the row should converge on the settled
 *  mark, so the last write of a market day is the one that stays. */
export function recordPositionSample(db: DatabaseSync, row: PositionSampleRow): void {
  db.prepare(
    `insert or replace into position_samples
       (position_id, observed_on, dte, cost_to_close, legs_iv, legs_vega)
     values (?, ?, ?, ?, ?, ?)`,
  ).run(
    row.position_id, row.observed_on, row.dte, row.cost_to_close, row.legs_iv, row.legs_vega,
  );
}

/** The sample already stored for this Position on this market day, if any.
 *
 *  Read so the sampler can decline to write the same row again. It wrote on every sweep — 5,760
 *  times a day at a 15-second interval, to persist one row — and overnight almost all of those
 *  stored a value identical to the one already there. */
export function findPositionSample(
  db: DatabaseSync, positionId: string, observedOn: string,
): PositionSampleRow | undefined {
  return db.prepare(
    "select * from position_samples where position_id = ? and observed_on = ?",
  ).get(positionId, observedOn) as unknown as PositionSampleRow | undefined;
}

/** Monitors a bot identifier might mean: the exact code, the joined-and-upcased form, an id prefix, or
 *  a short contract like `260918 C8100`.
 *
 *  Deliberately returns every match rather than the first. "Ambiguous" is an answer the owner can act
 *  on; silently picking one is how the wrong alarm gets deleted. */
export function findMonitorsByIdentifier(
  db: DatabaseSync, token: string, joined: string, expandedCode: string | null,
): MonitorRow[] {
  const clauses = ["code = ?", "code = ?", "id like ?"];
  const params: unknown[] = [joined, token, `${token}%`];
  if (expandedCode) {
    clauses.push("code = ?");
    params.push(expandedCode);
  }
  return db.prepare(`select * from monitors where ${clauses.join(" or ")}`)
    .all(...(params as never[])) as unknown as MonitorRow[];
}

export function findComboByName(db: DatabaseSync, name: string): MonitorRow | undefined {
  return db.prepare("select * from monitors where code = ? and legs is not null").get(name) as
    unknown as MonitorRow | undefined;
}
