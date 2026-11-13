/** The payoff at expiry (#291, ADR 0023): what a structure is worth on its expiry day, at every SPX
 *  level, against the Entry taken for it. No pricing model, no market data — only the legs, the
 *  Entry and the count — which is why it is the one chart ADR 0023 lets the page draw today.
 */
import { describe, expect, it } from "vitest";

import { payoffAtExpiry } from "./payoff.ts";
import type { Leg } from "./position.ts";

const short = (option_type: "CALL" | "PUT", strike: number): Leg => ({ side: "short", option_type, strike });
const long = (option_type: "CALL" | "PUT", strike: number): Leg => ({ side: "long", option_type, strike });

describe("a short put spread", () => {
  const p = payoffAtExpiry([short("PUT", 6400), long("PUT", 6350)], 1.5, 1);

  it("keeps the credit above the short strike and loses the width less it below the long", () => {
    expect(p.at_strikes).toEqual([{ spx: 6350, pnl: -48.5 }, { spx: 6400, pnl: 1.5 }]);
    // flat beyond both strikes: the long put caps the loss, and no call is held
    expect(p.slope_below).toBe(0);
    expect(p.slope_above).toBe(0);
  });

  it("breaks even the credit below the short strike", () => {
    expect(p.breakevens).toEqual([6398.5]);
  });

  it("makes at most the credit and loses at most the width less it", () => {
    expect(p.max_profit).toBe(1.5);
    expect(p.max_loss).toBe(-48.5);
  });
});

describe("a short call spread, two contracts", () => {
  const p = payoffAtExpiry([short("CALL", 7300), long("CALL", 7350)], 2, 2);

  it("counts every figure across the contracts held, in points", () => {
    expect(p.at_strikes).toEqual([{ spx: 7300, pnl: 4 }, { spx: 7350, pnl: -96 }]);
    expect(p.max_profit).toBe(4);
    expect(p.max_loss).toBe(-96);
  });

  it("breaks even the credit above the short strike, whatever the count", () => {
    expect(p.breakevens).toEqual([7302]);
  });
});

describe("a four-leg condor", () => {
  const legs = [short("CALL", 7400), long("CALL", 7450), short("PUT", 6300), long("PUT", 6250)];
  const p = payoffAtExpiry(legs, 5, 1);

  it("has the P&L at each strike, lowest first, whatever order the legs came in", () => {
    expect(p.at_strikes.map((a) => a.spx)).toEqual([6250, 6300, 7400, 7450]);
    expect(p.at_strikes.map((a) => a.pnl)).toEqual([-45, 5, 5, -45]);
  });

  it("breaks even on both sides", () => {
    expect(p.breakevens).toEqual([6295, 7405]);
  });
});

describe("a long put spread, bought for a debit", () => {
  // a debit is a NEGATIVE entry, as everywhere else (ADR 0013)
  const p = payoffAtExpiry([long("PUT", 6400), short("PUT", 6350)], -10, 1);

  it("loses the debit above and makes the width less it below", () => {
    expect(p.at_strikes).toEqual([{ spx: 6350, pnl: 40 }, { spx: 6400, pnl: -10 }]);
    expect(p.breakevens).toEqual([6390]);
    expect(p.max_profit).toBe(40);
    expect(p.max_loss).toBe(-10);
  });
});

describe("a wrong leg sign, which is what the preview is for", () => {
  it("says a credit taken on a spread that was bought can never lose", () => {
    // the put spread's sides swapped: the lowest P&L is POSITIVE, and that is the tell
    const p = payoffAtExpiry([long("PUT", 6400), short("PUT", 6350)], 1.5, 1);
    expect(p.max_loss).toBe(1.5);
    expect(p.max_profit).toBe(51.5);
    expect(p.breakevens).toEqual([]);
  });

  it("names no floor when a call's long leg was entered as short", () => {
    const p = payoffAtExpiry([short("CALL", 7300), short("CALL", 7350)], 2, 1);
    // P&L falls two points for each point SPX rises past the higher strike, for ever
    expect(p.slope_above).toBe(-2);
    expect(p.max_loss).toBeNull();
    expect(p.max_profit).toBe(2);
  });
});

describe("beyond the outer strikes", () => {
  it("names no ceiling for a long call", () => {
    const p = payoffAtExpiry([long("CALL", 7300)], -20, 1);
    expect(p.slope_above).toBe(1);
    expect(p.max_profit).toBeNull();
    expect(p.max_loss).toBe(-20);
    expect(p.breakevens).toEqual([7320]);
  });

  it("stops a put's loss at an index of zero, where SPX cannot go below", () => {
    const p = payoffAtExpiry([short("PUT", 6400)], 30, 1);
    expect(p.slope_below).toBe(1);
    expect(p.max_loss).toBe(-6370);
    expect(p.max_profit).toBe(30);
  });

  it("finds a breakeven on the far side of the last strike", () => {
    const p = payoffAtExpiry([short("CALL", 7300)], 4.25, 1);
    expect(p.breakevens).toEqual([7304.25]);
  });
});

it("draws a strike two legs share once", () => {
  // an iron butterfly: both short legs on 6900
  const p = payoffAtExpiry(
    [short("CALL", 6900), short("PUT", 6900), long("CALL", 6950), long("PUT", 6850)], 30, 1);
  expect(p.at_strikes).toEqual([{ spx: 6850, pnl: -20 }, { spx: 6900, pnl: 30 }, { spx: 6950, pnl: -20 }]);
  expect(p.breakevens).toEqual([6870, 6930]);
});

it("rounds to four places, as every points figure is", () => {
  const p = payoffAtExpiry([short("PUT", 6400), long("PUT", 6350)], 0.1 + 0.2, 3);
  expect(p.at_strikes[1]!.pnl).toBe(0.9);
});

describe("a quantity per leg (#351)", () => {
  it("settles a 1×2 put ratio's short leg twice over", () => {
    // long the 7100, short two 7050s, for a credit of 1
    const p = payoffAtExpiry([long("PUT", 7100), { ...short("PUT", 7050), qty: 2 }], 1, 1);
    expect(p.at_strikes).toEqual([{ spx: 7050, pnl: 51 }, { spx: 7100, pnl: 1 }]);
    // below the short strike two puts are owed against one held: a point lost per point it falls
    expect(p.slope_below).toBe(1);
    expect(p.breakevens).toEqual([6999]);
    expect(p.max_profit).toBe(51);
    // bounded only because SPX stops at zero: 7100 - 2 × 7050 + 1
    expect(p.max_loss).toBe(-6999);
  });

  it("draws a butterfly as a tent on its middle strike", () => {
    const p = payoffAtExpiry([long("CALL", 7000), { ...short("CALL", 7050), qty: 2 }, long("CALL", 7100)], -1, 1);
    expect(p.at_strikes).toEqual([{ spx: 7000, pnl: -1 }, { spx: 7050, pnl: 49 }, { spx: 7100, pnl: -1 }]);
    expect(p.slope_above).toBe(0);
    expect(p.breakevens).toEqual([7001, 7099]);
  });

  it("reads a leg with no quantity as one", () => {
    const legs = [short("PUT", 6400), long("PUT", 6350)];
    expect(payoffAtExpiry(legs.map((l) => ({ ...l, qty: 1 })), 1.5, 1)).toEqual(payoffAtExpiry(legs, 1.5, 1));
  });
});
