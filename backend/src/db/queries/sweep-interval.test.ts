/** `sweep_interval`: one row or none (#442, ADR 0025). */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createDatabase } from "../open.ts";
import { clearSweepInterval, readSweepInterval, writeSweepInterval } from "./sweep-interval.ts";

let db: ReturnType<typeof createDatabase> | null = null;

function open() {
  db = createDatabase(join(mkdtempSync(join(tmpdir(), "optionality-sweep-interval-")), "t.db"));
  return db;
}

afterEach(() => { db?.close(); db = null; });

describe("the sweep interval's row", () => {
  it("is absent on a new database, which is .env's interval", () => {
    expect(readSweepInterval(open())).toBeUndefined();
  });

  it("holds the page's choice, and a second choice replaces the first rather than adding a row", () => {
    const d = open();
    writeSweepInterval(d, 5, "2026-11-17 10:00:00.000000");
    writeSweepInterval(d, 30, "2026-11-17 10:05:00.000000");
    expect(readSweepInterval(d)).toEqual({ id: 1, seconds: 30, set_at: "2026-11-17 10:05:00.000000" });
    expect(d.prepare("select count(*) as n from sweep_interval").get()).toEqual({ n: 1 });
  });

  it("goes back to .env's by having no row at all", () => {
    const d = open();
    writeSweepInterval(d, 5, "2026-11-17 10:00:00.000000");
    clearSweepInterval(d);
    expect(readSweepInterval(d)).toBeUndefined();
    clearSweepInterval(d);   // and clearing nothing is not an error
  });

  it("refuses a second row at the schema, whatever writes it", () => {
    // one row at most is the table's own rule (migration 0016), not this module's discipline
    const d = open();
    expect(() => d.prepare("insert into sweep_interval values (2, 5, 'x')").run()).toThrow(/CHECK/);
  });
});
