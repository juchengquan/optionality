/** Display formatting. Ported from tests/test_timefmt.py (ADR 0009, phase 5).
 *
 *  `display_time_short` is not here: it is used only by the Telegram bot, and it formats the zone
 *  with Python's `tzname()`, which gives "+08" for Singapore where JavaScript gives "GMT+8". That
 *  needs deciding rather than guessing, so it travels with the bot in phase 7.
 *
 *  Every expectation below also runs against the Python in `make diff-api`, across nine zones and
 *  eight instants — including both daylight-saving boundaries.
 */
import { describe, expect, it } from "vitest";

import { displayStored, displayTime, marketTimeToDisplay } from "./timefmt.ts";

const TZ = "Asia/Singapore";

describe("displayTime", () => {
  it("converts UTC to the display zone", () => {
    expect(displayTime(new Date("2026-08-10T03:35:32Z"), TZ)).toBe("2026-08-10 11:35:32+08:00");
  });

  it("passes null through rather than inventing a time", () => {
    expect(displayTime(null, TZ)).toBeNull();
    expect(displayTime(undefined, TZ)).toBeNull();
  });

  it("writes a whole-hour offset as +HH:MM, as Python does", () => {
    expect(displayTime(new Date("2026-08-10T03:35:32Z"), "UTC")).toBe("2026-08-10 03:35:32+00:00");
    expect(displayTime(new Date("2026-08-10T03:35:32Z"), "America/New_York"))
      .toBe("2026-08-09 23:35:32-04:00");
  });

  it("handles offsets that are not whole hours", () => {
    expect(displayTime(new Date("2026-08-10T03:35:32Z"), "Asia/Kolkata"))
      .toBe("2026-08-10 09:05:32+05:30");
    expect(displayTime(new Date("2026-08-10T03:35:32Z"), "Asia/Kathmandu"))
      .toBe("2026-08-10 09:20:32+05:45");
  });

  it("follows the zone across a daylight-saving change", () => {
    // the same zone, five hours behind in winter and four in summer
    expect(displayTime(new Date("2026-01-15T12:00:00Z"), "America/New_York"))
      .toBe("2026-01-15 07:00:00-05:00");
    expect(displayTime(new Date("2026-07-15T12:00:00Z"), "America/New_York"))
      .toBe("2026-07-15 08:00:00-04:00");
  });
});

describe("displayStored", () => {
  it("reads stored text and renders it in the display zone", () => {
    // SQLite round-trips lose tzinfo; stored values are UTC by construction (CLAUDE.md)
    expect(displayStored("2026-08-10 03:35:32.000000", TZ)).toBe("2026-08-10 11:35:32+08:00");
  });

  it("passes null through", () => {
    expect(displayStored(null, TZ)).toBeNull();
  });
});

describe("marketTimeToDisplay", () => {
  it("reads a naive timestamp as US Eastern, because that is what moomoo means", () => {
    // Sunday 20:15 ET (EDT, UTC-4) is Monday 08:15 in Singapore
    expect(marketTimeToDisplay("2026-08-09 20:15:00", TZ)).toBe("2026-08-10 08:15:00+08:00");
  });

  it("uses the offset in force at that moment, not today's", () => {
    // January is EST, July is EDT; getting this wrong shifts a trade time by an hour
    expect(marketTimeToDisplay("2026-01-15 09:30:00", "UTC")).toBe("2026-01-15 14:30:00+00:00");
    expect(marketTimeToDisplay("2026-07-15 09:30:00", "UTC")).toBe("2026-07-15 13:30:00+00:00");
  });

  it("takes the first of an hour the clock repeats", () => {
    // 01:30 on 1 November 2026 happens twice in New York; Python's fold=0 is the earlier one
    expect(marketTimeToDisplay("2026-11-01 01:30:00", "UTC")).toBe("2026-11-01 05:30:00+00:00");
  });

  it("passes garbage through untouched", () => {
    // the field carries "N/A" when a contract has not traded, and a quote with one odd field is
    // still worth showing
    for (const odd of ["N/A", "", "not a time", "10/08/2026 20:15"]) {
      expect(marketTimeToDisplay(odd, TZ), odd).toBe(odd);
    }
  });

  it("refuses a timestamp that fits the shape but is not a real moment", () => {
    // these all match the pattern, and Date.UTC rolls every one of them over rather than
    // refusing — 2026-13-45 99:99:99 becomes February 2027. Python's fromisoformat raises.
    for (const odd of [
      "2026-13-45 99:99:99", "2026-02-30 12:00:00", "2026-00-10 12:00:00",
      "2026-06-31 12:00:00", "2026-06-30 25:00:00", "2026-06-30 23:60:00",
      "2026-06-30 23:59:60", "2026-06-30 24:30:00", "2026-06-30 24:00:01",
    ]) {
      expect(marketTimeToDisplay(odd, TZ), odd).toBe(odd);
    }
  });

  it("accepts 24:00:00 as the next midnight, which ISO 8601 allows and Python honours", () => {
    // found by running against the Python: the first port treated this as garbage
    expect(marketTimeToDisplay("2026-06-30 24:00:00", "UTC")).toBe("2026-07-01 04:00:00+00:00");
    expect(marketTimeToDisplay("2026-12-31 24:00:00", "UTC")).toBe("2027-01-01 05:00:00+00:00");
    // a leap day in a leap year is real; in a common year it is not
    expect(marketTimeToDisplay("2028-02-29 12:00:00", "UTC")).toBe("2028-02-29 17:00:00+00:00");
    expect(marketTimeToDisplay("2026-02-29 12:00:00", "UTC")).toBe("2026-02-29 12:00:00");
  });

  it("is not idempotent, which is why the sweep stamps records once", () => {
    // feeding its own output back in would read the offset as part of a new naive time
    const once = marketTimeToDisplay("2026-08-09 20:15:00", TZ);
    expect(marketTimeToDisplay(once, TZ)).toBe(once); // refused, because it no longer parses
  });
});
