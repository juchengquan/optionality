/** What a Reference reads, and from which field (ADR 0018).
 *
 *  The ordering is the decision, and it comes from a live measurement rather than from taste: on
 *  2026-11-02 `US.SPY`'s last trade read 755.72 while its own book gave a mid of 758.73 — the last
 *  was the previous session's and the book was current pre-market. Every other figure on this
 *  dashboard is a mid for the same reason, so a Reference that fell back to the last by preference
 *  would be the one stale number on the page.
 */
import { describe, expect, it } from "vitest";

import { referenceFigure } from "./reference.ts";

/** US.SPY as the Provider gave it on 2026-11-02, trimmed to the four fields this reads. */
const spy = {
  code: "US.SPY", name: "SPDR S&P 500 ETF Trust",
  bid_price: 758.7, ask_price: 758.76, mid_price: 758.73,
  last_price: 755.72, prev_close_price: 755.72,
};

describe("which field the figure comes from", () => {
  it("prefers the mid, because the last trade can be a session old", () => {
    const r = referenceFigure(spy, null);
    expect(r.field).toBe("mid_price");
    expect(r.figure).toBe(758.73);
  });

  it("falls back to the last trade where there is no two-sided quote", () => {
    // `mid_price` is DERIVED from both sides and only when both are there (opend/snapshot.ts), so
    // its absence is exactly "no two-sided quote" and needs no bid/ask reasoning here
    const { mid_price: _mid, ...oneSided } = spy;
    const r = referenceFigure(oneSided, null);
    expect(r.field).toBe("last_price");
    expect(r.figure).toBe(755.72);
  });

  it("says there is no figure when neither arrived, rather than reading a zero", () => {
    const r = referenceFigure({ code: "US.SPY", name: "SPDR S&P 500 ETF Trust" }, 10);
    expect(r).toEqual({ figure: null, field: null, change: null });
  });

  it("has no figure for no quote at all — a Reference the batch could not price", () => {
    expect(referenceFigure(null, 10)).toEqual({ figure: null, field: null, change: null });
  });

  it("refuses a zero mid and reads the last trade instead", () => {
    // an empty book quotes 0/0, and `(0 + 0) / 2` is a mid: times a scale of 10 it is still 0,
    // and 0 prints as a price. This is the shape ADR 0018 names.
    const r = referenceFigure({ ...spy, bid_price: 0, ask_price: 0, mid_price: 0 }, 10);
    expect(r.field).toBe("last_price");
    expect(r.figure).toBe(7557.2);
  });

  it("refuses a figure that is not a number at all", () => {
    // moomoo is a wire format with no published schema; a field can arrive as a string
    const r = referenceFigure({ mid_price: "758.73", last_price: null }, null);
    expect(r).toEqual({ figure: null, field: null, change: null });
  });

  it("refuses an infinite one", () => {
    expect(referenceFigure({ mid_price: Infinity }, null).figure).toBeNull();
  });
});

describe("the scale", () => {
  it("multiplies, so SPY stands in for SPX at the strikes beside it", () => {
    expect(referenceFigure(spy, 10).figure).toBe(7587.3);
  });

  it("treats no scale as ×1, which is what null means", () => {
    expect(referenceFigure(spy, null).figure).toBe(758.73);
  });

  it("rounds the product, so float noise never reaches the page", () => {
    // 20.15 * 3 is 60.44999999999999 in both languages
    expect(referenceFigure({ mid_price: 20.15 }, 3).figure).toBe(60.45);
  });

  it("scales a fractional multiplier too, for a proxy that quotes high", () => {
    expect(referenceFigure({ mid_price: 7587.3 }, 0.1).figure).toBe(758.73);
  });
});

describe("the change against the previous close", () => {
  it("is a fraction of that close, which no scale can move", () => {
    const quote = { mid_price: 758.73, prev_close_price: 755.72 };
    const unscaled = referenceFigure(quote, null).change;
    expect(referenceFigure(quote, 10).change).toBe(unscaled);
    expect(unscaled).toBeCloseTo(0.003983, 6);
  });

  it("is negative on a day down", () => {
    expect(referenceFigure({ mid_price: 750, prev_close_price: 755.72 }, 10).change)
      .toBeLessThan(0);
  });

  it("is null where no close arrived, rather than a change from nothing", () => {
    expect(referenceFigure({ mid_price: 758.73 }, null).change).toBeNull();
  });

  it("is null where the close is zero, which would divide by it", () => {
    expect(referenceFigure({ mid_price: 758.73, prev_close_price: 0 }, null).change).toBeNull();
  });

  it("is null where there is no figure to compare, close or no close", () => {
    expect(referenceFigure({ prev_close_price: 755.72 }, null).change).toBeNull();
  });

  it("is measured from the same field the figure came from", () => {
    // the fallback's change must be the LAST against the close, not the mid against it: a reading
    // and a change drawn from two different fields is the pair of numbers that cannot both be true
    const r = referenceFigure({ last_price: 750, prev_close_price: 755.72 }, null);
    expect(r.field).toBe("last_price");
    expect(r.change).toBe((750 - 755.72) / 755.72);
  });

  it("ignores a mid that is PRESENT but not a price, on both sides at once", () => {
    // the only shape where the two fields disagree about which is true: an empty book quotes 0/0,
    // so `mid_price` is there and is not a price. A change computed from it reads -100% — the
    // whole market gone — beside a figure that moved by a point. Found by mutating the reading
    // and the change apart: every other case has at most one of the two fields, so nothing else
    // could tell them apart.
    const r = referenceFigure({ mid_price: 0, last_price: 750, prev_close_price: 755.72 }, 10);
    expect(r.field).toBe("last_price");
    expect(r.figure).toBe(7500);
    expect(r.change).toBe((750 - 755.72) / 755.72);
  });
});
