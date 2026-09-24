import { describe, expect, it } from "vitest";

import { columnsFor, offerable, PRIORITY, SINGLE_COLUMNS, COMBO_COLUMNS } from "../columns";

/** The fitting rule, exhaustively, with no browser involved (ADR 0008).
 *
 *  Phase 4 replaces the width estimates with real measurement. These tests are written
 *  against the RULE — identity survives, priority decides what goes, table order decides
 *  where things sit — so they outlive where the numbers come from.
 */

const keys = (cs: { key: string }[]) => cs.map((c) => c.key);
const NONE = new Set<string>();

describe("what fits", () => {
  it("keeps the identity column even when nothing fits at all", () => {
    expect(keys(columnsFor("single", 0, NONE))).toEqual(["contract"]);
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

  it("offers only what could actually appear", () => {
    const at = offerable("single", 300);
    // 170 for the contract leaves 130: alarm fits, last_trade does not
    expect(at.has("alarm")).toBe(true);
    expect(at.has("last_trade")).toBe(false);
  });

  it("offers everything at a desk", () => {
    const at = offerable("single", 2000);
    for (const k of PRIORITY.single) if (k !== "contract") expect(at.has(k)).toBe(true);
  });

  it("never offers the identity column, which cannot be hidden", () => {
    expect(offerable("single", 4000).has("contract")).toBe(false);
    expect(offerable("combo", 4000).has("combo")).toBe(false);
  });
});
