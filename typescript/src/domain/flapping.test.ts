import { describe, expect, it } from "vitest";

import { type FlappingState, flappingPolicy, flappingVerdict } from "./flapping.ts";

/** A provider that keeps failing and recovering, which no consecutive count can see.
 *
 *  Written because of a real outage on 2026-11-08 that nothing in the service noticed. A launchd
 *  agent was killing OpenD 27 seconds after every start and restarting it a minute later: 39
 *  starts in an hour, `/quotes` 502ing in the gaps, and the sweep failing perhaps a third of the
 *  time. The owner found it by looking at the dashboard.
 *
 *  `degraded.ts` could not see it. It counts CONSECUTIVE failures, and every success in between
 *  reset the counter below the threshold — so an hour of intermittent failure produced no notice
 *  at all, while a five-minute total outage would have. This module measures the rate instead.
 */

const NOW = new Date("2026-11-08T22:00:00Z");
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);
const policy = flappingPolicy({
  flappingWindowSeconds: 900, flappingAfterFailures: 5, flappingRepeatSeconds: 1800,
});

function state(over: Partial<FlappingState> = {}): FlappingState {
  return { failures: [], lastNoticeAt: null, announced: false, ...over };
}

describe("counting failures in a window", () => {
  it("says nothing when there are none", () => {
    expect(flappingVerdict(state(), policy, NOW).notice).toBe(null);
  });

  it("says nothing below the threshold, however spread out", () => {
    const failures = [ago(60), ago(200), ago(400), ago(800)];
    expect(flappingVerdict(state({ failures }), policy, NOW).notice).toBe(null);
  });

  it("speaks at the threshold, naming the count and the window", () => {
    const failures = [ago(60), ago(200), ago(400), ago(600), ago(800)];
    expect(flappingVerdict(state({ failures }), policy, NOW).notice).toBe(
      "⚠️ monitoring unreliable: 5 failed sweeps in the last 15m, with successes in between "
      + "— a provider that keeps dropping and recovering",
    );
  });

  it("ignores failures older than the window", () => {
    // the whole point of a window: an hour-old problem that has stopped is not news
    const failures = [ago(901), ago(1200), ago(2000), ago(3000), ago(4000)];
    expect(flappingVerdict(state({ failures }), policy, NOW).notice).toBe(null);
  });

  it("counts a failure exactly at the window's edge as inside it", () => {
    const failures = [ago(900), ago(100), ago(200), ago(300), ago(400)];
    expect(flappingVerdict(state({ failures }), policy, NOW).notice).toContain("5 failed sweeps");
  });

  it("would have caught the outage it was written for", () => {
    // the measured shape: a failure roughly every 90 seconds while the agent churned
    const failures = Array.from({ length: 10 }, (_, i) => ago(90 * (i + 1)));
    expect(flappingVerdict(state({ failures }), policy, NOW).notice)
      .toContain("10 failed sweeps in the last 15m");
  });
});

describe("not speaking over the other notice", () => {
  it("stays quiet while a sustained outage has already been announced", () => {
    // `degraded.ts` has said "monitoring degraded" and repeats every half hour. Two notices about
    // one provider being unavailable is noise, and noise teaches someone to stop reading the
    // channel the alarms arrive on.
    const failures = Array.from({ length: 10 }, (_, i) => ago(60 * (i + 1)));
    expect(flappingVerdict(state({ failures, announced: true }), policy, NOW).notice).toBe(null);
  });

  it("speaks once the sustained notice has cleared, if it is still flapping", () => {
    const failures = Array.from({ length: 10 }, (_, i) => ago(60 * (i + 1)));
    expect(flappingVerdict(state({ failures, announced: false }), policy, NOW).notice)
      .toContain("unreliable");
  });
});

describe("the reminder", () => {
  it("repeats once the cadence has passed", () => {
    const failures = Array.from({ length: 6 }, (_, i) => ago(60 * (i + 1)));
    expect(flappingVerdict(state({ failures, lastNoticeAt: ago(1801) }), policy, NOW).notice)
      .toContain("unreliable");
  });

  it("stays quiet before it has", () => {
    const failures = Array.from({ length: 6 }, (_, i) => ago(60 * (i + 1)));
    expect(flappingVerdict(state({ failures, lastNoticeAt: ago(1799) }), policy, NOW).notice)
      .toBe(null);
  });

  it("never repeats where the cadence is 0", () => {
    const off = flappingPolicy({
      flappingWindowSeconds: 900, flappingAfterFailures: 5, flappingRepeatSeconds: 0,
    });
    const failures = Array.from({ length: 6 }, (_, i) => ago(60 * (i + 1)));
    expect(flappingVerdict(state({ failures, lastNoticeAt: ago(99999) }), off, NOW).notice)
      .toBe(null);
  });
});

describe("turning it off", () => {
  it("is off when the threshold is 0, as every other threshold here is", () => {
    const off = flappingPolicy({
      flappingWindowSeconds: 900, flappingAfterFailures: 0, flappingRepeatSeconds: 1800,
    });
    const failures = Array.from({ length: 50 }, (_, i) => ago(i + 1));
    expect(flappingVerdict(state({ failures }), off, NOW).notice).toBe(null);
  });
});

describe("how the window is said", () => {
  it("is minutes under an hour", () => {
    const p = flappingPolicy({
      flappingWindowSeconds: 300, flappingAfterFailures: 2, flappingRepeatSeconds: 1800,
    });
    expect(flappingVerdict(state({ failures: [ago(10), ago(20)] }), p, NOW).notice)
      .toContain("in the last 5m");
  });

  it("is hours and minutes above one", () => {
    const p = flappingPolicy({
      flappingWindowSeconds: 5400, flappingAfterFailures: 2, flappingRepeatSeconds: 1800,
    });
    expect(flappingVerdict(state({ failures: [ago(10), ago(20)] }), p, NOW).notice)
      .toContain("in the last 1h30m");
  });
});
