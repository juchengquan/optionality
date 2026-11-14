/** The alarm decision, on its own. Previously four branches inside `MonitorSweeper.evaluate`,
 *  reachable only through a database, a fake Provider and a whole sweep. */
import { describe, expect, it } from "vitest";

import {
  alarmPolicy, alarmTransition, distanceShort, figureShort, ruleShape, ruleShort,
  type AlarmPolicy, type AlarmState, type RuleShape,
} from "./alarm.ts";
import type { Monitor } from "./monitor.ts";

const NOW = new Date("2026-08-10T03:35:32Z");
const POLICY: AlarmPolicy = { cooldownSeconds: 120, repeatSeconds: 1800 };

/** an above-rule on a delta, the commonest shape in the watchlist */
function rule(over: Partial<Monitor> = {}): Monitor {
  return {
    code: "US.SPXW261218C6500000",
    strike_date: "2026-12-18",
    option_type: "CALL",
    strike: 6500,
    field: "option_delta",
    threshold: 0.3,
    direction: "above",
    compare: "abs",
    ...over,
  };
}

/** quiet for long enough that the cooldown is never what a test is measuring */
function calm(over: Partial<AlarmState> = {}): AlarmState {
  return { triggered: false, lastAlarmAt: new Date(NOW.getTime() - 3_600_000), ...over };
}

describe("a breach the engine has not seen before", () => {
  it("turns the flag on and names the figure, the sign and the threshold", () => {
    const d = alarmTransition(rule(), 0.42, "SPX 6500 CALL", calm(), POLICY, NOW);
    expect(d.triggered).toBe(true);
    expect(d.notice).toBe("⚠️ SPX 6500 CALL: |Δ| crossed ≥ 0.30 — 0.420  ▲ past 0.120");
  });

  it("words a below-rule as falling, not crossing", () => {
    const d = alarmTransition(rule({ direction: "below" }), 0.12, "SPX", calm(), POLICY, NOW);
    expect(d.notice).toBe("⚠️ SPX: |Δ| fell ≤ 0.30 — 0.120  ▼ past 0.180");
  });

  it("flips at the exact threshold — there is no value hysteresis", () => {
    const d = alarmTransition(rule(), 0.3, "SPX", calm(), POLICY, NOW);
    expect(d.triggered).toBe(true);
  });

  it("prints the figure as it is, not the magnitude the comparison used", () => {
    // a short put's delta is negative and `compare: abs` is what makes it breach; a notice
    // reading "0.420" would not match the figure anywhere else on the dashboard
    const d = alarmTransition(rule(), -0.42, "SPX", calm(), POLICY, NOW);
    expect(d.triggered).toBe(true);
    expect(d.notice).toContain("\u22120.420");
  });

  it("still turns the flag on inside the cooldown, and says nothing", () => {
    const quiet = calm({ lastAlarmAt: new Date(NOW.getTime() - 30_000) });
    const d = alarmTransition(rule(), 0.42, "SPX", quiet, POLICY, NOW);
    expect(d.triggered).toBe(true);     // the state is tracked whether or not the phone hears
    expect(d.notice).toBeNull();
  });

  it("speaks for a rule that has never alarmed, whatever the cooldown", () => {
    const fresh: AlarmState = { triggered: false, lastAlarmAt: null };
    const d = alarmTransition(rule(), 0.42, "SPX", fresh, { ...POLICY, cooldownSeconds: 86_400 }, NOW);
    expect(d.notice).toContain("crossed");
  });
});

describe("a breach that has gone away", () => {
  it("turns the flag off and says which way the value went", () => {
    const d = alarmTransition(rule(), 0.1, "SPX", calm({ triggered: true }), POLICY, NOW);
    expect(d.triggered).toBe(false);
    expect(d.notice).toBe("✅ SPX: |Δ| back below 0.30 — 0.100  ↑0.200");
  });

  it("recovers a below-rule upward", () => {
    const monitor = rule({ direction: "below" });
    const d = alarmTransition(monitor, 0.9, "SPX", calm({ triggered: true }), POLICY, NOW);
    expect(d.notice).toBe("✅ SPX: |Δ| back above 0.30 — 0.900  ↓0.600");
  });

  it("turns the flag off inside the cooldown too", () => {
    const quiet = calm({ triggered: true, lastAlarmAt: new Date(NOW.getTime() - 30_000) });
    const d = alarmTransition(rule(), 0.1, "SPX", quiet, POLICY, NOW);
    expect(d.triggered).toBe(false);
    expect(d.notice).toBeNull();
  });
});

describe("a breach that is still there", () => {
  it("leaves the flag alone and waits out the cadence", () => {
    const recent = calm({ triggered: true, lastAlarmAt: new Date(NOW.getTime() - 60_000) });
    const d = alarmTransition(rule(), 0.42, "SPX", recent, POLICY, NOW);
    expect(d.triggered).toBeNull();     // nothing changed, so nothing is written
    expect(d.notice).toBeNull();
  });

  it("re-reminds once the cadence has passed, and says it is a reminder", () => {
    const old = calm({ triggered: true, lastAlarmAt: new Date(NOW.getTime() - 1_900_000) });
    const d = alarmTransition(rule(), 0.42, "SPX", old, POLICY, NOW);
    expect(d.triggered).toBeNull();
    expect(d.notice).toBe("⚠️ SPX: |Δ| still ≥ 0.30 — 0.420  ▲ past 0.120 (reminder)");
  });

  it("reminds about a below-rule with its own sign", () => {
    const monitor = rule({ direction: "below" });
    const old = calm({ triggered: true, lastAlarmAt: new Date(NOW.getTime() - 1_900_000) });
    expect(alarmTransition(monitor, 0.1, "SPX", old, POLICY, NOW).notice)
      .toBe("⚠️ SPX: |Δ| still ≤ 0.30 — 0.100  ▼ past 0.200 (reminder)");
  });

  it("never reminds when the cadence is zero", () => {
    const ancient = calm({ triggered: true, lastAlarmAt: new Date(0) });
    const d = alarmTransition(rule(), 0.42, "SPX", ancient, { ...POLICY, repeatSeconds: 0 }, NOW);
    expect(d.notice).toBeNull();
  });

  it("reminds a rule that has never alarmed, rather than waiting for a first alarm", () => {
    // reachable: the fresh breach was swallowed by the cooldown, which wrote the flag and not
    // the stamp. Without this the rule is breached, flagged, and silent for ever.
    const never: AlarmState = { triggered: true, lastAlarmAt: null };
    expect(alarmTransition(rule(), 0.42, "SPX", never, POLICY, NOW).notice).toContain("reminder");
  });
});

describe("a quiet rule", () => {
  it("is left entirely alone", () => {
    const d = alarmTransition(rule(), 0.1, "SPX", calm(), POLICY, NOW);
    expect(d).toEqual({ triggered: null, notice: null });
  });
});

describe("the policy", () => {
  it("is read off the settings, so the engine does not spell the two knobs out itself", () => {
    expect(alarmPolicy({ alarmCooldownSeconds: 7, alarmRepeatSeconds: 11 }))
      .toEqual({ cooldownSeconds: 7, repeatSeconds: 11 });
  });
});

/** What the notice says when the rule compares a MAGNITUDE.
 *
 *  `isBreached` compares `Math.abs(value)` under `compare: "abs"`, and the notice once read
 *  "option_delta -0.151 crossed ≥ 0.12" — where -0.151 is not ≥ 0.12 (review, 2026-11-01). It was
 *  made true by mirroring the comparison ("fell ≤ -0.12"). Since #388 the rule is written as what it
 *  compares, `|Δ|`, so the relation is about the size and true as it stands, and the figure is still
 *  printed as served — the number the dashboard shows.
 */
describe("a rule that watches a magnitude", () => {
  const put = rule({ field: "option_delta", threshold: 0.12, direction: "above", compare: "abs" });

  it("says the size crossed, beside the figure as it is", () => {
    const d = alarmTransition(put, -0.15, "1204_P6950", calm(), POLICY, NOW);
    expect(d.notice).toBe("⚠️ 1204_P6950: |Δ| crossed ≥ 0.12 — \u22120.150  ▲ past 0.030");
  });

  it("says the same on a reminder", () => {
    const state = { triggered: true, lastAlarmAt: new Date(NOW.getTime() - 3_600_000) };
    const d = alarmTransition(put, -0.15, "1204_P6950", state, POLICY, NOW);
    expect(d.notice).toBe("⚠️ 1204_P6950: |Δ| still ≥ 0.12 — \u22120.150  ▲ past 0.030 (reminder)");
  });

  it("and on the way back, the size back below its threshold", () => {
    const state = { triggered: true, lastAlarmAt: new Date(NOW.getTime() - 3_600_000) };
    const d = alarmTransition(put, -0.09, "1204_P6950", state, POLICY, NOW);
    expect(d.notice).toBe("✅ 1204_P6950: |Δ| back below 0.12 — \u22120.090  ↑0.030");
  });

  it("says a POSITIVE reading under the same rule the same way", () => {
    const d = alarmTransition(put, 0.15, "1204_C8100", calm(), POLICY, NOW);
    expect(d.notice).toBe("⚠️ 1204_C8100: |Δ| crossed ≥ 0.12 — 0.150  ▲ past 0.030");
  });

  it("says a decayed magnitude under a below-rule as the size that fell", () => {
    const decayed = rule({ threshold: 0.05, direction: "below", compare: "abs" });
    const d = alarmTransition(decayed, -0.03, "1204_P6950", calm(), POLICY, NOW);
    expect(d.notice).toBe("⚠️ 1204_P6950: |Δ| fell ≤ 0.05 — \u22120.030  ▼ past 0.020");
  });

  it("writes a signed rule with no bars, its sign and its threshold's as they are", () => {
    // signed is where a negative threshold is legal and the sign is the whole point
    const signed = rule({ threshold: -0.1, direction: "below", compare: "signed" });
    const d = alarmTransition(signed, -0.15, "1204_P6950", calm(), POLICY, NOW);
    expect(d.notice).toBe("⚠️ 1204_P6950: Δ fell ≤ \u22120.10 — \u22120.150  ▼ past 0.050");
  });

  it("says a held credit's stop as the cost to close crossing up", () => {
    const stop = rule({ field: "mid_price", threshold: -9.44, direction: "below", compare: "signed",
      legs: [{ sign: -1, option_type: "PUT", strike: 6500 }, { sign: 1, option_type: "PUT", strike: 6450 }] });
    const d = alarmTransition(stop, -9.6, "IC", calm(), POLICY, NOW);
    expect(d.notice).toBe("⚠️ IC: close crossed ≥ 9.44 — 9.60  ▲ past 0.16");
    const back = alarmTransition(stop, -3.05, "IC", calm({ triggered: true }), POLICY, NOW);
    expect(back.notice).toBe("✅ IC: close back below 9.44 — 3.05  ↑6.39");
  });
});

/** The short form (#388), which the dashboard writes too: `frontend/src/needs.ts` is held to these
 *  words case for case through `testdata/golden/alarm.json`. */
describe("the short form", () => {
  const r = (over: Partial<RuleShape> = {}): RuleShape =>
    ({ field: "option_delta", combo: false, compare: "abs", direction: "above", threshold: 0.2, ...over });

  it("writes each field as its symbol, a spread's price as val and a contract's as mid", () => {
    const fields = ["mid_price", "option_delta", "option_gamma", "option_theta", "option_vega",
      "option_implied_volatility", "bid_price"];
    expect(fields.map((field) => ruleShort(r({ field, compare: "signed", threshold: 1 }))))
      .toEqual(["mid ≥ 1.00", "Δ ≥ 1.00", "Γ ≥ 1.00", "Θ ≥ 1.00", "ν ≥ 1.00", "IV ≥ 1.00", "bid_price ≥ 1.00"]);
    expect(ruleShort(r({ field: "mid_price", combo: true, threshold: 4.51 }))).toBe("|val| ≥ 4.51");
  });

  it("bars a magnitude and not a signed figure, and points the sign the rule's way", () => {
    expect(ruleShort(r())).toBe("|Δ| ≥ 0.20");
    expect(ruleShort(r({ compare: "signed" }))).toBe("Δ ≥ 0.20");
    expect(ruleShort(r({ direction: "below" }))).toBe("|Δ| ≤ 0.20");
  });

  it("writes the threshold to two places at least, and to every place it was typed with", () => {
    expect(ruleShort(r({ threshold: 0.125 }))).toBe("|Δ| ≥ 0.125");
    expect(ruleShort(r({ field: "option_gamma", threshold: 0.0012 }))).toBe("|Γ| ≥ 0.0012");
    expect(ruleShort(r({ field: "mid_price", threshold: 5 }))).toBe("|mid| ≥ 5.00");
  });

  it("writes a negative with the real minus", () => {
    expect(ruleShort(r({ compare: "signed", direction: "below", threshold: -0.1 }))).toBe("Δ ≤ \u22120.10");
    expect(figureShort(r(), -0.087)).toBe("\u22120.087");
  });

  it("says a held credit's signed stop as the cost to close, and its figure as that cost", () => {
    const stop = r({ field: "mid_price", combo: true, compare: "signed", direction: "below", threshold: -9.44 });
    expect(ruleShort(stop)).toBe("close ≥ 9.44");
    expect(figureShort(stop, -3.05)).toBe("3.05");
    expect(distanceShort(stop, 6.39)).toBe("↑6.39");
    // a below rule on a positive figure is a plain one, not a cost
    expect(ruleShort({ ...stop, threshold: 1.5 })).toBe("val ≤ 1.50");
  });

  it("prints the figure to its field's places", () => {
    expect(figureShort(r({ field: "mid_price" }), 2.1)).toBe("2.10");
    expect(figureShort(r(), 0.0625)).toBe("0.063");
    expect(figureShort(r({ field: "option_gamma" }), 0.00123)).toBe("0.0012");
  });

  it("points the arrow the way the figure must move: up for an above rule, down for a below", () => {
    expect(distanceShort(r(), 0.113)).toBe("↑0.113");
    expect(distanceShort(r({ direction: "below" }), 0.113)).toBe("↓0.113");
  });

  it("says at it and past it with the filled marker", () => {
    expect(distanceShort(r(), 0)).toBe("▲ at");
    expect(distanceShort(r(), -0.05)).toBe("▲ past 0.050");
    expect(distanceShort(r({ direction: "below" }), -0.05)).toBe("▼ past 0.050");
  });

  it("writes the figure and distance to a threshold's places where finer than the field's (review of #388)", () => {
    const fine = r({ field: "mid_price", threshold: 4.505 });
    expect(figureShort(fine, 4.506)).toBe("4.506");
    expect(distanceShort(fine, -0.001)).toBe("▲ past 0.001");
  });

  it("never writes a distance that is not zero as zero", () => {
    expect(distanceShort(r({ threshold: 0.3 }), 0.0000001)).toBe("↑<0.001");
    expect(distanceShort(r({ threshold: 0.3, direction: "below" }), -0.0004)).toBe("▼ past <0.001");
  });

  it("reads a Monitor's shape, a combo by its legs", () => {
    expect(ruleShape(rule())).toEqual(r({ threshold: 0.3 }));
    expect(ruleShape(rule({ legs: [] })).combo).toBe(false);
    expect(ruleShape(rule({ legs: [{ sign: 1, option_type: "PUT", strike: 1 }] })).combo).toBe(true);
  });
});
