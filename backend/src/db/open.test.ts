/** The database as it is created and opened: the schema, the pragmas, and the transaction the
 *  delete paths depend on (ADR 0009, phase 4). */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { atomic, createDatabase } from "./open.ts";
import { toSqlDatetime } from "./time.ts";
import { fromSqliteBool, toSqliteBool } from "./values.ts";

let dir: string;
let db: ReturnType<typeof createDatabase>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "optionality-db-"));
  db = createDatabase(join(dir, "test.db"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const now = toSqlDatetime(new Date("2026-09-01T15:39:11.940Z"));
const monitor = (id: string, code = "US.SPXW261016C8050000", field = "option_delta") =>
  db.prepare(`insert into monitors
    (id, code, strike_date, option_type, strike, field, threshold, direction, compare,
     enabled, triggered, created_at)
    values (?, ?, '2026-10-16', 'CALL', 8050, ?, 0.5, 'above', 'abs', 1, 0, ?)`)
    .run(id, code, field, now);
const position = (id: string, name: string) =>
  db.prepare(`insert into positions (id, name, strike_date, contracts, legs, created_at)
    values (?, ?, '2026-10-16', 1, '[]', ?)`).run(id, name, now);

describe("the schema", () => {
  it("creates every table the Python has", () => {
    const names = db.prepare("select name from sqlite_master where type='table' order by name")
      .all().map((r) => (r as { name: string }).name);
    expect(names).toEqual([
      "alembic_version", "configs", "monitor_positions", "monitors", "positions",
      "reports", "runs", "schedules",
    ]);
  });

  it("creates every index under the name SQLAlchemy gives it", () => {
    // the names matter: a migration the Python later runs against this file refers to them
    const names = db.prepare(
      "select name from sqlite_master where type='index' and name not like 'sqlite_%' order by name",
    ).all().map((r) => (r as { name: string }).name);
    expect(names).toEqual([
      "ix_configs_name", "ix_monitors_code", "ix_positions_name",
      "ix_runs_created_at", "ix_runs_status",
    ]);
  });

  it("keeps a monitor's code and field unique together", () => {
    monitor("a".repeat(32));
    // the same contract watched on a different field is legitimate
    expect(() => monitor("b".repeat(32), "US.SPXW261016C8050000", "mid_price")).not.toThrow();
    // the same field twice is not
    expect(() => monitor("c".repeat(32))).toThrow(/UNIQUE|constraint/i);
  });

  it("keeps a position's name unique", () => {
    position("a".repeat(32), "1016_IC");
    expect(() => position("b".repeat(32), "1016_IC")).toThrow(/UNIQUE|constraint/i);
  });
});

describe("the pragmas", () => {
  it("enforces foreign keys, which SQLite does not do by default", () => {
    // without this, a link to a monitor that does not exist is accepted silently and the row
    // becomes an orphan — the shape of the three bugs in #70-#72
    expect(() => db.prepare("insert into monitor_positions values (?, ?)")
      .run("nope".repeat(8), "alsonope".repeat(4))).toThrow(/FOREIGN KEY/i);
  });

  it("enforces EACH end of a link, not just one of them", () => {
    // a row with both ends missing is rejected by either constraint alone, so testing only that
    // case let one of the two be dropped without any test noticing
    monitor("m".repeat(32));
    position("p".repeat(32), "one");
    expect(() => db.prepare("insert into monitor_positions values (?, ?)")
      .run("m".repeat(32), "ghost".repeat(6) + "pp"), "real monitor, missing position")
      .toThrow(/FOREIGN KEY/i);
    expect(() => db.prepare("insert into monitor_positions values (?, ?)")
      .run("ghost".repeat(6) + "mm", "p".repeat(32)), "missing monitor, real position")
      .toThrow(/FOREIGN KEY/i);
  });

  it("enforces a report's link to its run", () => {
    expect(() => db.prepare("insert into reports values (?, '{}', '', ?)")
      .run("norun".repeat(6) + "xx", now)).toThrow(/FOREIGN KEY/i);
  });

  it("accepts a link whose both ends exist", () => {
    monitor("m".repeat(32));
    position("p".repeat(32), "1016_IC");
    expect(() => db.prepare("insert into monitor_positions values (?, ?)")
      .run("m".repeat(32), "p".repeat(32))).not.toThrow();
  });

  it("is in WAL, as the Python's file is", () => {
    expect(db.prepare("pragma journal_mode").get()).toMatchObject({ journal_mode: "wal" });
  });
});

describe("a transaction", () => {
  const count = (t: string) =>
    (db.prepare(`select count(*) n from ${t}`).get() as { n: number }).n;

  it("commits everything when the body finishes", async () => {
    await atomic(db, async () => {
      monitor("a".repeat(32));
      position("b".repeat(32), "one");
    });
    expect(count("monitors")).toBe(1);
    expect(count("positions")).toBe(1);
  });

  it("rolls everything back when the body throws", async () => {
    await expect(atomic(db, async () => {
      monitor("a".repeat(32));
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect(count("monitors")).toBe(0);
  });

  it("rolls back a half-finished delete, which is the case it exists for", async () => {
    // clearing monitor_positions and removing what it pointed at must happen together: a commit
    // in between leaves either an orphan link or a monitor nothing can delete
    monitor("m".repeat(32));
    position("p".repeat(32), "one");
    db.prepare("insert into monitor_positions values (?, ?)").run("m".repeat(32), "p".repeat(32));

    await expect(atomic(db, async () => {
      db.prepare("delete from monitor_positions where monitor_id = ?").run("m".repeat(32));
      throw new Error("interrupted");
    })).rejects.toThrow("interrupted");
    expect(count("monitor_positions")).toBe(1);
  });

  it("rolls back when a constraint fails partway through", async () => {
    monitor("a".repeat(32));
    await expect(atomic(db, async () => {
      position("b".repeat(32), "one");
      monitor("c".repeat(32)); // duplicate code+field
    })).rejects.toThrow();
    expect(count("positions")).toBe(0);
    expect(count("monitors")).toBe(1);
  });

  it("returns what the body returned", async () => {
    expect(await atomic(db, async () => 42)).toBe(42);
  });
});

describe("binding values", () => {
  it("refuses a JavaScript boolean, which is why the conversion helpers exist", () => {
    // node:sqlite will not bind true/false at all. Without toSqliteBool every enabled flag
    // would throw at the first write, or worse, be written as something else.
    expect(() => db.prepare("insert into schedules values (1, '* * * * *', 'UTC', 'spx', 'c', ?)")
      .run(true as never)).toThrow(/cannot be bound/i);
    expect(() => db.prepare("insert into schedules values (2, '* * * * *', 'UTC', 'spx', 'c', ?)")
      .run(toSqliteBool(true))).not.toThrow();
    expect(db.prepare("select enabled from schedules where id = 2").get())
      .toMatchObject({ enabled: 1 });
  });

  it("round-trips a boolean through the column the Python writes 0 and 1 into", () => {
    db.prepare("insert into schedules values (3, '* * * * *', 'UTC', 'spx', 'c', ?)")
      .run(toSqliteBool(false));
    const row = db.prepare("select enabled from schedules where id = 3").get() as { enabled: number };
    expect(row.enabled).toBe(0);
    expect(fromSqliteBool(row.enabled)).toBe(false);
  });
});
