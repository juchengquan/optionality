import { describe, expect, it } from "vitest";

import { GREEK_TICKS, PRICE_TICKS, grade, greekFields, hasFigures, withMid } from "./fields.ts";

/** The translation from IB Gateway's numbers to the service's names.
 *
 *  Two of these are not renames and both were measured on 2026-11-08 against the live gateway:
 *  implied volatility changes units, and the four data grades are two independent facts.
 */

describe("implied volatility, which changes units", () => {
  it("multiplies IBKR's fraction into the service's percent", () => {
    // measured, same contract, same minute: moomoo said 14.007 and IBKR said 0.1368. A rule set
    // at 14 would never fire on IBKR; one set at 0.14 would fire constantly on moomoo.
    const got = greekFields({
      impliedVol: 0.13679778548286392, delta: null, gamma: null, vega: null, theta: null,
    });
    // closeTo rather than toEqual: `0.13679778548286392 * 100` is not the decimal literal, and
    // the claim is the MAGNITUDE — a percent rather than a fraction — not the last bit of it
    expect(got.option_implied_volatility).toBeCloseTo(13.6797785, 7);
    expect(got.option_implied_volatility).toBeGreaterThan(1);
  });

  it("leaves the greeks themselves alone, which are already dimensionless", () => {
    const got = greekFields({
      impliedVol: null, delta: 0.02806614063578037, gamma: 0.00018826189971762677,
      vega: 1.8321828845155324, theta: -0.28028107934963487,
    });
    expect(got).toEqual({
      option_delta: 0.02806614063578037,
      option_gamma: 0.00018826189971762677,
      option_vega: 1.8321828845155324,
      option_theta: -0.28028107934963487,
    });
  });

  it("omits a greek that was not computed rather than writing null", () => {
    // a null delta and an absent one are the same thing to the dashboard, but a WRITTEN null
    // would satisfy `hasFigures` and claim the contract answered
    expect(greekFields({ impliedVol: null, delta: null, gamma: null, vega: null, theta: null }))
      .toEqual({});
  });
});

describe("the four grades, as two facts", () => {
  it("reads each one", () => {
    expect(grade(1)).toEqual({ delayed: false, last_known: false });
    expect(grade(2)).toEqual({ delayed: false, last_known: true });
    expect(grade(3)).toEqual({ delayed: true, last_known: false });
    expect(grade(4)).toEqual({ delayed: true, last_known: true });
  });

  it("keeps grade 4 as BOTH, rather than collapsing it", () => {
    // the gateway drew this distinction per contract in one response on 2026-11-08 — SPX granted
    // DELAYED while VIX granted DELAYED_FROZEN — so throwing one away is deciding we know better
    expect(grade(4)).not.toEqual(grade(3));
    expect(grade(4)).not.toEqual(grade(2));
  });

  it("says nothing about a grade nobody documented", () => {
    // null renders as nothing, which is what the strip shows for a source that did not say. False
    // would read as "live and updating", which is a claim.
    expect(grade(0)).toBe(null);
    expect(grade(7)).toBe(null);
  });
});

describe("the mid, which is derived rather than sent", () => {
  it("is the midpoint where both sides arrived", () => {
    expect(withMid({ bid_price: 3.5, ask_price: 4.1 }).mid_price).toBe(3.8);
  });

  it("is absent where only one side did", () => {
    // a mid from one side is a number with no meaning, and `domain/reference.ts` PREFERS the mid
    expect(withMid({ bid_price: 3.5 }).mid_price).toBe(undefined);
    expect(withMid({ ask_price: 4.1 }).mid_price).toBe(undefined);
  });

  it("is zero for an empty book, and left for the domain to judge", () => {
    // 0/0 is an empty book, and whether 0 may be SHOWN is ADR 0018's positivity guard to decide
    // for a Reference — not this mapping's to suppress
    expect(withMid({ bid_price: 0, ask_price: 0 }).mid_price).toBe(0);
  });
});

describe("whether anything arrived", () => {
  it("is false for a record carrying only its identity", () => {
    // "subscribed, nothing yet" — a figure that did not arrive, NOT a contract that does not
    // exist. The service keeps those apart (ADR 0015)
    expect(hasFigures({ code: "SPX", name: "S&P 500" })).toBe(false);
  });

  it("is false for identity plus a grade, which is not a figure", () => {
    // the gateway answers the grade for every request, including ones that then price nothing —
    // counting it as a figure would make every silent contract look answered
    expect(hasFigures({ code: "SPX", delayed: true, last_known: true })).toBe(false);
  });

  it("is true for one figure, however little", () => {
    expect(hasFigures({ code: "SPX", prev_close_price: 7353.73 })).toBe(true);
  });
});

describe("the tick ids", () => {
  it("maps the delayed ids to the same fields as the live ones", () => {
    // which TIER answered is reported once per request by the gateway, not inferred from the
    // ids — it contradicted a request once, granting live when asked for delayed
    expect(PRICE_TICKS[66]).toBe(PRICE_TICKS[1]);
    expect(PRICE_TICKS[67]).toBe(PRICE_TICKS[2]);
    expect(PRICE_TICKS[68]).toBe(PRICE_TICKS[4]);
    expect(PRICE_TICKS[75]).toBe(PRICE_TICKS[9]);
  });

  it("reads the model computation, live and delayed, and nothing else", () => {
    // a bid- or ask-implied computation is a different claim from the model's, and so is the
    // CUSTOM computation (53), which this table once named as the delayed model's; the service
    // has one field per greek. The Python's suite checks these against ib_async's own map.
    expect([...GREEK_TICKS].sort((a, b) => a - b)).toEqual([13, 83]);
  });
});
