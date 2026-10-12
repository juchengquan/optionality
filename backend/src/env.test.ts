/** Reading the knobs. `.env` is the deployment, so these names and the way they parse are part of
 *  it rather than implementation detail — a renamed variable silently reverts a setting the owner
 *  has made, and a parse that rejects a legal value stops the service at boot. */
import { describe, expect, it } from "vitest";

import { DEFAULTS, settingsFromEnv } from "./env.ts";

describe("numbers", () => {
  it("keeps rejecting a fractional COUNT, which is always a typo", () => {
    // int() in the Python, which raised rather than silently using the default: a mistyped
    // interval should stop the service, not quietly sweep every 60 seconds
    expect(() => settingsFromEnv({ MONITOR_INTERVAL_SECONDS: "1.5" }))
      .toThrow(/MONITOR_INTERVAL_SECONDS/);
    expect(() => settingsFromEnv({ EXPIRED_RETENTION_DAYS: "7.5" })).toThrow();
    expect(() => settingsFromEnv({ EXIT_MANAGE_BY_DTE: "21.5" }), "a DTE is a whole day").toThrow();
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
    expect(() => settingsFromEnv({ EXIT_STOP_MULTIPLE: "" })).toThrow();
  });

  it("leaves a knob alone when the variable is absent", () => {
    const s = settingsFromEnv({});
    expect(s.exitTakeFraction).toBe(DEFAULTS.exitTakeFraction);
    expect(s.exitManageByDte).toBe(DEFAULTS.exitManageByDte);
  });
});
