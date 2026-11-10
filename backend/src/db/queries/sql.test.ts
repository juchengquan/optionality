/** The three things every query was writing out by hand, now written once.
 *
 *  Only the behaviour that is EASY TO GET WRONG in a generic version is tested here. Each query
 *  built on these is already exercised by the route, sweeper and bot suites — asserting that
 *  `listMonitors` returns monitors a second time would add a test and no evidence.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createDatabase } from "../open.ts";
import type { PositionRow } from "../rows.ts";
import { databaseResponds, insertRow, row, rows, updateFields } from "./sql.ts";

let db: ReturnType<typeof createDatabase> | null = null;

function open() {
  db = createDatabase(join(mkdtempSync(join(tmpdir(), "optionality-sql-")), "t.db"));
  return db;
}

afterEach(() => {
  try {
    db?.close();
  } catch {
    /* a test may have closed it on purpose */
  }
  db = null;
});

/** A holding with every column set, so a missing one in a generic insert is visible. */
function holding(over: Partial<PositionRow> = {}): PositionRow {
  return {
    id: "p".padEnd(32, "1"),
    name: "condor",
    strategy: "iron_condor",
    strike_date: "2026-12-18",
    contracts: 2,
    entry: 4.5,
    legs: "[]",
    created_at: "2026-11-08 00:00:00.000000",
    opened_at: "2026-11-01",
    manage_notified_at: null,
    closed_on: null,
    exit: null,
    ...over,
  };
}

describe("inserting a row", () => {
  it("writes every column the schema declares, in its order", () => {
    const d = open();
    insertRow(d, "positions", holding());
    const stored = row<PositionRow>(d, "select * from positions where id = ?", "p".padEnd(32, "1"));
    expect(stored!.opened_at).toBe("2026-11-01");
    expect(stored!.entry).toBe(4.5);
  });

  it("REFUSES a row with a column missing, rather than storing defaults for it", () => {
    // This is the whole difference between naming `COLUMNS[table]` and naming `Object.keys(value)`,
    // and a mutation sweep showed it: with the keys of the value, a half-built row inserts
    // cleanly and the absent columns take the database's defaults — silently. With the schema's
    // columns, the missing one binds undefined and node:sqlite refuses, which is what makes
    // `blank()` in create-monitor.ts the thing that has to list every field rather than a
    // convenience.
    //
    // A loop over the columns of what came BACK cannot see this: SQLite answers `select *` with
    // every column whichever way the row went in.
    const d = open();
    const { entry: _entry, opened_at: _opened, ...partial } = holding();
    expect(() => insertRow(d, "positions", partial as unknown as PositionRow))
      .toThrow(/cannot be bound/);
    expect(rows<PositionRow>(d, "select * from positions"), "and nothing was written").toEqual([]);
  });

  it("stores a null as a null rather than dropping the column", () => {
    const d = open();
    insertRow(d, "positions", holding({ entry: null, strategy: null }));
    const stored = row<PositionRow>(d, "select * from positions limit 1");
    expect(stored!.entry).toBe(null);
    expect(stored!.strategy).toBe(null);
  });
});

describe("updating named columns", () => {
  it("writes only what it was given, and says it wrote", () => {
    const d = open();
    insertRow(d, "positions", holding());
    expect(updateFields<PositionRow>(d, "positions", "p".padEnd(32, "1"), { entry: 9 })).toBe(true);
    const stored = row<PositionRow>(d, "select * from positions limit 1");
    expect(stored!.entry).toBe(9);
    expect(stored!.name, "an absent key means leave it, never set it to null").toBe("condor");
  });

  it("writes nothing for an empty change set rather than running a statement", () => {
    // `update positions set where id = ?` is a syntax error, so a generic update MUST answer this
    // before building one. The routes refuse an empty PATCH first, which is what left this
    // unreachable from any suite until the SQL moved here.
    const d = open();
    insertRow(d, "positions", holding());
    expect(updateFields<PositionRow>(d, "positions", "p".padEnd(32, "1"), {})).toBe(false);
    expect(row<PositionRow>(d, "select * from positions limit 1")!.entry).toBe(4.5);
  });
});

describe("reading", () => {
  it("answers an empty list and undefined rather than throwing on no match", () => {
    const d = open();
    expect(rows<PositionRow>(d, "select * from positions")).toEqual([]);
    expect(row<PositionRow>(d, "select * from positions where id = ?", "nobody")).toBeUndefined();
  });
});

describe("whether the database answers", () => {
  it("is true while it is open and false once it is gone", () => {
    // /health reports this rather than raising: an endpoint that 500s when the database is gone
    // tells you less than one that says `db: false`
    const d = open();
    expect(databaseResponds(d)).toBe(true);
    d.close();
    expect(databaseResponds(d)).toBe(false);
  });
});
