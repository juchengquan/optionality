import { describe, expect, it } from "vitest";

import { DEFAULT_BAND, imminentReading, pressure } from "../columns";

/** Which reading earns the second colour.
 *
 *  The bar is unaffected by any of this: it is always the distance travelled toward the threshold.
 *  What a signal decides is when a row stops being merely watched and starts being flagged.
 */
describe("pressure", () => {
  it("leaves a fill alone once expiry is inside the horizon", () => {
    // nothing left to discount: at or past the manage-by date, close IS urgent
    expect(pressure(70, 21, 21)).toBe(70);
    expect(pressure(70, 3, 21)).toBe(70);
    expect(pressure(70, 0, 21)).toBe(70);
  });

  it("halves a fill at twice the horizon", () => {
    expect(pressure(90, 42, 21)).toBeCloseTo(45, 10);
  });

  it("drops the loudest row in the live book below the quietest near-dated one", () => {
    // 2026-10-17: 1204_BS_6950 sits at 99% of its threshold with 48 DTE — the loudest row on the
    // screen and the least urgent thing owned. A 70% at 3 DTE is the opposite.
    expect(pressure(99, 48, 21)).toBeLessThan(pressure(70, 3, 21));
  });

  it("cannot divide by a horizon of nothing", () => {
    expect(pressure(80, 10, 0)).toBe(80);
  });
});

describe("the reading a band is measured against", () => {
  it("is the fill itself in distance mode, whatever the expiry", () => {
    // the band is a fact about the ALARM: one small move and Telegram sends, at 3 DTE or 48
    expect(imminentReading(99, 48, "distance", 21)).toBe(99);
    expect(imminentReading(99, 3, "distance", 21)).toBe(99);
  });

  it("is the weighted figure in pressure mode", () => {
    expect(imminentReading(99, 48, "pressure", 21)).toBeCloseTo(99 * 21 / 48, 10);
  });

  it("starts at the band the dashboard has always used", () => {
    expect(DEFAULT_BAND).toBe(90);
  });
});
