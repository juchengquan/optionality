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
    const r = referenceFigure(spy);
    expect(r.field).toBe("mid_price");
    expect(r.figure).toBe(758.73);
  });

  it("falls back to the last trade where there is no two-sided quote", () => {
    // `mid_price` is DERIVED from both sides and only when both are there (opend/snapshot.ts), so
    // its absence is exactly "no two-sided quote" and needs no bid/ask reasoning here
    const { mid_price: _mid, ...oneSided } = spy;
    const r = referenceFigure(oneSided);
    expect(r.field).toBe("last_price");
    expect(r.figure).toBe(755.72);
  });

  it("says there is no figure when neither arrived, rather than reading a zero", () => {
    const r = referenceFigure({ code: "US.SPY", name: "SPDR S&P 500 ETF Trust" });
    expect(r).toEqual({ figure: null, field: null, change: null });
  });

  it("has no figure for no quote at all — a Reference the batch could not price", () => {
    expect(referenceFigure(null)).toEqual({ figure: null, field: null, change: null });
  });

  it("refuses a zero mid and reads the last trade instead", () => {
    // an empty book quotes 0/0, and `(0 + 0) / 2` is a mid — and 0 prints as a price. This is
    // the shape ADR 0018 names, and dropping the scale does not change it.
    const r = referenceFigure({ ...spy, bid_price: 0, ask_price: 0, mid_price: 0 });
    expect(r.field).toBe("last_price");
    expect(r.figure).toBe(755.72);
  });

  it("refuses a figure that is not a number at all", () => {
    // moomoo is a wire format with no published schema; a field can arrive as a string
    const r = referenceFigure({ mid_price: "758.73", last_price: null });
    expect(r).toEqual({ figure: null, field: null, change: null });
  });

  it("refuses an infinite one", () => {
    expect(referenceFigure({ mid_price: Infinity }).figure).toBeNull();
  });
});

/** The scale had a describe block of its own here: it multiplied, it treated null as ×1, and it
 *  rounded the product. ADR 0019 dropped the column, so the arithmetic and its four tests went
 *  with it — a scaled stand-in is a simulation rather than a reading. `round4` is still exercised
 *  by the rounding assertions below and by the golden cases.
 */
describe("the change against the previous close", () => {
  it("is a fraction of that close", () => {
    const quote = { mid_price: 758.73, prev_close_price: 755.72 };
    const unscaled = referenceFigure(quote).change;
    expect(referenceFigure(quote).change).toBe(unscaled);
    expect(unscaled).toBeCloseTo(0.003983, 6);
  });

  it("is negative on a day down", () => {
    expect(referenceFigure({ mid_price: 750, prev_close_price: 755.72 }).change)
      .toBeLessThan(0);
  });

  it("is null where no close arrived, rather than a change from nothing", () => {
    expect(referenceFigure({ mid_price: 758.73 }).change).toBeNull();
  });

  it("is null where the close is zero, which would divide by it", () => {
    expect(referenceFigure({ mid_price: 758.73, prev_close_price: 0 }).change).toBeNull();
  });

  it("is null where there is no figure to compare, close or no close", () => {
    expect(referenceFigure({ prev_close_price: 755.72 }).change).toBeNull();
  });

  it("is measured from the same field the figure came from", () => {
    // the fallback's change must be the LAST against the close, not the mid against it: a reading
    // and a change drawn from two different fields is the pair of numbers that cannot both be true
    const r = referenceFigure({ last_price: 750, prev_close_price: 755.72 });
    expect(r.field).toBe("last_price");
    expect(r.change).toBe((750 - 755.72) / 755.72);
  });

  it("ignores a mid that is PRESENT but not a price, on both sides at once", () => {
    // the only shape where the two fields disagree about which is true: an empty book quotes 0/0,
    // so `mid_price` is there and is not a price. A change computed from it reads -100% — the
    // whole market gone — beside a figure that moved by a point. Found by mutating the reading
    // and the change apart: every other case has at most one of the two fields, so nothing else
    // could tell them apart.
    const r = referenceFigure({ mid_price: 0, last_price: 750, prev_close_price: 755.72 });
    expect(r.field).toBe("last_price");
    expect(r.figure).toBe(750);
    expect(r.change).toBe((750 - 755.72) / 755.72);
  });
});
