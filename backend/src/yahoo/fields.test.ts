import { describe, expect, it } from "vitest";

import { toRecord } from "./fields.ts";

/** Yahoo's quote, under the service's names — and the one field that must NOT be carried.
 *
 *  The rows here are what Yahoo actually returned on 2026-11-08, including the bogus book.
 */

/** `^GSPC` as it really came back: a correct price beside a bid and ask that are not a book. */
const GSPC = {
  symbol: "^GSPC", shortName: "S&P 500",
  regularMarketPrice: 7376.86, regularMarketPreviousClose: 7353.73,
  bid: 7524.56, ask: 7624.67,
  exchangeDataDelayedBy: 0, marketState: "CLOSED",
};

const VIX = {
  symbol: "^VIX", shortName: "CBOE Volatility Index",
  regularMarketPrice: 25.64, regularMarketPreviousClose: 28.18,
  bid: 0, ask: 0, exchangeDataDelayedBy: 15, marketState: "CLOSED",
};

describe("the bid and ask, which are dropped on purpose", () => {
  it("carries no book, because an index does not have one", () => {
    // 7524.56 / 7624.67 for an index that closed at 7376.86 — a bid 148 points above the price
    // and a 100-point spread. Not a book: some other figure under a familiar name.
    const got = toRecord("^GSPC", GSPC);
    expect(got.bid_price).toBe(undefined);
    expect(got.ask_price).toBe(undefined);
  });

  it("carries no mid either, so the domain reads the price Yahoo means", () => {
    // `domain/reference.ts` PREFERS the mid, so a mid derived from that book would have put
    // 7,574 on the strip instead of 7,376 — and looked entirely plausible
    const got = toRecord("^GSPC", GSPC);
    expect(got.mid_price).toBe(undefined);
    expect(got.last_price).toBe(7376.86);
  });
});

describe("the figures it does carry", () => {
  it("is the regular-market price and the previous close", () => {
    expect(toRecord("^GSPC", GSPC)).toMatchObject({
      code: "^GSPC", name: "S&P 500", last_price: 7376.86, prev_close_price: 7353.73,
    });
  });

  it("matches Cboe's own published close, which is how it was checked", () => {
    // Cboe's delayed-quote endpoint gave 7376.86 for the same session
    expect(toRecord("^GSPC", GSPC).last_price).toBe(7376.86);
  });
});

describe("freshness, from Yahoo's own fields", () => {
  it("is not delayed where Yahoo says zero minutes", () => {
    const got = toRecord("^GSPC", GSPC);
    expect(got.delayed).toBe(false);
    expect(got.delayed_by_minutes).toBe(undefined);
  });

  it("states the minutes where Yahoo does — the only source that can", () => {
    // IBKR reports a TIER and no duration, so the strip says "delayed" for one vendor and
    // "15m late" for the other: each what its vendor actually said (ADR 0019)
    const got = toRecord("^VIX", VIX);
    expect(got.delayed).toBe(true);
    expect(got.delayed_by_minutes).toBe(15);
  });

  it("says the figure is the last one held outside the regular session", () => {
    expect(toRecord("^GSPC", GSPC).last_known).toBe(true);
    expect(toRecord("^GSPC", { ...GSPC, marketState: "REGULAR" }).last_known).toBe(false);
  });

  it("treats pre- and post-market as last known, because an index is not calculated then", () => {
    for (const state of ["PRE", "POST", "POSTPOST", "PREPRE"]) {
      expect(toRecord("^GSPC", { ...GSPC, marketState: state }).last_known, state).toBe(true);
    }
  });

  it("says nothing where Yahoo said nothing, rather than claiming live", () => {
    // null and false are different claims: false means "it told us it is live"
    const got = toRecord("^GSPC", { symbol: "^GSPC", regularMarketPrice: 1 });
    expect(got.delayed).toBe(undefined);
    expect(got.last_known).toBe(undefined);
  });
});
