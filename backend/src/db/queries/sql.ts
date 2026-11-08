/** The three things every query in this directory was writing out by hand.
 *
 *  node:sqlite returns `unknown` from `get` and `all`, so every one of thirty-five queries ended
 *  in `as unknown as MonitorRow[]` — a double cast, repeated, that says nothing about the row and
 *  cannot be checked. And three inserts and two updates built the same column lists and
 *  placeholders from `COLUMNS`, differing only in the table name.
 *
 *  Collected here so that each aggregate's file is SQL and the reason for it, not boilerplate.
 *  The casts are no safer than they were — nothing can make them safe, because the shape comes
 *  from the database rather than from the compiler — but they are now in one place, named, and
 *  held to `schema.sql` by `rows.test.ts` rather than retyped per query.
 */
import type { DatabaseSync } from "node:sqlite";

import { COLUMNS, type TableName } from "../rows.ts";

/** Every row a statement answers with, as the row type the caller names.
 *
 *  The cast is the unavoidable one: node:sqlite hands back `unknown`, and what the columns
 *  actually are is `schema.sql`'s business. `rows.test.ts` is what ties the two together.
 */
export function rows<T>(db: DatabaseSync, sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...(params as never[])) as unknown as T[];
}

/** The first row, or undefined. */
export function row<T>(db: DatabaseSync, sql: string, ...params: unknown[]): T | undefined {
  return db.prepare(sql).get(...(params as never[])) as unknown as T | undefined;
}

/** Insert every column the schema declares, in its order.
 *
 *  Every column, not the ones that happen to be set: a row built by `blank()` carries all of
 *  them, and listing only the present keys would let a half-built row through as a row with
 *  defaults. The caller re-reads what it wrote, because SQLite applies the defaults.
 */
export function insertRow<T extends object>(db: DatabaseSync, table: TableName, value: T): void {
  const columns = COLUMNS[table];
  db.prepare(
    `insert into ${table} (${columns.map((c) => `"${c}"`).join(", ")})
     values (${columns.map(() => "?").join(", ")})`,
  ).run(...columns.map((c) => (value as Record<string, unknown>)[c] as never));
}

/** Update the named columns of one row by id, and say whether anything was written.
 *
 *  The caller decides which columns, because PATCH changes only what it was given. False for an
 *  empty change set rather than a statement with no assignments, which SQLite rejects — and the
 *  callers use the answer to skip a pointless re-read.
 */
export function updateFields<T extends object>(
  db: DatabaseSync, table: TableName, id: string, changes: Partial<T>,
): boolean {
  const keys = Object.keys(changes);
  if (keys.length === 0) return false;
  db.prepare(`update ${table} set ${keys.map((k) => `"${k}" = ?`).join(", ")} where id = ?`)
    .run(...keys.map((k) => (changes as Record<string, unknown>)[k] as never), id);
  return true;
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
