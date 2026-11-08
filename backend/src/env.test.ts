/** Reading the knobs. `.env` is the deployment, so these names and the way they parse are part of
 *  it rather than implementation detail — a renamed variable silently reverts a setting the owner
 *  has made, and a parse that rejects a legal value stops the service at boot. */
import { describe, expect, it } from "vitest";

import { DEFAULTS, settingsFromEnv } from "./env.ts";

describe("which database", () => {
  it("defaults to the TypeScript database, never the frozen rollback", () => {
    // `data/optionality.db` is the Python's, "frozen at the cutover minute and never opened by the
    // new service" (CLAUDE.md) — it is the rollback. It was the DEFAULT here, and `main.ts` opens
    // and MIGRATES whatever it is given, at import time. The schemas diverged at ADR 0011, so one
    // run with OPTIONALITY_DB_PATH unset would have ALTERed the rollback.
    //
    // Only the launchd plist supplied the variable; `.env` does not. So the live service was right
    // and every other way of starting this code was wrong — a hand-run `node backend/src/main.ts`,
    // or anything importing it. `check-loads.ts` skips main.ts for its own reasons, which is the
    // only thing that kept `make check-api` from doing it.
    expect(DEFAULTS.dbPath).toBe("data/optionality-ts.db");
    expect(settingsFromEnv({}).dbPath, "with nothing set at all").toBe("data/optionality-ts.db");
    expect(DEFAULTS.dbPath, "the rollback is never the default").not.toBe("data/optionality.db");
  });

  it("still takes the path the deployment gives it", () => {
    expect(settingsFromEnv({ OPTIONALITY_DB_PATH: "data/elsewhere.db" }).dbPath)
      .toBe("data/elsewhere.db");
  });
});

describe("numbers", () => {
  it("keeps rejecting a fractional COUNT, which is always a typo", () => {
    // int() in the Python, which raised rather than silently using the default: a mistyped
    // interval should stop the service, not quietly sweep every 60 seconds
    expect(() => settingsFromEnv({ MONITOR_INTERVAL_SECONDS: "1.5" }))
      .toThrow(/MONITOR_INTERVAL_SECONDS/);
    expect(() => settingsFromEnv({ EXPIRED_RETENTION_DAYS: "7.5" }))
      .toThrow(/EXPIRED_RETENTION_DAYS is not an integer/);
    expect(() => settingsFromEnv({ EXIT_MANAGE_BY_DTE: "21.5" }), "a DTE is a whole day")
      .toThrow(/EXIT_MANAGE_BY_DTE is not an integer/);
  });

  it("accepts a fractional FRACTION, which the integer rule would have killed at boot", () => {
    // EXIT_TAKE_FRACTION=0.5 is the value `.env.example` shows, and before this it threw —
    // the default survived only because defaults never go through the parser, so the feature
    // worked until the owner set the knob it documents
    expect(settingsFromEnv({ EXIT_TAKE_FRACTION: "0.5" }).exitTakeFraction).toBe(0.5);
    expect(settingsFromEnv({ EXIT_TAKE_FRACTION: "0.35" }).exitTakeFraction).toBe(0.35);
    expect(settingsFromEnv({ EXIT_STOP_MULTIPLE: "2.5" }).exitStopMultiple).toBe(2.5);
    // and a whole number is still fine for them
    expect(settingsFromEnv({ EXIT_STOP_MULTIPLE: "2" }).exitStopMultiple).toBe(2);
  });

  it("rejects what is not a number at all, fractional or not", () => {
    expect(() => settingsFromEnv({ EXIT_TAKE_FRACTION: "half" })).toThrow(/EXIT_TAKE_FRACTION/);
    // a variable set to nothing is its own message: an empty string is not "not a number", it is
    // a knob somebody meant to set and left blank
    expect(() => settingsFromEnv({ EXIT_STOP_MULTIPLE: "" }))
      .toThrow(/EXIT_STOP_MULTIPLE is set to nothing/);
  });

  it("leaves a knob alone when the variable is absent", () => {
    const s = settingsFromEnv({});
    expect(s.exitTakeFraction).toBe(DEFAULTS.exitTakeFraction);
    expect(s.exitManageByDte).toBe(DEFAULTS.exitManageByDte);
  });
});

/** The guard that was only ever on the test path.
 *
 *  `checkSettings` has refused these values since it was written, and `settingsFor` — which is
 *  how every TEST builds Settings — called it. `settingsFromEnv`, which is how the SERVICE
 *  builds them, never did: `main.ts` reads the environment and serves. So the live process
 *  accepted exactly the values this file documents as fatal, and the suite could not tell,
 *  because the suite went through the other door.
 *
 *  Measured on 2026-11-08: `settingsFromEnv` returned `degradedAfterFailures: 0`,
 *  `uiRefreshSeconds: 0` and `monitorIntervalSeconds: 0` without complaint, while
 *  `settingsFor({ degradedAfterFailures: 0 })` threw. These tests go through the SERVICE's door.
 */
describe("the knobs a service must not start on", () => {
  it("refuses a count that cannot mean anything", () => {
    expect(() => settingsFromEnv({ ALARM_COOLDOWN_SECONDS: "-1" }))
      .toThrow(/ALARM_COOLDOWN_SECONDS cannot be negative/);
  });

  it("refuses DEGRADED_AFTER_FAILURES=0, which announced recovery for ever", () => {
    // 0 made `consecutiveFailures >= threshold` true on a HEALTHY sweep: "✅ monitoring
    // recovered" every minute, while the degraded alert it arms never fired at all (env.ts)
    expect(() => settingsFromEnv({ DEGRADED_AFTER_FAILURES: "0" }))
      .toThrow(/DEGRADED_AFTER_FAILURES must be at least 1/);
  });

  it("refuses MONITOR_INTERVAL_SECONDS=0, which stalls the engine permanently", () => {
    // setInterval(…, 0) with a stall threshold of 0: /health reads stalled for ever and every
    // tick records a failed sweep
    expect(() => settingsFromEnv({ MONITOR_INTERVAL_SECONDS: "0" }))
      .toThrow(/MONITOR_INTERVAL_SECONDS must be at least 1/);
    expect(() => settingsFromEnv({ UI_REFRESH_SECONDS: "0" }))
      .toThrow(/UI_REFRESH_SECONDS must be at least 1/);
  });

  it("still allows 0 where 0 genuinely means off", () => {
    // the three AT_LEAST_ONE deliberately leaves out, which is why that list is explicit
    expect(settingsFromEnv({ ALARM_REPEAT_SECONDS: "0" }).alarmRepeatSeconds).toBe(0);
    expect(settingsFromEnv({ QUARANTINE_AFTER_SILENT_SWEEPS: "0" }).quarantineAfterSilentSweeps)
      .toBe(0);
    expect(settingsFromEnv({ EXPIRED_RETENTION_DAYS: "0" }).expiredRetentionDays).toBe(0);
    // and the two flapping knobs, where 0 failures is the off switch (domain/flapping.ts)
    expect(settingsFromEnv({ FLAPPING_AFTER_FAILURES: "0" }).flappingAfterFailures).toBe(0);
  });

  it("checks the defaults themselves, so a bad default cannot ship", () => {
    expect(() => settingsFromEnv({})).not.toThrow();
  });
});
