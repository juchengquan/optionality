import { describe, expect, it } from "vitest";

import {
  ALWAYS, columnsFor, COMBO_COLUMNS, offerable, PRIORITY, SINGLE_COLUMNS, widthsFromContent,
} from "../columns";
import { comboSubLine } from "../format";
import { cellValue } from "../WatchlistTable";

/** The fitting rule, exhaustively, with no browser involved (ADR 0008).
 *
 *  Phase 4 replaces the width estimates with real measurement. These tests are written
 *  against the RULE — identity survives, priority decides what goes, table order decides
 *  where things sit — so they outlive where the numbers come from.
 */

const keys = (cs: { key: string }[]) => cs.map((c) => c.key);
const NONE = new Set<string>();

describe("what fits", () => {
  it("keeps the pinned columns even when nothing fits at all", () => {
    // a row you cannot name is not a row, and a single-leg row without delta does not say
    // what its alarm is about — so both survive a zero-width table
    expect(keys(columnsFor("single", 0, NONE))).toEqual(["contract", "delta"]);
    expect(keys(columnsFor("combo", 10, NONE))).toEqual(["combo"]);
  });

  it("gives a phone the name and the alarm, and not much else", () => {
    // an iPhone in portrait is 390 CSS px of VIEWPORT; the table gets less, after the
    // body's margins. Asserted as a property rather than an exact list, because phase 4
    // replaces the width estimates and an exact list would then be wrong for no reason.
    const phone = keys(columnsFor("single", 342, NONE));
    expect(phone[0]).toBe("contract");
    expect(phone).toContain("alarm");
    expect(phone.length).toBeLessThanOrEqual(4);
  });

  it("gives a desk everything not unticked", () => {
    expect(keys(columnsFor("single", 2000, NONE))).toEqual(keys(SINGLE_COLUMNS));
    expect(keys(columnsFor("combo", 2000, NONE))).toEqual(keys(COMBO_COLUMNS));
  });

  it("drops from the bottom of the priority order, never the top", () => {
    const seen: string[][] = [];
    for (let w = 170; w <= 1400; w += 20) seen.push(keys(columnsFor("single", w, NONE)));
    // every column set is a subset of every wider one: widening only ever adds
    for (let i = 1; i < seen.length; i++) {
      for (const k of seen[i - 1]!) {
        expect(seen[i]).toContain(k);
      }
    }
  });

  it("draws columns in the table's order, not the priority order", () => {
    // priority puts delta before mid; the table puts dte before delta
    const wide = keys(columnsFor("single", 700, NONE));
    expect(wide.indexOf("dte")).toBeLessThan(wide.indexOf("delta"));
    expect(PRIORITY.single.indexOf("delta")).toBeLessThan(PRIORITY.single.indexOf("dte"));
  });

  it("unticking still hides absolutely, however much room there is", () => {
    const wide = keys(columnsFor("single", 4000, new Set(["gamma", "vega"])));
    expect(wide).not.toContain("gamma");
    expect(wide).not.toContain("vega");
    expect(wide).toContain("delta");
  });

  it("spends the room freed by unticking on the next column down", () => {
    const narrow = keys(columnsFor("single", 560, NONE));
    const freed = keys(columnsFor("single", 560, new Set(["alarm"])));
    expect(freed.length).toBeGreaterThanOrEqual(narrow.length);
    expect(freed).not.toContain("alarm");
  });

  it("keeps entry beside P&L on a combo, as the order says", () => {
    const wide = keys(columnsFor("combo", 2000, NONE));
    expect(Math.abs(wide.indexOf("entry") - wide.indexOf("pnl"))).toBe(1);
  });
});

describe("what the picker offers", () => {
  it("offers nothing at all on the narrowest screens", () => {
    expect(offerable("single", 100).size).toBe(0);
  });

  it("offers strictly more as the screen grows, and never less", () => {
    // asserted as a property rather than "column X at width Y". The widths are provisional
    // estimates that real measurement replaces, and pinning one column already invalidated
    // this test twice when it named a number.
    let previous = new Set<string>();
    let grew = false;
    for (let w = 0; w <= 1600; w += 10) {
      const at = offerable("single", w);
      for (const k of previous) expect(at.has(k), `${k} stopped being offered at ${w}px`).toBe(true);
      if (at.size > previous.size) grew = true;
      previous = at;
    }
    // and it is not simply always-everything or always-nothing
    expect(grew).toBe(true);
    expect(offerable("single", 0).size).toBe(0);
    expect(offerable("single", 1600).size).toBeGreaterThan(5);
  });

  it("offers everything at a desk, except what cannot be turned off", () => {
    const at = offerable("single", 2000);
    for (const k of PRIORITY.single) {
      if (ALWAYS.single.includes(k)) expect(at.has(k), `${k} is pinned`).toBe(false);
      else expect(at.has(k), `${k} should be offered`).toBe(true);
    }
  });

  it("never offers a pinned column, which cannot be hidden", () => {
    expect(offerable("single", 4000).has("contract")).toBe(false);
    expect(offerable("combo", 4000).has("combo")).toBe(false);
  });
});

describe("columns that are always there", () => {
  it("keeps delta on a single-leg table however narrow it gets", () => {
    // every single-leg rule in this watchlist watches option_delta, so a row without it
    // is a row that does not say what the alarm is about
    for (const w of [0, 120, 200, 342, 390, 1600]) {
      expect(keys(columnsFor("single", w, NONE)), `at ${w}px`).toContain("delta");
    }
  });

  it("keeps delta even when it has been unticked", () => {
    expect(keys(columnsFor("single", 1600, new Set(["delta"])))).toContain("delta");
  });

  it("does not offer delta in the picker, because it cannot be turned off", () => {
    expect(offerable("single", 4000).has("delta")).toBe(false);
  });

  it("leaves the combo table alone — its rules watch value, not delta", () => {
    expect(keys(columnsFor("combo", 200, NONE))).not.toContain("delta");
    expect(offerable("combo", 4000).has("delta")).toBe(true);
  });
});

describe("the combo column's real width", () => {
  const condor = {
    id: "m1", code: "1016_IC", field: "mid_price", threshold: 3.21,
    direction: "above" as const, compare: "abs" as const, triggered: false,
    strike_date: "2026-10-16",
    dte: 22, fill: 48, scope: "all", positions: [], cost_to_close: 1.55, entry: 3.21, pnl: 166,
    snapshot: null, combo_value: -1.55, combo_greeks: {},
    legs: [
      { sign: -1, option_type: "CALL" as const, strike: 8050 },
      { sign: 1, option_type: "CALL" as const, strike: 8075 },
      { sign: -1, option_type: "PUT" as const, strike: 7100 },
      { sign: 1, option_type: "PUT" as const, strike: 7075 },
    ],
  };

  it("counts the leg summary, not just the name", () => {
    // "1016_IC" is 7 characters; the cell renders that plus "261016 · -C8050 +C8075
    // -P7100 +P7075" underneath. Measuring the name alone told the fitting rule the
    // column needed a fifth of the room it actually takes.
    const w = widthsFromContent(COMBO_COLUMNS, [condor], true, 8, cellValue, comboSubLine);
    const nameOnly = widthsFromContent(COMBO_COLUMNS, [condor], true, 8, cellValue);

    expect(w.combo!).toBeGreaterThan(nameOnly.combo! * 2);
  });

  it("discounts the sub-line for being set smaller", () => {
    // it renders at 0.78rem, so counting its characters at full width would overshoot
    const w = widthsFromContent(COMBO_COLUMNS, [condor], true, 10, cellValue, comboSubLine);
    const sub = comboSubLine(condor, "combo");
    expect(w.combo!).toBeLessThan(sub.length * 10 + 30);
  });

  it("ignores the sub-line for columns that do not have one", () => {
    const w = widthsFromContent(COMBO_COLUMNS, [condor], true, 8, cellValue, comboSubLine);
    expect(w.dte!).toBeLessThan(w.combo!);
  });
});
