import { beforeEach, describe, expect, it } from "vitest";

import type { Entry, PositionValue } from "../api";
import { bookPnl, closestToFiring, loadBaseline, movedSince, saveBaseline, urgencyBand } from "../signals";

function entry(over: Partial<Entry> = {}): Entry {
  return {
    id: "m1", code: "r", field: "mid_price", threshold: 3.0, direction: "above",
    compare: "abs", triggered: false, strike_date: "2026-10-16", dte: 22, fill: 50,
    scope: "all", positions: [{ id: "p1", name: "p1" }], cost_to_close: 1.5,
    entry: 3.0, pnl: 150, snapshot: null, legs: [{ sign: -1, option_type: "CALL", strike: 8050 }],
    combo_value: -1.5, combo_greeks: {}, ...over,
  } as Entry;
}

describe("book P&L", () => {
  it("sums holdings, never rules, so a shared wing is not counted twice", () => {
    // the live shape: a rule on the call wing, and a rule spanning both wings. Summing
    // rules gave +545; the truth across holdings is +328.
    const positions: PositionValue[] = [
      { id: "p1", name: "1016_bs_8050", entry: 2.87, cost_to_close: 0.7, pnl: 217 },
      { id: "p2", name: "1016_IC_puts", entry: 0.13, cost_to_close: 0.7, pnl: -57 },
      { id: "p3", name: "1030_bs_8100", entry: 3.37, cost_to_close: 1.6, pnl: 177 },
      { id: "p4", name: "1120_b_8100", entry: 3.61, cost_to_close: 3.7, pnl: -9 },
    ];
    expect(bookPnl(positions)).toEqual({ total: 328, priced: 4, of: 4 });
  });

  it("says how much of the book it could price rather than quietly omitting one", () => {
    const positions: PositionValue[] = [
      { id: "p1", name: "a", entry: 2.0, cost_to_close: 1.0, pnl: 100 },
      { id: "p2", name: "b", entry: null, cost_to_close: 1.0, pnl: null },
    ];
    expect(bookPnl(positions)).toEqual({ total: 100, priced: 1, of: 2 });
  });
});

describe("urgency", () => {
  it("bands without re-ordering anything", () => {
    expect(urgencyBand(50)).toBe("");
    expect(urgencyBand(70)).toBe("near");
    expect(urgencyBand(90)).toBe("close");
    expect(urgencyBand(null)).toBe("");
  });

  it("names the closest rule to firing", () => {
    const worst = entry({ id: "m2", code: "hot", fill: 81 });
    expect(closestToFiring([entry({ fill: 30 }), worst, entry({ id: "m3", fill: 70 })])).toBe(worst);
  });

  it("ignores rules with no honest fill rather than treating them as zero", () => {
    expect(closestToFiring([entry({ fill: null })])).toBeNull();
  });
});

describe("movement since you last looked", () => {
  beforeEach(() => localStorage.clear());

  it("survives a reload, because reloading is not looking away", () => {
    saveBaseline([entry({ cost_to_close: 1.5 })]);
    const reloaded = loadBaseline();
    expect(reloaded?.watched["m1"]).toBe(1.5);
    expect(movedSince(entry({ cost_to_close: 1.65 }), reloaded)).toBeCloseTo(0.15);
  });

  it("reports nothing when a rule has not moved", () => {
    const base = saveBaseline([entry({ cost_to_close: 1.5 })]);
    expect(movedSince(entry({ cost_to_close: 1.5 }), base)).toBeNull();
  });

  it("reports nothing for a rule it has never seen", () => {
    const base = saveBaseline([entry()]);
    expect(movedSince(entry({ id: "unseen" }), base)).toBeNull();
  });

  it("measures a single-leg rule on the field it watches", () => {
    const leg = entry({
      id: "leg", legs: undefined, positions: [], field: "option_delta",
      snapshot: { option_delta: 0.16 },
    });
    const base = saveBaseline([leg]);
    expect(movedSince({ ...leg, snapshot: { option_delta: 0.18 } } as Entry, base)).toBeCloseTo(0.02);
  });
});
