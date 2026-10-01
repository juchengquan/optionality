/** The computational half of a monitor: what it is watching, how far that value has travelled,
 *  and whether it has breached.
 *
 *  These are not ported. The Python functions have almost no unit tests of their own — they are
 *  reached through the sweeper, which needs a session, and `threshold_fill` has exactly ONE
 *  assertion in 3,278 lines of test (`fill == 50`, in test_api_seam.py). So these were written
 *  from the invariants in CLAUDE.md and then checked value-by-value against the Python with
 *  `make diff-api` (ADR 0009, phase 3).
 */
import { describe, expect, it } from "vitest";

import { buildSpxCode } from "./contract.ts";
import {
  type ByCode, type Monitor, comboFieldError, comboFieldSum, isBreached, monitorLegCodes,
  monitorValue, thresholdFill,
} from "./monitor.ts";

const EXPIRY = "2026-10-16";
const code = (type: "CALL" | "PUT", strike: number) => buildSpxCode(EXPIRY, type, strike);

const single = (over: Partial<Monitor> = {}): Monitor => ({
  code: code("CALL", 8050), strike_date: EXPIRY, option_type: "CALL", strike: 8050,
  field: "option_delta", threshold: 0.5, direction: "above", compare: "abs", legs: null, ...over,
});

const combo = (over: Partial<Monitor> = {}): Monitor => ({
  ...single(), legs: [
    { sign: 1, option_type: "CALL", strike: 8050 },
    { sign: -1, option_type: "CALL", strike: 8075 },
  ], ...over,
});

describe("what a monitor watches", () => {
  it("uses its own code when it has no legs", () => {
    expect(monitorLegCodes(single())).toEqual([code("CALL", 8050)]);
  });

  it("builds a code per leg for a combo", () => {
    expect(monitorLegCodes(combo())).toEqual([code("CALL", 8050), code("CALL", 8075)]);
  });

  it("reads the field straight off the quote for a single leg", () => {
    const quotes: ByCode = { [code("CALL", 8050)]: { option_delta: 0.42 } };
    expect(monitorValue(single(), quotes)).toBe(0.42);
  });

  it("has no value when the quote is missing, and none when the field is", () => {
    expect(monitorValue(single(), {})).toBeNull();
    expect(monitorValue(single(), { [code("CALL", 8050)]: { mid_price: 1 } })).toBeNull();
    expect(monitorValue(single(), { [code("CALL", 8050)]: { option_delta: null } })).toBeNull();
  });
});

describe("combos", () => {
  const priced = (a: number, b: number): ByCode => ({
    [code("CALL", 8050)]: { option_delta: a },
    [code("CALL", 8075)]: { option_delta: b },
  });

  it("is a signed sum under the leg signs the owner chose", () => {
    expect(comboFieldSum(combo(), priced(0.4, 0.25), "option_delta")).toBeCloseTo(0.15, 12);
  });

  it("reports nothing rather than a part sum when a leg is missing", () => {
    // any missing leg skips the combo (CLAUDE.md) — a partial exposure reads as a real one
    expect(comboFieldSum(combo(), { [code("CALL", 8050)]: { option_delta: 0.4 } }, "option_delta"))
      .toBeNull();
  });

  it("never sums implied volatility, even for a row that predates the rule", () => {
    // IV is intensive: two legs at 20% are not a 40% combo. The guard is inside the sum, not
    // only at creation, so a legacy row cannot produce a figure either.
    const iv: ByCode = {
      [code("CALL", 8050)]: { option_implied_volatility: 20 },
      [code("CALL", 8075)]: { option_implied_volatility: 18 },
    };
    expect(comboFieldError("option_implied_volatility")).toMatch(/not additive/);
    expect(comboFieldSum(combo(), iv, "option_implied_volatility")).toBeNull();
    expect(monitorValue(combo({ field: "option_implied_volatility" }), iv)).toBeNull();
  });

  it("allows the additive fields", () => {
    for (const f of ["option_delta", "option_gamma", "option_theta", "option_vega", "mid_price"]) {
      expect(comboFieldError(f), f).toBeNull();
    }
  });
});

describe("how far the value has travelled", () => {
  it("fills the fraction of the threshold reached", () => {
    // the one figure the Python suite asserts: 4.5 against a threshold of 9.0
    expect(thresholdFill(4.5, 9.0, "above", "abs")).toBe(50);
  });

  it("measures magnitude in abs mode and the raw value in signed", () => {
    expect(thresholdFill(-0.3, 0.5, "above", "abs")).toBe(60);
    // a signed monitor watching for a rise has no baseline to fill from while the value is
    // negative — it must cross from the other side first
    expect(thresholdFill(-0.3, 0.5, "above", "signed")).toBeNull();
  });

  it("counts down toward a below threshold instead of up", () => {
    expect(thresholdFill(1.0, 0.5, "below", "abs")).toBe(50);
    expect(thresholdFill(0.25, 0.5, "below", "abs")).toBe(100);
    // zero cannot be divided into, and 100% would be a lie about a value already past
    expect(thresholdFill(0.0, 0.5, "below", "abs")).toBeNull();
  });

  it("clamps to 0-100 so a breached value does not read as 340%", () => {
    expect(thresholdFill(0.6, 0.5, "above", "abs")).toBe(100);
    expect(thresholdFill(1.7, 0.5, "above", "abs")).toBe(100);
  });

  it("has nothing to fill from without a threshold", () => {
    // `not threshold` in the Python, so zero is excluded along with absent
    expect(thresholdFill(0.5, 0, "above", "abs")).toBeNull();
    expect(thresholdFill(0.5, null, "above", "abs")).toBeNull();
    expect(thresholdFill(null, 0.5, "above", "abs")).toBeNull();
    expect(thresholdFill(0.5, -0.3, "above", "signed")).toBeNull();
  });

  it("rounds the percentage half to even, on the stored value", () => {
    // Python's round() again, and this one drives the colour band on the dashboard. 12.5 and
    // 22.5 are exact ties and go to the even neighbour; 0.135 * 100 is 13.500000000000002,
    // which is not a tie at all and goes up.
    expect(thresholdFill(0.125, 1.0, "above", "abs")).toBe(12);
    expect(thresholdFill(0.225, 1.0, "above", "abs")).toBe(22);
    expect(thresholdFill(0.135, 1.0, "above", "abs")).toBe(14);
  });
});

describe("the breach decision", () => {
  it("flips truthfully AT the threshold, with no band", () => {
    // no value hysteresis: flapping is throttled by the alarm cooldown, never by widening the
    // threshold (CLAUDE.md)
    expect(isBreached(0.5, 0.5, "above", "abs")).toBe(true);
    expect(isBreached(0.4999999, 0.5, "above", "abs")).toBe(false);
    expect(isBreached(0.5, 0.5, "below", "abs")).toBe(true);
    expect(isBreached(0.5000001, 0.5, "below", "abs")).toBe(false);
  });

  it("compares magnitude in abs mode, so a put's negative delta still breaches", () => {
    expect(isBreached(-0.6, 0.5, "above", "abs")).toBe(true);
    expect(isBreached(-0.6, 0.5, "above", "signed")).toBe(false);
  });

  it("allows a negative threshold in signed mode", () => {
    expect(isBreached(-0.4, -0.3, "below", "signed")).toBe(true);
    expect(isBreached(-0.2, -0.3, "below", "signed")).toBe(false);
  });

  it("treats anything that is not below as above", () => {
    // the Python asks `direction != "below"`, so an unexpected value means above rather than
    // throwing — a monitor that cannot decide is worse than one that errs toward warning
    expect(isBreached(0.6, 0.5, "sideways", "abs")).toBe(true);
    expect(isBreached(0.4, 0.5, "sideways", "abs")).toBe(false);
  });
});
