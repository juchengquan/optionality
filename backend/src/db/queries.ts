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
import type {
  ConfigRow, MonitorRow, PositionRow, ReportRow, RunRow, ScheduleRow,
} from "./rows.ts";

export function listConfigs(db: DatabaseSync): ConfigRow[] {
  return db.prepare("select * from configs order by name").all() as unknown as ConfigRow[];
}

export function findConfig(db: DatabaseSync, name: string): ConfigRow | undefined {
  return db.prepare("select * from configs where name = ?").get(name) as unknown as ConfigRow | undefined;
}

export function insertConfig(
  db: DatabaseSync, row: Pick<ConfigRow, "name" | "task_type" | "body" | "created_at" | "updated_at">,
): ConfigRow {
  db.prepare(
    "insert into configs (name, task_type, body, created_at, updated_at) values (?, ?, ?, ?, ?)",
  ).run(row.name, row.task_type, row.body, row.created_at, row.updated_at);
  return findConfig(db, row.name)!;
}

export function updateConfig(
  db: DatabaseSync, name: string, taskType: string, body: string, updatedAt: string,
): ConfigRow {
  db.prepare("update configs set task_type = ?, body = ?, updated_at = ? where name = ?")
    .run(taskType, body, updatedAt, name);
  return findConfig(db, name)!;
}

export function deleteConfig(db: DatabaseSync, name: string): void {
  db.prepare("delete from configs where name = ?").run(name);
}

export function schedulesUsingConfig(db: DatabaseSync, name: string): number {
  return (db.prepare("select count(*) n from schedules where config_name = ?").get(name) as { n: number }).n;
}

export function listSchedules(db: DatabaseSync): ScheduleRow[] {
  return db.prepare("select * from schedules order by id").all() as unknown as ScheduleRow[];
}

export function findSchedule(db: DatabaseSync, id: number): ScheduleRow | undefined {
  return db.prepare("select * from schedules where id = ?").get(id) as unknown as ScheduleRow | undefined;
}

export function insertSchedule(
  db: DatabaseSync, row: Omit<ScheduleRow, "id">,
): ScheduleRow {
  const info = db.prepare(
    "insert into schedules (cron_expr, tz, task_type, config_name, enabled) values (?, ?, ?, ?, ?)",
  ).run(row.cron_expr, row.tz, row.task_type, row.config_name, row.enabled);
  return findSchedule(db, Number(info.lastInsertRowid))!;
}

export function updateSchedule(db: DatabaseSync, id: number, row: Omit<ScheduleRow, "id">): ScheduleRow {
  db.prepare(
    "update schedules set cron_expr = ?, tz = ?, task_type = ?, config_name = ?, enabled = ? where id = ?",
  ).run(row.cron_expr, row.tz, row.task_type, row.config_name, row.enabled, id);
  return findSchedule(db, id)!;
}

export function deleteSchedule(db: DatabaseSync, id: number): void {
  db.prepare("delete from schedules where id = ?").run(id);
}

export interface RunFilter {
  status?: string | undefined;
  limit: number;
}

export function listRuns(db: DatabaseSync, filter: RunFilter): RunRow[] {
  const where = filter.status ? "where status = ?" : "";
  const sql = `select * from runs ${where} order by created_at desc limit ?`;
  const params = filter.status ? [filter.status, filter.limit] : [filter.limit];
  return db.prepare(sql).all(...params) as unknown as RunRow[];
}

export function findRun(db: DatabaseSync, id: string): RunRow | undefined {
  return db.prepare("select * from runs where id = ?").get(id) as unknown as RunRow | undefined;
}

/** The newest run, for /health's `last_run`. */
export function latestRun(db: DatabaseSync): RunRow | undefined {
  return db.prepare("select * from runs order by created_at desc limit 1").get() as unknown as RunRow | undefined;
}

export function findReport(db: DatabaseSync, runId: string): ReportRow | undefined {
  return db.prepare("select * from reports where run_id = ?").get(runId) as unknown as ReportRow | undefined;
}

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

export function setMonitorScope(db: DatabaseSync, id: string, scope: string | null): void {
  db.prepare("update monitors set scope = ? where id = ?").run(scope, id);
}

export function insertRun(db: DatabaseSync, row: RunRow): RunRow {
  const columns = COLUMNS.runs;
  db.prepare(
    `insert into runs (${columns.map((c) => `"${c}"`).join(", ")})
     values (${columns.map(() => "?").join(", ")})`,
  ).run(...columns.map((c) => row[c] as never));
  return findRun(db, row.id)!;
}

export function updateRunFields(db: DatabaseSync, id: string, changes: Partial<RunRow>): void {
  const keys = Object.keys(changes) as (keyof RunRow)[];
  if (keys.length === 0) return;
  db.prepare(`update runs set ${keys.map((k) => `"${k}" = ?`).join(", ")} where id = ?`)
    .run(...keys.map((k) => changes[k] as never), id);
}

export function insertReport(db: DatabaseSync, row: ReportRow): void {
  db.prepare("insert into reports (run_id, summary, html, created_at) values (?, ?, ?, ?)")
    .run(row.run_id, row.summary, row.html, row.created_at);
}
