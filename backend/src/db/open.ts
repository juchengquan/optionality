/** Opening the database, and the schema it is created from (ADR 0009, phase 4).
 *
 *  node:sqlite directly, with no ORM: Hono has no dependencies and neither does this, so the
 *  backend has nothing to rebuild when Node moves. The alternative was Drizzle, which in its
 *  stable release cannot drive node:sqlite at all and in its 1.0 release candidate has a
 *  transaction method that commits before the callback has run. See ADR 0009.
 */
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = new URL("./schema.sql", import.meta.url);

/** Open an existing database for reading and writing, with the pragmas the Python sets.
 *
 *  Both pragmas matter. WAL is stored in the file; foreign_keys is NOT — it is per connection
 *  and defaults to OFF, so a connection that forgets it turns a missed `monitor_positions`
 *  cleanup into a silent orphan instead of an error. That is how three bugs got in (#70-#72).
 */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  return db;
}

/** Open a database without the ability to write to it, for reading the Python's file. */
export function openReadOnly(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly: true });
  db.exec("PRAGMA foreign_keys=ON");
  return db;
}

/** Create the tables. Safe to call on a database that already has them only if it is empty. */
export function applySchema(db: DatabaseSync): void {
  db.exec(readFileSync(SCHEMA, "utf8"));
}

/** A new database with the schema applied. Used by the copy and by every test. */
export function createDatabase(path: string): DatabaseSync {
  const db = openDatabase(path);
  applySchema(db);
  return db;
}

/** Run `fn` inside a transaction, rolling back if it throws.
 *
 *  Written out rather than taken from a library because this is the operation the delete paths
 *  depend on: clearing `monitor_positions` and removing the row it pointed at have to happen
 *  together or not at all. `exec` is used instead of `prepare` so that BEGIN cannot be left
 *  dangling by a statement cache.
 */
export async function atomic<T>(db: DatabaseSync, fn: () => T | Promise<T>): Promise<T> {
  db.exec("BEGIN");
  try {
    const out = await fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
