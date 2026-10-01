/** How much life an option has left.
 *
 *  Not ported — days_to_expiry has no test in the Python at all, which is why the one-day
 *  market-date subtlety in its docstring was worth pinning before anything else depends on it.
 *  Every expectation here was checked against the Python with `make diff-api` (ADR 0009, phase 3).
 *
 *  The instants are fixed, never `new Date()`: the whole point is the hours when New York and the
 *  owner's own calendar disagree, and a test that reads the wall clock would only visit them by
 *  accident.
 */
import { describe, expect, it } from "vitest";

import { daysToExpiry, marketDate } from "./expiry.ts";

describe("the market date", () => {
  it("is New York's calendar day, not the viewer's", () => {
    // 01:17 on 1 October in Singapore is still the afternoon of 30 September in New York, and an
    // option's remaining life is counted where it trades. This is why dte can differ by one from
    // the local calendar — and why it agrees with moomoo's option_expiry_date_distance.
    expect(marketDate(new Date("2026-09-30T17:17:00Z"))).toBe("2026-09-30");
  });

  it("rolls at New York midnight, not at UTC midnight", () => {
    expect(marketDate(new Date("2026-10-01T03:59:59Z"))).toBe("2026-09-30"); // 23:59:59 EDT
    expect(marketDate(new Date("2026-10-01T04:00:00Z"))).toBe("2026-10-01"); // 00:00:00 EDT
  });

  it("follows the offset through a daylight-saving change", () => {
    // the clocks go back on 1 November 2026, so the day rolls four hours after UTC midnight
    // before it and five hours after it
    expect(marketDate(new Date("2026-11-01T04:30:00Z"))).toBe("2026-11-01"); // 00:30 EDT
    expect(marketDate(new Date("2026-11-02T04:59:59Z"))).toBe("2026-11-01"); // 23:59:59 EST
    expect(marketDate(new Date("2026-11-02T05:00:00Z"))).toBe("2026-11-02");
    // and forward again in March, when 02:00 local never happens
    expect(marketDate(new Date("2026-03-08T06:59:59Z"))).toBe("2026-03-08"); // 01:59:59 EST
    expect(marketDate(new Date("2026-03-08T07:00:00Z"))).toBe("2026-03-08"); // 03:00:00 EDT
  });

  it("can still be the previous year", () => {
    expect(marketDate(new Date("2027-01-01T04:59:59Z"))).toBe("2026-12-31");
  });
});

describe("days to expiry", () => {
  const at = new Date("2026-09-30T17:17:00Z"); // market date 2026-09-30

  it("counts calendar days from the market date", () => {
    expect(daysToExpiry("2026-10-16", at)).toBe(16);
    expect(daysToExpiry("2026-11-20", at)).toBe(51);
  });

  it("is zero on the day it expires and negative after", () => {
    expect(daysToExpiry("2026-09-30", at)).toBe(0);
    // an expired monitor is muted with a notice, never silently deleted, so the figure has to
    // keep counting past zero rather than clamp
    expect(daysToExpiry("2026-09-29", at)).toBe(-1);
    expect(daysToExpiry("2025-01-02", at)).toBe(-636);
  });

  it("is a whole number of days across a daylight-saving change", () => {
    // 1 November sits between these two, so one of the intervening days is 25 hours long.
    // Counting in local time would give 44.96 days and round to the wrong answer.
    const october = new Date("2026-10-15T16:00:00Z"); // 2026-10-15 in New York
    expect(daysToExpiry("2026-11-20", october)).toBe(36);
    expect(daysToExpiry("2026-12-18", october)).toBe(64);
  });

  it("takes both spellings of the date, like the Python", () => {
    expect(daysToExpiry("20261016", at)).toBe(16);
    expect(() => daysToExpiry("2026-02-30", at)).toThrow(/invalid strike_date/);
  });
});
