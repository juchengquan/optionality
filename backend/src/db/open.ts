/** Opening the database, and the schema it is created from (ADR 0009, phase 4).
 *
 *  node:sqlite directly, with no ORM: Hono has no dependencies and neither does this, so the
 *  backend has nothing to rebuild when Node moves. The alternative was Drizzle, which in its
 *  stable release cannot drive node:sqlite at all and in its 1.0 release candidate has a
 *  transaction method that commits before the callback has run. See ADR 0009.
 */
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { stampAll } from "./migrate.ts";

/** `schema/schema.sql` at the repository root, for the reason `migrate.ts` gives its migrations:
 *  one schema that either backend builds a database from (ADR 0021), resolved from this module. */
const SCHEMA = new URL("../../../schema/schema.sql", import.meta.url);

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

/** Create the tables. Safe to call on a database that already has them only if it is empty. */
export function applySchema(db: DatabaseSync): void {
  db.exec(readFileSync(SCHEMA, "utf8"));
}

/** A new database with the schema applied. Used by the copy and by every test.
 *
 *  Stamped, not migrated: schema.sql carries the current shape, so every migration's effect is
 *  already present and applying one would fail on a duplicate column. See db/migrate.ts. */
export function createDatabase(path: string): DatabaseSync {
  const db = openDatabase(path);
  applySchema(db);
  stampAll(db);
  return db;
}

/** Run `fn` inside a transaction, rolling back if it throws.
 *
 *  Written out rather than taken from a library because this is the operation the delete paths
 *  depend on: clearing `monitor_positions` and removing the row it pointed at have to happen
 *  together or not at all. `exec` is used instead of `prepare` so that BEGIN cannot be left
 *  dangling by a statement cache.
 *
 *  SYNCHRONOUS, and a body that answers a promise is refused. One connection serves every request,
 *  the sweep and the bot, so a transaction open across an `await` is open for all of them: it
 *  awaited the body until 2026-11-16 — every caller's body was synchronous, and awaiting one still
 *  yielded — and a second transaction begun in that turn met "cannot start a transaction within a
 *  transaction", while any other statement run then was committed or rolled back with this one's.
 */
export function atomic<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const out = fn();
    if (out instanceof Promise || typeof (out as { then?: unknown })?.then === "function") {
      // refused, but already running: its eventual rejection must not reach Node as unhandled,
      // which this process treats as fatal (main.ts)
      (out as PromiseLike<unknown>).then(undefined, () => {});
      throw new Error("a transaction's body must not await: it would hold the transaction open "
        + "for every other request while it waits");
    }
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
