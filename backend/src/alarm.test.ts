/** The alarm decision, on its own. Previously four branches inside `MonitorSweeper.evaluate`,
 *  reachable only through a database, a fake Provider and a whole sweep. */
import { describe, expect, it } from "vitest";

import { alarmPolicy, alarmTransition, type AlarmPolicy, type AlarmState } from "./alarm.ts";
import type { Monitor } from "./domain/monitor.ts";

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
    expect(d.notice).toBe("⚠️ SPX 6500 CALL: option_delta 0.420 crossed ≥ 0.3");
  });

  it("words a below-rule as falling, not crossing", () => {
    const d = alarmTransition(rule({ direction: "below" }), 0.12, "SPX", calm(), POLICY, NOW);
    expect(d.notice).toBe("⚠️ SPX: option_delta 0.120 fell ≤ 0.3");
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
    expect(d.notice).toContain("-0.420");
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
    expect(d.notice).toBe("✅ SPX: option_delta 0.100 back below 0.3");
  });

  it("recovers a below-rule upward", () => {
    const monitor = rule({ direction: "below" });
    const d = alarmTransition(monitor, 0.9, "SPX", calm({ triggered: true }), POLICY, NOW);
    expect(d.notice).toBe("✅ SPX: option_delta 0.900 back above 0.3");
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
    expect(d.notice).toBe("⚠️ SPX: option_delta 0.420 still ≥ 0.3 (reminder)");
  });

  it("reminds about a below-rule with its own sign", () => {
    const monitor = rule({ direction: "below" });
    const old = calm({ triggered: true, lastAlarmAt: new Date(NOW.getTime() - 1_900_000) });
    expect(alarmTransition(monitor, 0.1, "SPX", old, POLICY, NOW).notice)
      .toBe("⚠️ SPX: option_delta 0.100 still ≤ 0.3 (reminder)");
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
