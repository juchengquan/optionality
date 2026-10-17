/** The schema migrations, which the TypeScript side did not have until now.
 *
 *  `applySchema` is documented as safe only on an empty database, so from the cutover until this
 *  change there was no way to alter the live file at all — the first schema change had to decide
 *  how. Alembic was the alternative and it leaves in three weeks with the Python (phase 10), so
 *  this is the mechanism that outlives it. See ADR 0011.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase, openDatabase } from "./open.ts";
import { APPLIED_TABLE, migrate, pendingMigrations, stampAll } from "./migrate.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "optionality-migrate-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const columns = (db: DatabaseSync, table: string) =>
  (db.prepare(`select name from pragma_table_info(?)`).all(table) as { name: string }[])
    .map((r) => r.name);
const tables = (db: DatabaseSync) =>
  (db.prepare("select name from sqlite_master where type='table'").all() as { name: string }[])
    .map((r) => r.name);

/** The shape the live database actually had when this mechanism was written. A verbatim
 *  transcription, and a historical fact rather than a copy of anything that can now change —
 *  schema.sql carries the NEW shape, so it cannot be used to build the old one. */
function preChangeDatabase(path: string): DatabaseSync {
  const db = openDatabase(path);
  db.exec(`
    CREATE TABLE positions (
      id VARCHAR(32) NOT NULL,
      name VARCHAR(100) NOT NULL,
      strategy VARCHAR(50),
      strike_date VARCHAR(10) NOT NULL,
      contracts INTEGER NOT NULL,
      entry FLOAT,
      legs JSON NOT NULL,
      created_at DATETIME NOT NULL,
      PRIMARY KEY (id)
    );
    CREATE UNIQUE INDEX ix_positions_name ON positions (name);
  `);
  return db;
}

describe("migrating a database that predates the mechanism", () => {
  it("adds what the exit schedule needs, keeping the rows that were there", () => {
    const db = preChangeDatabase(join(dir, "old.db"));
    db.prepare(
      `insert into positions (id, name, strategy, strike_date, contracts, entry, legs, created_at)
       values ('p1', '1120_IC', null, '2026-11-20', 1, 6.86, '[]', '2026-10-06 04:15:51')`,
    ).run();

    migrate(db);

    expect(columns(db, "positions")).toContain("opened_at");
    expect(columns(db, "positions")).toContain("manage_notified_at");
    expect(tables(db)).toContain("position_samples");
    // the point of a migration rather than a rebuild: the holding survives it
    const row = db.prepare("select name, entry, opened_at from positions").get() as
      { name: string; entry: number; opened_at: string | null };
    expect(row).toEqual({ name: "1120_IC", entry: 6.86, opened_at: null });
    db.close();
  });

  it("is a no-op the second time, and the tenth", () => {
    const db = preChangeDatabase(join(dir, "twice.db"));
    migrate(db);
    const after = columns(db, "positions");
    for (let i = 0; i < 9; i++) migrate(db);
    expect(columns(db, "positions")).toEqual(after);
    db.close();
  });
});

describe("a database built from schema.sql", () => {
  it("is stamped, so nothing is applied to it twice", () => {
    // schema.sql carries the new shape, so re-applying the migration would fail on a duplicate
    // column. Stamping on creation is what alembic does, and what the cutover did by hand.
    const db = createDatabase(join(dir, "fresh.db"));
    expect(pendingMigrations(db)).toEqual([]);
    expect(() => migrate(db)).not.toThrow();
    expect(columns(db, "positions")).toContain("opened_at");
    db.close();
  });

  it("agrees with the migrated shape, column for column", () => {
    // the two paths into a database must not diverge: a fresh test database and the live file
    // have to be the same thing, or tests pass against a schema production does not have
    const fresh = createDatabase(join(dir, "a.db"));
    const migrated = preChangeDatabase(join(dir, "b.db"));
    migrate(migrated);

    expect(columns(migrated, "positions")).toEqual(columns(fresh, "positions"));
    expect(columns(migrated, "position_samples")).toEqual(columns(fresh, "position_samples"));
    fresh.close();
    migrated.close();
  });
});

describe("when a migration fails", () => {
  it("records nothing and leaves the database as it was", () => {
    const db = preChangeDatabase(join(dir, "bad.db"));
    const bad = join(dir, "migrations");
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, "9999-broken.sql"),
      "ALTER TABLE positions ADD COLUMN ok INTEGER;\nTHIS IS NOT SQL;\n");

    expect(() => migrate(db, bad)).toThrow();
    // both halves rolled back: the column it managed to add, and the record of having run
    expect(columns(db, "positions")).not.toContain("ok");
    const applied = db.prepare(`select count(*) n from ${APPLIED_TABLE}`).get() as { n: number };
    expect(applied.n).toBe(0);
    db.close();
  });
});

describe("what is pending", () => {
  it("is every file not yet recorded, in name order", () => {
    const db = preChangeDatabase(join(dir, "order.db"));
    const d = join(dir, "m");
    mkdirSync(d, { recursive: true });
    for (const n of ["0002-b.sql", "0001-a.sql", "0010-c.sql"]) {
      writeFileSync(join(d, n), "select 1;");
    }
    expect(pendingMigrations(db, d)).toEqual(["0001-a.sql", "0002-b.sql", "0010-c.sql"]);
    migrate(db, d);
    expect(pendingMigrations(db, d)).toEqual([]);
    db.close();
  });

  it("stamps without running, which is how a fresh database skips history", () => {
    const db = preChangeDatabase(join(dir, "stamp.db"));
    stampAll(db);
    expect(pendingMigrations(db)).toEqual([]);
    // stamping did NOT apply it — this database is still the old shape, which is why stampAll
    // is only ever called on one built from schema.sql
    expect(columns(db, "positions")).not.toContain("opened_at");
    db.close();
  });
});

describe("the schema file itself", () => {
  it("declares position_samples one row per position per day", () => {
    const db = createDatabase(join(dir, "pk.db"));
    // a sample belongs to a Position and the foreign key says so — this insert is refused
    // outright without one, which is the behaviour wanted and how this test first failed
    db.prepare(
      `insert into positions (id, name, strategy, strike_date, contracts, entry, legs, created_at)
       values ('p1', '1120_IC', null, '2026-11-20', 1, 6.86, '[]', '2026-10-06 04:15:51')`,
    ).run();
    db.prepare(`insert into position_samples (position_id, observed_on, dte, cost_to_close)
                values ('p1', '2026-10-12', 39, 6.50)`).run();
    // a second sweep on the same day replaces rather than accumulates: the sweep runs every
    // 60 seconds and a day of samples is a day, not 1,440 of them
    db.prepare(`insert or replace into position_samples (position_id, observed_on, dte, cost_to_close)
                values ('p1', '2026-10-12', 39, 6.55)`).run();
    const rows = db.prepare("select * from position_samples").all() as { cost_to_close: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.cost_to_close).toBe(6.55);

    // and a sample for a Position that does not exist is refused, so the series cannot outlive
    // the holding it describes
    expect(() => db.prepare(
      `insert into position_samples (position_id, observed_on, dte, cost_to_close)
       values ('nope', '2026-10-12', 39, 1.0)`).run()).toThrow(/FOREIGN KEY/);
    db.close();
  });
});

describe("0004: a Leg's Side is long or short (ADR 0013)", () => {
  const NAME = "0004-side-is-long-or-short.sql";
  /** a database one migration behind: built current, then 0004 un-recorded */
  function behind(): DatabaseSync {
    const db = createDatabase(join(dir, "behind.db"));
    db.prepare(`delete from ${APPLIED_TABLE} where name = ?`).run(NAME);
    return db;
  }
  const insert = (db: DatabaseSync, id: string, legs: string) => db.prepare(
    `insert into positions (id, name, strategy, strike_date, contracts, entry, legs, created_at)
     values (?, ?, null, '2026-11-20', 1, 6.86, ?, '2026-10-06 04:15:51')`,
  ).run(id, id, legs);
  const legsOf = (db: DatabaseSync, id: string) =>
    JSON.parse((db.prepare("select legs from positions where id = ?").get(id) as { legs: string }).legs);

  it("renames every Side, keeping the legs' order and every other field", () => {
    const db = behind();
    insert(db, "ic", JSON.stringify([
      { side: "bought", option_type: "PUT", strike: 6450 },
      { side: "sold", option_type: "PUT", strike: 6500 },
      { side: "sold", option_type: "CALL", strike: 7100 },
      { side: "bought", option_type: "CALL", strike: 7150 },
    ]));
    expect(migrate(db)).toEqual([NAME]);
    expect(legsOf(db, "ic")).toEqual([
      { side: "long", option_type: "PUT", strike: 6450 },
      { side: "short", option_type: "PUT", strike: 6500 },
      { side: "short", option_type: "CALL", strike: 7100 },
      { side: "long", option_type: "CALL", strike: 7150 },
    ]);
  });

  it("reads the JSON rather than matching text, so Python's spacing migrates too", () => {
    // rows that came across from the Python database were written by json.dumps, which puts a
    // space after every colon — a text replace of '"side":"sold"' would leave them untouched
    const db = behind();
    insert(db, "py", '[{"side": "sold", "option_type": "PUT", "strike": 6500.0}]');
    migrate(db);
    expect(legsOf(db, "py")).toEqual([{ side: "short", option_type: "PUT", strike: 6500 }]);
  });

  it("leaves a Position with no legs, and one already renamed, as they were", () => {
    const db = behind();
    insert(db, "empty", "[]");
    insert(db, "done", '[{"side":"short","option_type":"CALL","strike":7100}]');
    migrate(db);
    expect(legsOf(db, "empty")).toEqual([]);
    expect(legsOf(db, "done")).toEqual([{ side: "short", option_type: "CALL", strike: 7100 }]);
  });
});

describe("0005: the run pipeline's tables go with it (phase 10, ADR 0014)", () => {
  const NAME = "0005-drop-the-run-pipeline.sql";
  const GONE = ["configs", "schedules", "runs", "reports", "alembic_version"];

  it("drops exactly the run pipeline's tables and alembic's, and keeps every other row", () => {
    const db = createDatabase(join(dir, "behind.db"));
    db.prepare(`delete from ${APPLIED_TABLE} where name = ?`).run(NAME);
    // what 0005 removes has to exist first for the test to mean anything; a database one
    // migration behind is built current, so the tables are put back the way they last were
    db.exec(`
      CREATE TABLE IF NOT EXISTS configs (id INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS schedules (id INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS runs (id VARCHAR(32) PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS reports (id INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS alembic_version (version_num VARCHAR(32) PRIMARY KEY);
    `);
    db.prepare(
      `insert into positions (id, name, strategy, strike_date, contracts, entry, legs, created_at)
       values ('p1', '1120_IC', null, '2026-11-20', 1, 3.0, '[]', '2026-10-06 04:15:51')`,
    ).run();

    expect(migrate(db)).toEqual([NAME]);
    expect(tables(db).filter((t) => GONE.includes(t))).toEqual([]);
    expect(tables(db)).toEqual(expect.arrayContaining(
      ["monitors", "positions", "monitor_positions", "position_samples", APPLIED_TABLE]));
    expect(db.prepare("select count(*) n from positions").get()).toEqual({ n: 1 });
  });

  it("is what schema.sql describes, so a fresh database has none of them either", () => {
    const db = createDatabase(join(dir, "fresh.db"));
    expect(tables(db).filter((t) => GONE.includes(t))).toEqual([]);
  });
});
