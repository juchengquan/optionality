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

import type { ConfigRow, ReportRow, RunRow, ScheduleRow } from "./rows.ts";

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
