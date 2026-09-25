import { describe, expect, it } from "vitest";

import {
  ALWAYS, columnsFor, COMBO_COLUMNS, offerable, PRIORITY, SCROLL_BUDGET, SINGLE_COLUMNS,
} from "../columns";

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

  it("gives a phone more than fits, because the table swipes", () => {
    // this used to assert "four columns at most". The owner uses the sideways swipe and
    // would rather have the figures than a table that fits exactly — so the rule now
    // spends up to SCROLL_BUDGET screens and the name column stays frozen.
    const phone = keys(columnsFor("single", 342, NONE));
    expect(phone[0]).toBe("contract");
    expect(phone).toContain("alarm");
    expect(phone.length).toBeGreaterThan(4);
  });

  it("stops well short of an endless sideways scroll", () => {
    // the budget is the point: swiping two screens is useful, swiping six is a maze
    const phone = columnsFor("single", 342, NONE);
    const widest = phone.length * 210; // no column is anywhere near this wide
    expect(widest).toBeLessThan(342 * SCROLL_BUDGET * 4);
    expect(phone.length).toBeLessThan(SINGLE_COLUMNS.length + 1);
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
    // a width where room is genuinely scarce even with the budget, or there is nothing to
    // spend and the test proves nothing
    const narrow = keys(columnsFor("single", 200, NONE));
    const freed = keys(columnsFor("single", 200, new Set(["alarm"])));
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
