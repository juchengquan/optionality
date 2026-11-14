/** The shared crosshair's stops and the IV and SPX panels' words (#395), with no chart drawn. */
import { describe, expect, it } from "vitest";

import { ivLines, nowDte, spxLines, stopsOf, strikeWords } from "../historyDays";
import { SAMPLES } from "../testing/ownerBook";

const days = SAMPLES["h-calls"]!.samples;

describe("the stops", () => {
  it("are every recorded day, oldest first, then today's valuation", () => {
    const stops = stopsOf(days, 38);
    expect(stops.map((s) => s.on)).toEqual([...days.map((d) => d.observed_on), null]);
    expect(stops.at(-1)).toEqual({ on: null, dte: 38, sample: null });
  });

  it("have no valuation for a closed trade, one valued at nothing, or one past expiry", () => {
    expect(nowDte({ closed_on: "2026-11-09", dte: 38, cost_to_close: 4, spx: 6900 })).toBeNull();
    expect(nowDte({ closed_on: null, dte: 38, cost_to_close: null })).toBeNull();
    expect(nowDte({ closed_on: null, dte: -1, cost_to_close: 4 })).toBeNull();
    // SPX's price alone is a valuation to stop at: its panel has a figure
    expect(nowDte({ closed_on: null, dte: 38, cost_to_close: null, spx: 6900 })).toBe(38);
    expect(nowDte({ closed_on: null, dte: 38, cost_to_close: 4 })).toBe(38);
    // out of the session the valuation IS the latest close (#380): that day is already a stop, and
    // restated as "now" it was said twice (#399's review)
    expect(nowDte({ closed_on: null, dte: 38, cost_to_close: 4, spx: 6900, valued_from: "close" })).toBeNull();
    expect(nowDte({ closed_on: null, dte: 38, cost_to_close: 4, valued_from: "live" })).toBe(38);
  });
});

describe("a short strike's distance", () => {
  const k = { code: "c", option_type: "PUT" as const, strike: 6400, delta: null, points: 495.75, sigma: null, one_sigma: null };
  it("says no σ on the expiry day, where no time is left, and for want of an IV before it", () => {
    expect(strikeWords(k, 0, false)).toBe("495.75 pts away · no σ on the expiry day");
    expect(strikeWords(k, 3, false)).toBe("495.75 pts away · no σ: no IV that day");
    expect(strikeWords({ ...k, points: null }, 3, true)).toBe("— no SPX now");
    expect(strikeWords({ ...k, points: -12.5, sigma: -0.03 }, 3, false)).toBe("12.50 pts · 0.03σ past it");
  });
});

describe("the readouts", () => {
  it("say the stop's own day: neither the day before nor the day after", () => {
    const stops = stopsOf(days, null);
    const legs = [{ code: "US.SPXW261218C7300000", leg: { short: true, option_type: "CALL", strike: 7300 } }];
    stops.forEach((stop, i) => {
      expect(ivLines(stop, legs).day.startsWith(`${Number(days[i]!.observed_on.slice(8))} Nov`)).toBe(true);
      expect(spxLines(stop, { closed_on: null }).spx).toBe(`SPX ${days[i]!.spx!.toFixed(2)}`);
    });
  });
});
