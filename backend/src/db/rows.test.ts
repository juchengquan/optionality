/** The link between schema.sql and the TypeScript that reads it (ADR 0009, phase 4).
 *
 *  Drizzle would have derived both from one declaration. Without it there are three statements of
 *  the same truth — the DDL, the COLUMNS/NULLABLE constants, and the row interfaces — and this is
 *  what stops them drifting: the compiler ties the constants to the interfaces (see SchemaChecks
 *  in rows.ts), and these tests tie the constants to the database that actually gets created.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase } from "./open.ts";
import { COLUMNS, NULLABLE, type TableName } from "./rows.ts";

let dir: string;
let db: ReturnType<typeof createDatabase>;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "optionality-rows-"));
  db = createDatabase(join(dir, "test.db"));
});
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

interface ColumnInfo { name: string; notnull: number }
const info = (table: string) =>
  db.prepare("select name, \"notnull\" from pragma_table_info(?)").all(table) as unknown as ColumnInfo[];

const tables = Object.keys(COLUMNS) as TableName[];

describe("COLUMNS matches the database", () => {
  it("covers every table the schema creates, and no others", () => {
    const created = (db.prepare(
      "select name from sqlite_master where type='table' order by name",
    ).all() as { name: string }[]).map((r) => r.name);
    expect([...tables].sort()).toEqual(created);
  });

  it.each(tables)("names %s's columns, in the order the DDL declares them", (table) => {
    // order matters because an insert built from COLUMNS pairs names with placeholders
    expect(info(table).map((c) => c.name)).toEqual([...COLUMNS[table]]);
  });
});

describe("NULLABLE matches the database", () => {
  it.each(tables)("marks exactly %s's nullable columns", (table) => {
    const nullable = info(table).filter((c) => c.notnull === 0).map((c) => c.name).sort();
    expect(nullable).toEqual([...NULLABLE[table]].sort());
  });

  it("agrees that a NOT NULL column really rejects null", () => {
    // the pragma is read here, so this proves the pragma means what the test assumes
    expect(() => db.prepare(
      "insert into positions (id, name, strike_date, contracts, legs, created_at) values (?, ?, ?, ?, ?, ?)",
    ).run("a".repeat(32), "n", "2026-10-16", 1, null as never, "2026-10-16 00:00:00.000000"))
      .toThrow(/NOT NULL/i);
  });

  it("agrees that a nullable column really accepts null", () => {
    expect(() => db.prepare(
      "insert into positions (id, name, strategy, strike_date, contracts, entry, legs, created_at)"
      + " values (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("b".repeat(32), "n2", null, "2026-10-16", 1, null, "[]", "2026-10-16 00:00:00.000000"))
      .not.toThrow();
  });
});

describe("the relationships", () => {
  it("declares every foreign key, both ends of every link", () => {
    // Asserted structurally because the behavioural test is easy to get wrong: a row whose monitor
    // AND position are both missing is rejected by either constraint alone, so dropping one of the
    // two went unnoticed until this list existed.
    const keys = (table: string) =>
      (db.prepare('select "table" as parent, "from" as child, "to" as target from pragma_foreign_key_list(?)')
        .all(table) as { parent: string; child: string; target: string }[])
        .map((k) => `${k.child} -> ${k.parent}.${k.target}`).sort();

    expect(keys("monitor_positions")).toEqual([
      "monitor_id -> monitors.id",
      "position_id -> positions.id",
    ]);
    expect(keys("reports")).toEqual(["run_id -> runs.id"]);
    // nothing else has one, and a stray reference would change what a delete is allowed to do
    for (const t of ["configs", "schedules", "runs", "monitors", "positions", "alembic_version"]) {
      expect(keys(t), t).toEqual([]);
    }
  });
});
