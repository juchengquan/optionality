/** Recording a credit taken in across everything a rule spans.
 *
 *  Ported from the total-entry group in tests/test_positions_api.py (ADR 0009, phase 5). The
 *  Python's version builds its positions through /positions, which arrives in phase 5c; these seed
 *  them directly, because what is under test is the arithmetic of deriving the one wing that cannot
 *  be edited, not the creation route.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase } from "./db/open.ts";
import { toSqliteJson } from "./db/values.ts";
import { applyTotalEntry } from "./monitors.ts";

const EXPIRY = "2026-12-18";
let dir: string;
let db: ReturnType<typeof createDatabase>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "optionality-total-"));
  db = createDatabase(join(dir, "test.db"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const position = (id: string, name: string, entry: number | null, legs: unknown[]) => {
  db.prepare(
    `insert into positions (id, name, strategy, strike_date, contracts, entry, legs, created_at)
     values (?, ?, 'credit_spread', ?, 1, ?, ?, '2026-08-01 00:00:00.000000')`,
  ).run(id, name, EXPIRY, entry, toSqliteJson(legs));
  return id;
};

const rule = (id: string, code: string, scope: string | null, positionIds: string[]) => {
  db.prepare(
    `insert into monitors (id, code, strike_date, option_type, strike, field, threshold,
       direction, compare, legs, scope, enabled, triggered, created_at)
     values (?, ?, ?, 'CMB', 0, 'mid_price', 9.0, 'above', 'abs', ?, ?, 1, 0,
       '2026-08-01 00:00:00.000000')`,
  ).run(id, code, EXPIRY, toSqliteJson([{ sign: -1, option_type: "CALL", strike: 8050 }]), scope);
  for (const pid of positionIds) {
    db.prepare("insert into monitor_positions values (?, ?)").run(id, pid);
  }
  return id;
};

const CALLS = "c".repeat(32);
const PUTS = "p".repeat(32);
const WING = "w".repeat(32);
const SPAN = "s".repeat(32);

/** A condor: two spreads, one rule over the calls alone, and one spanning both (ADR 0004). */
const spanning = (callsEntry: number | null = 2.87, putsEntry: number | null = null) => {
  position(CALLS, "calls", callsEntry, [
    { side: "sold", option_type: "CALL", strike: 8050 },
    { side: "bought", option_type: "CALL", strike: 8075 },
  ]);
  position(PUTS, "puts", putsEntry, [
    { side: "sold", option_type: "PUT", strike: 7100 },
    { side: "bought", option_type: "PUT", strike: 7075 },
  ]);
  rule(WING, "calls_rule", "all", [CALLS]);
  rule(SPAN, "span_rule", "all", [CALLS, PUTS]);
};

const entryOf = (id: string) =>
  (db.prepare("select entry from positions where id = ?").get(id) as { entry: number | null }).entry;

describe("deriving the unreachable wing", () => {
  it("writes the difference into the wing with no rule of its own", async () => {
    spanning();
    expect(await applyTotalEntry(db, SPAN, 3.21)).toBeNull();
    // 3.21 less the 2.87 already recorded
    expect(entryOf(PUTS)).toBeCloseTo(0.34, 10);
    // the wing you can edit directly is untouched: the per-wing credits stay the single source of
    // truth, and the total is a way of REACHING them rather than a second place to keep them
    expect(entryOf(CALLS)).toBe(2.87);
  });

  it("rounds to four places, to keep float noise out of a figure the owner reads back", async () => {
    spanning(2.87);
    await applyTotalEntry(db, SPAN, 3.2);
    expect(entryOf(PUTS)).toBe(0.33);
  });

  it("refuses when every wing already has a rule of its own", async () => {
    // nothing is left to derive, and overwriting a directly-editable wing would be a surprise
    spanning();
    rule("q".repeat(32), "puts_rule", "all", [PUTS]);
    expect(await applyTotalEntry(db, SPAN, 3.21))
      .toBe("every wing here has a rule of its own — set them individually");
  });

  it("refuses when more than one wing is unreachable", async () => {
    // one equation, two unknowns
    position(CALLS, "calls", 2.87, []);
    position(PUTS, "puts", 1.0, []);
    position("x".repeat(32), "third", 1.0, []);
    rule(SPAN, "span_rule", "all", [CALLS, PUTS, "x".repeat(32)]);
    expect(await applyTotalEntry(db, SPAN, 3.21))
      .toBe("cannot split a total across 3 wings that have no rule of their own");
  });

  it("refuses when another wing's credit is not recorded yet", async () => {
    // two unknowns and one equation cannot be solved, so it says so rather than guessing
    spanning(null);
    expect(await applyTotalEntry(db, SPAN, 3.21)).toBe("set the other wings' credits first");
    expect(entryOf(PUTS)).toBeNull();
  });

  it("refuses for a rule with no holdings attached", async () => {
    rule(SPAN, "lonely", null, []);
    expect(await applyTotalEntry(db, SPAN, 3.21)).toBe("no holdings attached to this rule");
  });

  it("writes nothing at all when it refuses", async () => {
    spanning(null);
    await applyTotalEntry(db, SPAN, 3.21);
    expect(entryOf(CALLS)).toBeNull();
    expect(entryOf(PUTS)).toBeNull();
  });
});

describe("which wings count as directly editable", () => {
  it("is only those a WHOLE-position rule watches alone", async () => {
    // a leg rule links to one Position too but offers no field, so counting it would wrongly mark
    // that Position reachable — and then nothing would be left to derive
    spanning();
    db.prepare("update monitors set scope = 'leg' where id = ?").run(WING);
    // with the calls wing no longer directly editable, two wings are unreachable
    expect(await applyTotalEntry(db, SPAN, 3.21))
      .toBe("cannot split a total across 2 wings that have no rule of their own");
  });
});

describe("a credit that cannot be derived", () => {
  it("does not write a wrong figure when another wing's credit is missing", async () => {
    // one equation and two unknowns. Writing total − 0 would record a credit that was never taken.
    spanning(null);
    const before = entryOf(PUTS);
    expect(await applyTotalEntry(db, SPAN, 3.21)).toMatch(/first/);
    expect(entryOf(PUTS)).toBe(before);
  });
});
