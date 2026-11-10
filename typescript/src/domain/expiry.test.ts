/** How much life an option has left.
 *
 *  Not ported — days_to_expiry has no test in the Python at all, which is why the one-day
 *  market-date subtlety in its docstring was worth pinning before anything else depends on it.
 *  Every expectation here was checked value-by-value against the Python of the time, by a
 *  differential named `diff-api` that went with it (#145). The comparison runs the other way round now: this
 *  module is canonical and `python/src/optionality/expiry.py` is ported FROM it, held to
 *  testdata/golden/expiry.json exactly (ADR 0014).
 *
 *  The instants are fixed, never `new Date()`: the whole point is the hours when New York and the
 *  owner's own calendar disagree, and a test that reads the wall clock would only visit them by
 *  accident.
 */
import { describe, expect, it } from "vitest";

import { daysToExpiry, inSampleHours, marketDate } from "./expiry.ts";

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

const at = (iso: string) => new Date(iso);

describe("inSampleHours — when a day's sample may be taken", () => {
  // Monday 9 November 2026: New York is on EST, five hours behind UTC
  it("opens at 09:30 New York, to the millisecond", () => {
    expect(inSampleHours(at("2026-11-09T14:29:59.999Z"))).toBe(false);
    expect(inSampleHours(at("2026-11-09T14:30:00.000Z"))).toBe(true);
  });

  it("includes 16:00 itself and nothing after it, so the row settles on the close", () => {
    expect(inSampleHours(at("2026-11-09T21:00:00.000Z"))).toBe(true);
    expect(inSampleHours(at("2026-11-09T21:00:00.001Z"))).toBe(false);
  });

  it("refuses the overnight session, whose marks are not the day's close", () => {
    // Global Trading Hours resume about 20:15: Monday 23:30 in New York is already Tuesday in UTC
    expect(inSampleHours(at("2026-11-10T04:30:00Z"))).toBe(false);
    // and the small hours before the open
    expect(inSampleHours(at("2026-11-09T11:00:00Z"))).toBe(false); // 06:00 EST
  });

  it("is open on a weekend, because the vol chain needs a row every calendar day", () => {
    // volAttribution steps exactly one day between samples; nothing trades in these hours on a
    // Saturday, so its row is the Friday close carried forward
    expect(inSampleHours(at("2026-11-07T17:00:00Z"))).toBe(true); // Saturday noon
    // Sunday 20:30, when the overnight session has begun, is outside like any evening
    expect(inSampleHours(at("2026-11-09T01:30:00Z"))).toBe(false);
  });

  it("reads the hours in New York's zone on both sides of each 2026 clock change", () => {
    // Monday after the clocks went forward (8 March): EDT, so 13:30Z is 09:30 and open — a fixed
    // five-hour offset would call it 08:30 and shut
    expect(inSampleHours(at("2026-03-09T13:30:00Z"))).toBe(true);
    // Friday before they went back (1 November): 20:30Z is 16:30 EDT and shut — at EST it would
    // be 15:30 and open
    expect(inSampleHours(at("2026-10-30T20:30:00Z"))).toBe(false);
    // Monday after they went back: 14:00Z is 09:00 EST and shut — at EDT it would be 10:00
    expect(inSampleHours(at("2026-11-02T14:00:00Z"))).toBe(false);
  });

  it("needs no exchange calendar: a half-day and a holiday carry their last close", () => {
    // the Friday after Thanksgiving closes at 13:00 (options 13:15) and is static until 16:00
    expect(inSampleHours(at("2026-11-27T19:00:00Z"))).toBe(true);
    // Thanksgiving itself trades nothing, so its row is Wednesday's close, as a Saturday's is
    expect(inSampleHours(at("2026-11-26T17:00:00Z"))).toBe(true);
  });
});
