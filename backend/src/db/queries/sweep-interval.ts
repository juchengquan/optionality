/** `sweep_interval`: the sweep's interval as the page set it, one row or none (#442, ADR 0025).
 *
 *  The one behaviour knob kept in the database. No row means `.env`'s MONITOR_INTERVAL_SECONDS, so
 *  "back to the default" is a delete rather than a row that names the default — a row naming 15
 *  would stay 15 after `.env` moved. What a stored value MEANS — a preset in force, or a hand-edit
 *  refused — is `sweep-interval.ts`'s, not this file's.
 */
import type { DatabaseSync } from "node:sqlite";

import type { SweepIntervalRow } from "../rows.ts";
import { row } from "./sql.ts";

export function readSweepInterval(db: DatabaseSync): SweepIntervalRow | undefined {
  return row<SweepIntervalRow>(db, "select * from sweep_interval where id = 1");
}

/** The page's choice, replacing any before it: the table holds one row at most. */
export function writeSweepInterval(db: DatabaseSync, seconds: number, setAt: string): void {
  db.prepare("insert or replace into sweep_interval (id, seconds, set_at) values (1, ?, ?)")
    .run(seconds, setAt);
}

/** Back to `.env`'s interval. */
export function clearSweepInterval(db: DatabaseSync): void {
  db.prepare("delete from sweep_interval").run();
}
