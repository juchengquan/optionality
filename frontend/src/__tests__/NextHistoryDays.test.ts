/** The shared crosshair's stops and the IV panel's words (#395), with no chart drawn. */
import { describe, expect, it } from "vitest";

import { ivLines, nowDte, stopsOf } from "../historyDays";
import { SAMPLES } from "../testing/ownerBook";

const days = SAMPLES["h-calls"]!.samples;

describe("the stops", () => {
  it("are every recorded day, oldest first, then today's valuation", () => {
    const stops = stopsOf(days, 38);
    expect(stops.map((s) => s.on)).toEqual([...days.map((d) => d.observed_on), null]);
    expect(stops.at(-1)).toEqual({ on: null, dte: 38, sample: null });
  });

  it("have no valuation for a closed trade, one valued at nothing, or one past expiry", () => {
    expect(nowDte({ closed_on: "2026-11-09", dte: 38, cost_to_close: 4 })).toBeNull();
    expect(nowDte({ closed_on: null, dte: 38, cost_to_close: null })).toBeNull();
    expect(nowDte({ closed_on: null, dte: -1, cost_to_close: 4 })).toBeNull();
    // SPX's price alone is no stop since its chart went: no panel has a figure for it
    const spxOnly = { closed_on: null, dte: 38, cost_to_close: null, spx: 6900 };
    expect(nowDte(spxOnly)).toBeNull();
    expect(nowDte({ closed_on: null, dte: 38, cost_to_close: 4 })).toBe(38);
    // out of the session the valuation IS the latest close (#380): that day is already a stop, and
    // restated as "now" it was said twice (#399's review)
    expect(nowDte({ closed_on: null, dte: 38, cost_to_close: 4, valued_from: "close" })).toBeNull();
    expect(nowDte({ closed_on: null, dte: 38, cost_to_close: 4, valued_from: "live" })).toBe(38);
  });
});

describe("the readouts", () => {
  it("say the stop's own day: neither the day before nor the day after", () => {
    const stops = stopsOf(days, null);
    const legs = [{ code: "US.SPXW261218C7300000", leg: { short: true, option_type: "CALL", strike: 7300 } }];
    stops.forEach((stop, i) => {
      expect(ivLines(stop, legs).day.startsWith(days[i]!.observed_on.replaceAll("-", ""))).toBe(true);
    });
  });
});
