/** Schema migrations for the TypeScript side (ADR 0011).
 *
 *  There were none. `applySchema` is safe only on an empty database, so from the cutover until the
 *  first schema change there was no way to alter the live file — and alembic, the obvious answer,
 *  leaves with the Python in phase 10. So: plain `.sql` files applied in name order, each in a
 *  transaction, with a table recording what has run.
 *
 *  `schema.sql` always carries the CURRENT shape, which means a database built from it already has
 *  everything the migrations would add. Such a database is therefore STAMPED rather than migrated —
 *  the same move alembic's `stamp head` makes, and the one the cutover made by hand when it wrote
 *  `alembic_version` into the copied file.
 */
import { readFileSync, readdirSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

export const APPLIED_TABLE = "schema_migrations";

/** Deliberately not `alembic_version`: that table belonged to alembic, held a single revision
 *  hash, and was what the Python rollback read — two mechanisms, two records. Migration 0005
 *  dropped it with the rollback (phase 10). */
function ensureTable(db: DatabaseSync): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${APPLIED_TABLE} (
       name VARCHAR(100) NOT NULL PRIMARY KEY,
       applied_at DATETIME NOT NULL
     )`,
  );
}

const DIRECTORY = new URL("./migrations/", import.meta.url);

function allMigrations(dir?: string): string[] {
  const from = dir ?? DIRECTORY;
  return readdirSync(from).filter((n) => n.endsWith(".sql")).sort();
}

/** Which migrations this database has not recorded, in the order they must run. */
export function pendingMigrations(db: DatabaseSync, dir?: string): string[] {
  ensureTable(db);
  const done = new Set(
    (db.prepare(`select name from ${APPLIED_TABLE}`).all() as { name: string }[])
      .map((r) => r.name),
  );
  return allMigrations(dir).filter((n) => !done.has(n));
}

/** Record every migration as run without running any of it. For a database built from schema.sql,
 *  which already has their effect. */
export function stampAll(db: DatabaseSync, dir?: string): void {
  ensureTable(db);
  const now = new Date().toISOString().replace("T", " ").slice(0, 23);
  for (const name of allMigrations(dir)) {
    db.prepare(`insert or ignore into ${APPLIED_TABLE} (name, applied_at) values (?, ?)`)
      .run(name, now);
  }
}

/** Apply what is pending. Throws on the first failure, having rolled that one back.
 *
 *  Synchronous and not using `atomic`, which is async: this runs before the service serves
 *  anything, and a half-applied schema must never be something the server starts on top of.
 */
export function migrate(db: DatabaseSync, dir?: string): string[] {
  const pending = pendingMigrations(db, dir);
  const applied: string[] = [];
  for (const name of pending) {
    const sql = readFileSync(new URL(name, dir ? `file://${dir}/` : DIRECTORY), "utf8");
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.prepare(`insert into ${APPLIED_TABLE} (name, applied_at) values (?, ?)`)
        .run(name, new Date().toISOString().replace("T", " ").slice(0, 23));
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(`migration ${name} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    applied.push(name);
  }
  return applied;
}
