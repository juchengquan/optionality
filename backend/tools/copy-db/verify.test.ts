/** The copy's verification, put through the mutations it exists to catch.
 *
 *  A comparison that cannot fail proves nothing — this project has shipped three assertions that
 *  could never fail (ADR 0008), and the first version of the differential harness reported "0
 *  divergences over 2 compared values" because it was walking key names. So each field type gets
 *  broken here on purpose.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase } from "../../src/db/open.ts";
import { verify } from "./verify.ts";

let dir: string;
let a: ReturnType<typeof createDatabase>;
let b: ReturnType<typeof createDatabase>;

const seed = (db: ReturnType<typeof createDatabase>) => {
  db.exec(`
    insert into monitors (id, code, strike_date, option_type, strike, field, threshold,
      direction, compare, legs, scope, enabled, triggered, last_value, created_at)
    values ('${"m".repeat(32)}', 'US.SPXW261016C8050000', '2026-10-16', 'CALL', 8050.0,
      'option_delta', 0.5, 'above', 'abs',
      '[{"sign": -1, "option_type": "CALL", "strike": 8050.0}]', 'all', 1, 0, -0.42,
      '2026-09-01 15:39:11.940183');
    insert into positions (id, name, strategy, strike_date, contracts, entry, legs, created_at)
    values ('${"p".repeat(32)}', '1016_IC', 'iron_condor', '2026-10-16', 1, 2.87,
      '[{"side": "sold", "option_type": "CALL", "strike": 8050.0}]',
      '2026-09-24 02:58:57.456253');
    insert into monitor_positions values ('${"m".repeat(32)}', '${"p".repeat(32)}');
    insert into configs (id, name, task_type, body, created_at, updated_at)
    values (1, 'spx-holdings', 'spx', '{"a": 1}', '2026-08-10 02:39:13.993858',
      '2026-08-10 02:39:13.993862');
    insert into alembic_version values ('981090d4c5ac');
  `);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "optionality-verify-"));
  a = createDatabase(join(dir, "a.db"));
  b = createDatabase(join(dir, "b.db"));
  seed(a);
  seed(b);
});
afterEach(() => {
  a.close();
  b.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("an identical copy", () => {
  it("has no divergences, and says how many values it looked at", () => {
    const r = verify(a, b);
    expect(r.divergences).toEqual([]);
    // the count is part of the result: a clean report from a comparison that walked nothing
    // reads exactly like a real one
    expect(r.compared).toBe(35);
    expect(r.rows).toBe(5);
  });
});

describe("what it catches", () => {
  const breaks = (sql: string) => {
    b.exec(sql);
    return verify(a, b).divergences;
  };

  it("a datetime that lost its microseconds", () => {
    // the difference between 15:39:11.940183 and .940000 is invisible to anything that compares
    // seconds, and it is still not the same row
    const d = breaks("update monitors set created_at = '2026-09-01 15:39:11.940000'");
    expect(d).toHaveLength(1);
    expect(d[0]!.detail).toMatch(/created_at: source string "2026-09-01 15:39:11\.940183"/);
  });

  it("a number that became text", () => {
    // SQLite's affinity hides most type changes — writing '1' into a BOOLEAN column stores the
    // integer 1, so that mutation cannot even be made. A value a NUMERIC column cannot convert
    // is the one that survives, and the comparison is by type as well as value because the
    // Python reading a string where it expects a float would not fail, it would compute wrongly.
    const d = breaks("update monitors set last_value = 'nearly'");
    expect(d).toHaveLength(1);
    expect(d[0]!.detail).toMatch(/last_value: source number -0\.42 target string "nearly"/);
  });

  it("a float that moved in the last place", () => {
    const d = breaks("update monitors set last_value = -0.42000000000000004");
    expect(d).toHaveLength(1);
  });

  it("JSON whose spacing changed", () => {
    // JSON.stringify would write this, and it means the same thing. It is still a divergence:
    // the copy carries bytes, and a reported difference is how we know it did.
    const d = breaks(`update positions set legs = '[{"side":"sold","option_type":"CALL","strike":8050}]'`);
    expect(d).toHaveLength(1);
    expect(d[0]!.table).toBe("positions");
  });

  it("a NULL that became an empty string", () => {
    const d = breaks("update monitors set scope = '' where scope = 'all'");
    expect(d[0]!.detail).toMatch(/scope/);
  });

  it("a missing row", () => {
    const d = breaks("delete from monitor_positions");
    expect(d[0]!.detail).toMatch(/1 rows in source, 0 in target/);
  });

  it("an extra row", () => {
    const d = breaks(`insert into positions (id, name, strike_date, contracts, legs, created_at)
      values ('${"q".repeat(32)}', 'extra', '2026-10-16', 1, '[]', '2026-09-24 02:58:57.456253')`);
    expect(d[0]!.detail).toMatch(/1 rows in source, 2 in target/);
  });

  it("a row that is present but under a different key", () => {
    // configs, because re-keying a position would be stopped by the foreign key from
    // monitor_positions — which is itself the pragma doing its job
    const d = breaks("update configs set id = 99");
    expect(d.some((x) => x.detail.includes("id:"))).toBe(true);
  });

  it("the alembic stamp pointing at a different migration", () => {
    // a wrong stamp means the Python would try to replay migrations against this file, which is
    // the rollback path this whole format decision exists to keep open
    const d = breaks("update alembic_version set version_num = '000000000000'");
    expect(d[0]!.table).toBe("alembic_version");
  });

  it("a table that is missing entirely", () => {
    b.exec("drop table schedules");
    expect(() => verify(a, b)).toThrow(); // the read fails loudly rather than reporting clean
  });
});
