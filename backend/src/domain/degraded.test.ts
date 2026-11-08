import { describe, expect, it } from "vitest";

import {
  type DegradedState, degradedPolicy, degradedVerdict, recoveredNotice,
} from "./degraded.ts";

/** What the owner is told when the service cannot see the market, and how often.
 *
 *  Written because on 2026-11-08 OpenD exited and the sweep failed 646 times over 2h42m, and the
 *  owner was told ONCE, at the fifth failure, and then nothing. The notice was correct and the
 *  silence after it was the problem: a message that arrives while you are making coffee is a
 *  message you did not get.
 */

const NOW = new Date("2026-11-08T10:04:50Z");
const policy = degradedPolicy({ degradedAfterFailures: 5, degradedRepeatSeconds: 1800 });

function state(over: Partial<DegradedState> = {}): DegradedState {
  return { failures: 5, since: new Date("2026-11-08T10:00:00Z"), lastNoticeAt: null, ...over };
}

describe("the first notice", () => {
  it("says nothing before the threshold", () => {
    // a provider blinks: one failed sweep is not news, and a message per sweep is 4 an hour
    for (const failures of [1, 2, 3, 4]) {
      expect(degradedVerdict(state({ failures }), policy, "OpenD unreachable?", NOW).notice)
        .toBe(null);
    }
  });

  it("speaks exactly at the threshold, naming the count and the reason", () => {
    const got = degradedVerdict(state({ failures: 5 }), policy, "OpenD unreachable?", NOW);
    expect(got.notice).toBe(
      "⚠️ monitoring degraded: 5 consecutive sweep failures (OpenD unreachable?)",
    );
  });

  it("carries the reason it was given rather than naming a vendor", () => {
    // the Provider is whichever one is configured, so the reason comes from the caller. The
    // sweeper's default said "OpenD unreachable?" whatever was answering, which this branch
    // changes — the same bug ADR 0018 fixed in verifyContracts, still in one more place.
    const got = degradedVerdict(state({ failures: 5 }), policy, "the sweep threw: no session", NOW);
    expect(got.notice).toContain("(the sweep threw: no session)");
    expect(got.notice).not.toContain("OpenD");
  });
});

describe("the reminder, which is the point of this module", () => {
  it("repeats once the interval has passed, saying how long it has been broken", () => {
    const since = new Date("2026-11-08T10:00:00Z");
    const now = new Date("2026-11-08T12:42:00Z");
    const got = degradedVerdict(
      state({ failures: 646, since, lastNoticeAt: new Date("2026-11-08T12:10:00Z") }),
      policy, "OpenD unreachable?", now,
    );
    expect(got.notice).toBe(
      "⚠️ monitoring still degraded: 646 consecutive sweep failures over 2h42m "
      + "(OpenD unreachable?)",
    );
  });

  it("stays quiet until the interval has passed", () => {
    const got = degradedVerdict(
      state({ failures: 400, lastNoticeAt: new Date("2026-11-08T10:04:00Z") }),
      policy, "OpenD unreachable?", NOW,
    );
    expect(got.notice).toBe(null);
  });

  it("measures the interval from the last NOTICE, not from the first failure", () => {
    // otherwise every sweep after the first repeat is also due, and a long outage becomes a
    // message every fifteen seconds — the flapping the alarm cooldown exists to prevent
    const since = new Date("2026-11-08T08:00:00Z");
    const spoke = new Date("2026-11-08T10:04:49Z");
    expect(degradedVerdict(state({ failures: 900, since, lastNoticeAt: spoke }), policy, "x", NOW)
      .notice).toBe(null);
  });

  it("never repeats when the interval is 0", () => {
    // 0 is off, as it is for ALARM_REPEAT_SECONDS: one notice and then the dashboard's business
    const off = degradedPolicy({ degradedAfterFailures: 5, degradedRepeatSeconds: 0 });
    const got = degradedVerdict(
      state({ failures: 646, lastNoticeAt: new Date("2026-11-08T09:00:00Z") }), off, "x", NOW,
    );
    expect(got.notice).toBe(null);
  });

  it("does not repeat before the first notice has been sent", () => {
    // failures past the threshold with no stamp means the first notice failed to send. Treating
    // a null stamp as "long ago" would send the REMINDER as the first thing the owner sees,
    // which reads as though an earlier message was missed.
    const got = degradedVerdict(state({ failures: 646, lastNoticeAt: null }), policy, "x", NOW);
    expect(got.notice).toBe("⚠️ monitoring degraded: 646 consecutive sweep failures (x)");
  });
});

describe("how long it has been broken", () => {
  const since = new Date("2026-11-08T10:00:00Z");
  const at = (iso: string, lastNotice = "2026-11-08T09:00:00Z") =>
    degradedVerdict(
      state({ failures: 100, since, lastNoticeAt: new Date(lastNotice) }),
      policy, "x", new Date(iso),
    ).notice;

  it("counts in minutes under an hour", () => {
    expect(at("2026-11-08T10:07:00Z")).toContain("over 7m");
  });

  it("counts in hours and minutes above one", () => {
    expect(at("2026-11-08T13:05:00Z")).toContain("over 3h5m");
  });

  it("says less than a minute rather than 0m", () => {
    // a repeat this soon needs a contrived stamp, but "over 0m" reads as a bug and this does not
    expect(at("2026-11-08T10:00:30Z")).toContain("over under a minute");
  });

  it("omits the duration when the start is unknown", () => {
    // the counter lives in memory, so a service restarted mid-outage has failures and no start.
    // Saying nothing is honest; inventing a start from the failure count would not be.
    const got = degradedVerdict(
      state({ failures: 646, since: null, lastNoticeAt: new Date("2026-11-08T09:00:00Z") }),
      policy, "OpenD unreachable?", NOW,
    );
    expect(got.notice).toBe(
      "⚠️ monitoring still degraded: 646 consecutive sweep failures (OpenD unreachable?)",
    );
  });
});

describe("recovery", () => {
  it("says so, with how long it was out", () => {
    expect(recoveredNotice(
      state({ failures: 646, since: new Date("2026-11-08T10:00:00Z") }), policy,
      new Date("2026-11-08T12:42:00Z"),
    )).toBe("✅ monitoring recovered after 2h42m");
  });

  it("stays quiet when the owner was never told anything was wrong", () => {
    // four failures then a success is a blink. Announcing a recovery from a problem that was
    // never announced is noise that teaches the owner to ignore the channel.
    expect(recoveredNotice(state({ failures: 4 }), policy, NOW)).toBe(null);
  });

  it("speaks at exactly the threshold, matching when the first notice went out", () => {
    expect(recoveredNotice(state({ failures: 5 }), policy, NOW)).toContain("recovered");
  });

  it("omits the duration when the start is unknown", () => {
    expect(recoveredNotice(state({ failures: 646, since: null }), policy, NOW))
      .toBe("✅ monitoring recovered");
  });
});
