/** SPX's price, derived from the batch the service already fetches (#288).
 *
 *  moomoo serves each option's `option_premium`, worked out against the index it is quoting at that
 *  moment from the option's LAST price. Inverting it with that same last gives that index level
 *  back. The market-hours check on 2026-11-10 found the median across a batch within 0.05 points
 *  of ^GSPC (p95 0.64), however old the last trade was. The figures below are from that session.
 */
import { describe, expect, it } from "vitest";

import { derivedSpx, oneSigma, sigmaDistance, strikeDistances } from "./quote.ts";

/** 2026-11-10 09:30:01 New York; ^GSPC read 7513.09 at the same instant */
const call = { code: "US.SPXW261113C7475000", last_price: 79.2, option_premium: 0.547 };
const put = { code: "US.SPXW261218P7525000", last_price: 160.24, option_premium: 2 };

describe("one contract's premium, inverted", () => {
  it("gives a call's index level as (strike + last) / (1 + premium)", () => {
    // (7475 + 79.2) / 1.00547 = 7513.1033…
    expect(derivedSpx([call])).toEqual({ price: 7513.1, reason: null });
  });

  it("gives a put's as (strike − last) / (1 − premium)", () => {
    // (7525 − 160.24) / 0.98 = 7515.0612…
    expect(derivedSpx([put])).toEqual({ price: 7515.06, reason: null });
  });

  it("takes a negative premium as it comes: a deep put below its intrinsic value has one", () => {
    // measured: US.SPXW261113P7625000 carried −0.266 and still matched ^GSPC to 0.03
    const s = derivedSpx([{ code: "US.SPXW261113P7625000", last_price: 111.9, option_premium: -0.266 }]);
    expect(s.price).toBe(Number(((7625 - 111.9) / (1 + 0.00266)).toFixed(2)));
  });
});

describe("the batch's figure", () => {
  it("is the median across every contract that has both a last and a premium", () => {
    const third = { code: "US.SPXW261204C7500000", last_price: 120, option_premium: 1.5 };
    // three: the middle one, whatever order they arrive in
    const values = [call, put, third].map((r) => derivedSpx([r]).price!).sort((a, b) => a - b);
    expect(derivedSpx([put, third, call]).price).toBe(values[1]);
  });

  it("averages the middle two when the count is even", () => {
    // 7513.1033… and 7515.0612…, averaged BEFORE rounding
    expect(derivedSpx([call, put]).price).toBe(7514.08);
  });

  it("keeps a contract whose last trade is hours old: moomoo recomputes its premium regardless", () => {
    // the check's error was the same for a last under a minute old and one over 13 hours old,
    // so a staleness filter would only throw away contracts
    const stale = { ...call, update_time: "2026-11-09 20:15:00" };
    expect(derivedSpx([stale]).price).toBe(7513.1);
  });

  it("never inverts the mid: the premium was not worked out from it", () => {
    const withMid = { ...call, mid_price: 81.4, bid_price: 80.9, ask_price: 81.9 };
    expect(derivedSpx([withMid]).price).toBe(7513.1);
  });

  it("leaves out what is not an SPX option, and a contract missing either figure", () => {
    const records = [
      call,
      { code: "US..SPX", last_price: 7600, option_premium: 0 },
      { code: "US.SPXW261113C7500000", last_price: 60 },
      { code: "US.SPXW261113C7550000", option_premium: 0.9 },
      { code: "US.SPXW261113C7575000", last_price: 0, option_premium: 0.9 },
      { code: "US.SPXW261113C7600000", last_price: "12.5", option_premium: 0.9 },
      { code: "US.SPXW261113C7625000", last_price: 10, option_premium: true },
    ];
    expect(derivedSpx(records)).toEqual({ price: 7513.1, reason: null });
  });

  it("drops an inversion that is not a price: a put whose premium is 100% divides by zero", () => {
    const zero = { code: "US.SPXW261113P7500000", last_price: 10, option_premium: 100 };
    expect(derivedSpx([zero, call]).price).toBe(7513.1);
  });
});

describe("no figure, and why", () => {
  it("says so when the batch holds no SPX option", () => {
    expect(derivedSpx([])).toEqual({
      price: null, reason: "no SPX option in the batch to derive it from",
    });
  });

  it("blames the Provider when no option carries a premium, as with IB Gateway", () => {
    const { option_premium: _p, ...bare } = call;
    expect(derivedSpx([bare, { ...put, option_premium: null }])).toEqual({
      price: null, reason: "the Provider gives no option premium to derive it from",
    });
  });

  it("says no contract had both when premiums came without a last trade", () => {
    expect(derivedSpx([{ ...call, last_price: null }])).toEqual({
      price: null, reason: "no option in the batch has both a last trade and a premium",
    });
  });
});

/** How far SPX is from a spread's short strike (#297): in points, and in σ to expiry from the short
 *  leg's own IV, which every Provider serves as a PERCENTAGE (moomoo 18.5, IB Gateway converted). */
describe("sigmaDistance", () => {
  it("is points over SPX × IV × √(DTE/365), with IV a percentage", () => {
    // 7000 × 0.20 × √(36.5/365) = 442.72…; 250 / 442.72 = 0.5647…
    expect(sigmaDistance(250, 7000, 20, 36.5)).toBe(0.56);
  });

  it("keeps the sign of the points: a strike already passed is negative σ", () => {
    expect(sigmaDistance(-250, 7000, 20, 36.5)).toBe(-0.56);
  });

  it("has no figure without an IV, with none left to expiry, or without a price", () => {
    expect(sigmaDistance(250, 7000, 0, 36)).toBeNull();
    expect(sigmaDistance(250, 7000, -3, 36)).toBeNull();
    expect(sigmaDistance(250, 7000, 20, 0)).toBeNull();
    expect(sigmaDistance(250, 0, 20, 36)).toBeNull();
    expect(sigmaDistance(250, 7000, Number.NaN, 36)).toBeNull();
  });
});

/** One σ of SPX to expiry, in points (#298): the ±1σ band the price map draws about SPX, from a
 *  short leg's own IV — the width `sigmaDistance` divides by, served so the browser divides nothing. */
describe("oneSigma", () => {
  it("is SPX × IV × √(DTE/365), with IV a percentage, to two places", () => {
    // 7000 × 0.20 × √(36.5/365) = 442.718…
    expect(oneSigma(7000, 20, 36.5)).toBe(442.72);
  });

  it("has no figure without an IV, a price or a day left to expiry", () => {
    expect(oneSigma(7000, 0, 36)).toBeNull();
    expect(oneSigma(7000, -3, 36)).toBeNull();
    expect(oneSigma(7000, 20, 0)).toBeNull();
    expect(oneSigma(0, 20, 36)).toBeNull();
    expect(oneSigma(7000, Number.NaN, 36)).toBeNull();
    expect(oneSigma(Number.POSITIVE_INFINITY, 20, 36)).toBeNull();
  });
});

describe("strikeDistances", () => {
  const P = "US.SPXW261218P6400000";
  const C = "US.SPXW261218C7300000";
  const byCode = {
    [P]: { code: P, option_delta: -0.21, option_implied_volatility: 18.5 },
    [C]: { code: C, option_delta: 0.33, option_implied_volatility: 12 },
  };

  it("measures each short strike from SPX, positive while SPX has not reached it", () => {
    // a put's strike is reached from above, a call's from below
    expect(strikeDistances([P, C], byCode, 6900.5, 37)).toEqual([
      { code: P, option_type: "PUT", strike: 6400, delta: -0.21, points: 500.5, sigma: 1.23, one_sigma: 406.45 },
      { code: C, option_type: "CALL", strike: 7300, delta: 0.33, points: 399.5, sigma: 1.52, one_sigma: 263.64 },
    ]);
  });

  it("is negative once SPX is past the strike", () => {
    expect(strikeDistances([C], byCode, 7310.25, 37)[0]!.points).toBe(-10.25);
  });

  it("keeps the strike and its delta with no SPX, and measures nothing", () => {
    expect(strikeDistances([P], byCode, null, 37)).toEqual([
      { code: P, option_type: "PUT", strike: 6400, delta: -0.21, points: null, sigma: null, one_sigma: null },
    ]);
  });

  it("has points but no σ where the leg's IV is missing, and no delta where it has none", () => {
    expect(strikeDistances([P], { [P]: { code: P, option_implied_volatility: "18.5" } }, 6900.5, 37))
      .toEqual([{ code: P, option_type: "PUT", strike: 6400, delta: null, points: 500.5, sigma: null, one_sigma: null }]);
    expect(strikeDistances([P], {}, 6900.5, 37)[0]!.sigma).toBeNull();
    expect(strikeDistances([P], {}, 6900.5, 37)[0]!.one_sigma).toBeNull();
  });

  it("leaves out a code that names no SPX option", () => {
    expect(strikeDistances(["US..SPX", P], byCode, 6900.5, 37).map((d) => d.code)).toEqual([P]);
  });
});
