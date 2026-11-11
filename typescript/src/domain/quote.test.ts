/** SPX's price, derived from the batch the service already fetches (#288).
 *
 *  moomoo serves each option's `option_premium`, worked out against the index it is quoting at that
 *  moment from the option's LAST price. Inverting it with that same last gives that index level
 *  back. The market-hours check on 2026-11-10 found the median across a batch within 0.05 points
 *  of ^GSPC (p95 0.64), however old the last trade was. The figures below are from that session.
 */
import { describe, expect, it } from "vitest";

import { derivedSpx } from "./quote.ts";

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
