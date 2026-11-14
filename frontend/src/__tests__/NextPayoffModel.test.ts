/** The payoff chart's arithmetic, with no chart drawn (#396): the P&L at any SPX level read off the
 *  served corners, the window, where the pointer and the keys put the crosshair, how a P&L is said,
 *  and how labels that would overlap are joined.
 *
 *  The P&L at a price is the DOMAIN's (`payoffAtExpiry`, #291), which the page cannot import (the
 *  frontend reaches only the backend, ADR 0021). So it is held here to the domain's GOLDEN CASES,
 *  case for case: at every strike, at every breakeven and beyond the outer strikes, the readout
 *  says what the case's own legs, quantities, Entry and count settle for. */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import type { Payoff } from "../shared/api";
import {
  labelRows, level, payoffWindow, pnlAt, pnlWords, priceStops, readout, shortWords, snapPrice, stepPrice,
  type PayoffUnit,
} from "../payoffChart";

const GOLDEN = [".", ".."].map((d) => resolve(process.cwd(), d, "testdata/golden/payoff.json"))
  .find((f) => existsSync(f))!;
interface GoldenLeg { side: "short" | "long"; option_type: "CALL" | "PUT"; strike: number; qty?: number }
const cases = (JSON.parse(readFileSync(GOLDEN, "utf8")) as {
  cases: { fn: string; name: string; args: [GoldenLeg[], number, number]; expect: Payoff }[];
}).cases.filter((c) => c.fn === "payoffAtExpiry");

/** What the legs settle for with SPX at `s`, worked out here from the case's own arguments rather
 *  than from its answer: intrinsic value, each leg as many times as its quantity, across the count. */
function settled([legs, entry, contracts]: [GoldenLeg[], number, number], s: number): number {
  let pay = 0;
  for (const l of legs) {
    const worth = l.option_type === "CALL" ? Math.max(0, s - l.strike) : Math.max(0, l.strike - s);
    pay += (l.side === "short" ? 1 : -1) * (l.qty ?? 1) * worth;
  }
  return (entry - pay) * contracts;
}

describe("the P&L at a price is the domain's, case for case", () => {
  it("has the domain's cases, a quantity among them", () => {
    expect(cases.length).toBeGreaterThan(10);
    expect(cases.some((c) => c.args[0].some((l) => (l.qty ?? 1) !== 1))).toBe(true);
  });
  for (const c of cases) {
    it(c.name, () => {
      const p = c.expect;
      const strikes = p.at_strikes.map((a) => a.spx);
      const { d0, d1 } = payoffWindow(p, null);
      // every strike, every breakeven, the window's ends and points between and beyond them
      const at = [...strikes, ...p.breakevens, d0, d1, ...strikes.map((k) => k - 7.5), ...strikes.map((k) => k + 7.5)];
      for (const s of at.filter((x) => x >= 0)) {
        expect(pnlAt(p, s), `at ${s}`).toBeCloseTo(settled(c.args, s), 3);
      }
      for (const b of p.breakevens) expect(pnlAt(p, b), `breakeven ${b}`).toBeCloseTo(0, 3);
      // the window shows every strike and every breakeven
      for (const s of [...strikes, ...p.breakevens]) {
        expect(s).toBeGreaterThan(d0);
        expect(s).toBeLessThan(d1);
      }
    });
  }
});

describe("the window", () => {
  const p = cases.find((c) => c.name === "a four-leg condor, its legs in any order")!.expect;

  it("holds SPX's price too, and ends on its step", () => {
    const w = payoffWindow(p, 6900.5);
    expect(w.d0).toBeLessThan(6450);
    expect(w.d1).toBeGreaterThan(7150);
    expect(w.d0 % w.step).toBe(0);
    expect(w.d1 % w.step).toBe(0);
    const far = payoffWindow(p, 7600);
    expect(far.d1).toBeGreaterThan(7600);
  });

  it("steps by a round number of points, a few hundred stops at most across it", () => {
    const w = payoffWindow(p, null);
    expect([1, 2, 5, 10, 25, 50, 100]).toContain(w.step);
    expect((w.d1 - w.d0) / w.step).toBeLessThanOrEqual(200);
    expect((w.d1 - w.d0) / w.step).toBeGreaterThan(20);
  });

  it("never reaches below an index of zero", () => {
    expect(payoffWindow({ ...p, at_strikes: [{ spx: 5, pnl: 0 }], breakevens: [] }, null).d0).toBeGreaterThanOrEqual(0);
  });
});

describe("where the crosshair goes", () => {
  const w = { d0: 6400, d1: 7200, step: 5 };

  it("snaps a pointer to the step, or onto a marked price within reach", () => {
    expect(snapPrice(6912.4, [], w, 3)).toBe(6910);
    expect(snapPrice(6497.9, [6497], w, 3)).toBe(6497);
    expect(snapPrice(6491, [6497], w, 3)).toBe(6490);
    expect(snapPrice(6000, [], w, 3)).toBe(6400);
    expect(snapPrice(9000, [], w, 3)).toBe(7200);
  });

  it("steps with the arrows from SPX, through the step and every marked price on the way", () => {
    const stops = priceStops(w, [6497, 7103]);
    expect(stepPrice("ArrowRight", null, stops, 6900.5)).toBe(6900);
    expect(stepPrice("ArrowLeft", null, stops, null)).toBe(6800);
    expect(stepPrice("ArrowRight", 6495, stops, null)).toBe(6497);
    expect(stepPrice("ArrowRight", 6497, stops, null)).toBe(6500);
    expect(stepPrice("ArrowLeft", 6500, stops, null)).toBe(6497);
    expect(stepPrice("ArrowRight", 7200, stops, null)).toBe(7200);
    expect(stepPrice("Home", 6900, stops, null)).toBe(6400);
    expect(stepPrice("End", 6900, stops, null)).toBe(7200);
  });

  it("lets go on Escape, and leaves an Escape with nothing chosen to the page", () => {
    const stops = priceStops(w, []);
    expect(stepPrice("Escape", 6900, stops, null)).toBe("clear");
    expect(stepPrice("Escape", null, stops, null)).toBeUndefined();
    expect(stepPrice("a", 6900, stops, null)).toBeUndefined();
  });
});

describe("how a P&L is said", () => {
  const held: PayoffUnit = { contracts: 2, size: 100, hidden: false, perContract: true };
  const one: PayoffUnit = { contracts: 1, size: null, hidden: false, perContract: false };

  it("in points per contract, and in money across the contracts held", () => {
    expect(pnlWords(10, held)).toBe("+5.00 pts per contract · +$1,000");
    expect(pnlWords(-90, held)).toBe("-45.00 pts per contract · -$9,000");
    expect(pnlWords(0, held)).toBe("0.00 pts per contract · $0");
    expect(shortWords(10, held)).toBe("+$1,000");
  });

  it("hides the money under privacy, and keeps the points, which say no count", () => {
    const priv = { ...held, hidden: true };
    expect(pnlWords(10, priv)).toBe("+5.00 pts per contract · $•••");
    expect(pnlWords(10, priv)).not.toMatch(/\$\d/);
    expect(shortWords(-90, priv)).toBe("-45.00 pts");
  });

  it("in points alone for one spread nobody holds", () => {
    expect(pnlWords(2.4, one)).toBe("+2.40 pts");
    expect(shortWords(-47.6, one)).toBe("-47.60 pts");
  });

  it("reads out the price, its distance from SPX and the P&L there", () => {
    const p = cases.find((c) => c.name === "a short call spread, two contracts")!.expect;
    const r = readout(7125, p, held, 7000.25);
    expect(r.price).toBe("SPX 7125");
    expect(r.away).toBe("124.75 above SPX now");
    expect(r.pnl).toBe("-23.60 pts per contract · -$4,720");
    expect(r.words).toBe("at expiry with SPX at 7125, 124.75 above SPX now: -23.60 pts per contract · -$4,720");
    expect(readout(6900, p, held, 7000).away).toBe("100.00 below SPX now");
    expect(readout(7000, p, held, 7000).away).toBe("at SPX now");
    expect(readout(7000, p, held, null).away).toBeNull();
  });

  it("writes a level whole where it is whole, else to the cent", () => {
    expect(level(6295)).toBe("6295");
    expect(level(7001.25)).toBe("7001.25");
  });
});

describe("labels that would overlap are joined", () => {
  it("keeps apart what has room, and joins what has not, centred on its members", () => {
    const out = labelRows([{ x: 10, w: 20, v: "a" }, { x: 100, w: 20, v: "b" }, { x: 112, w: 20, v: "c" }], 4, 0, 300);
    expect(out.map((c) => c.items.map((i) => i.v))).toEqual([["a"], ["b", "c"]]);
    expect(out[1]!.x).toBe(106);
  });

  it("keeps a label inside the drawing", () => {
    const [c] = labelRows([{ x: 2, w: 40, v: "a" }], 4, 0, 300);
    expect(c!.x).toBe(20);
    const [d] = labelRows([{ x: 299, w: 40, v: "a" }], 4, 0, 300);
    expect(d!.x).toBe(280);
  });
});

describe("a joined label wider than the drawing", () => {
  it("is broken into rows, each inside the drawing, what will not join a full one going under it", () => {
    const legs = [0, 1, 2, 3, 4, 5].map((i) => ({ x: 100 + i * 8, w: 50, v: i }));
    const rows = labelRows([...legs, { x: 280, w: 30, v: 9 }], 6, 0, 300);
    expect(rows.map((r) => [r.row, r.items.map((i) => i.v)])).toEqual([
      [0, [0, 1, 2, 3, 4]], [1, [5]], [1, [9]],
    ]);
    for (const r of rows) {
      expect(r.x - r.w / 2).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w / 2).toBeLessThanOrEqual(300);
    }
  });

  it("is one row where it fits", () => {
    expect(labelRows([{ x: 10, w: 20, v: 1 }, { x: 100, w: 20, v: 2 }], 6, 0, 300).map((r) => r.row)).toEqual([0, 0]);
  });
});
