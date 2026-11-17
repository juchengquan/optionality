/** Every clock carries its zone, every date is prose or compact, and manage-by is days left (the
 *  owner's standard of 2026-11-16, part F; `shared/times.ts`, `session.ts`, `pace.manageBy`). */
import { afterEach, describe, expect, it } from "vitest";

import { fetchedWords, marketClock } from "../shared/format";
import {
  offsetName, setDisplayZone, viewerClock, weekdayDate, writtenDate, zoneName, zoneOfStamp,
} from "../shared/times";
import { newYorkWhen, servedWhen } from "../session";
import { manageBy } from "../pace";

afterEach(() => setDisplayZone(null));

describe("a zone's name", () => {
  it("is the tz database's short name, from whichever English locale has one", () => {
    const at = new Date("2026-11-16T15:00:00Z");
    expect(zoneName("Asia/Singapore", at)).toBe("SGT");
    expect(zoneName("America/New_York", at)).toBe("EST");
    expect(zoneName("America/New_York", new Date("2026-07-01T15:00:00Z"))).toBe("EDT");
    expect(zoneName("Europe/London", at)).toBe("GMT");
    expect(zoneName("Asia/Hong_Kong", at)).toBe("HKT");
    expect(zoneName("UTC", at)).toBe("UTC");
  });

  it("falls back to the offset where no English locale names it", () => {
    const at = new Date("2026-11-16T15:00:00Z");
    expect(zoneName("Asia/Tokyo", at)).toBe("GMT+9");
    expect(zoneName("Asia/Kathmandu", at)).toBe("GMT+5:45");
    expect(offsetName(-300)).toBe("GMT-5");
    expect(offsetName(0)).toBe("UTC");
  });

  it("names a served stamp by DISPLAY_TZ where its offset is DISPLAY_TZ's, and by its offset where not", () => {
    setDisplayZone("Asia/Singapore");
    expect(zoneOfStamp("2026-11-16 21:04:37+08:00")).toBe("SGT");
    expect(zoneOfStamp("2026-11-16 08:04:37-05:00")).toBe("GMT-5");
    // a zone the browser does not know is no zone: the device's stands in (UTC in this suite)
    setDisplayZone("Mars/Olympus");
    expect(zoneOfStamp("2026-11-16 21:04:37+08:00")).toBe("GMT+8");
    expect(zoneOfStamp("2026-11-16 21:04:37+00:00")).toBe("UTC");
  });
});

describe("the viewer's clock and the market's", () => {
  it("says the screen's time on DISPLAY_TZ's clock, with its name, never merely the device's", () => {
    setDisplayZone("Asia/Singapore");
    expect(viewerClock(new Date("2026-11-16T15:00:00Z"))).toBe("23:00:00 SGT");
    setDisplayZone(null);
    // before /health has said it: the device's (UTC here), named
    expect(viewerClock(new Date("2026-11-16T15:00:00Z"))).toBe("15:00:00 UTC");
  });

  it("says when the service fetched, dated where it is not today's, never with an offset", () => {
    setDisplayZone("Asia/Singapore");
    const now = new Date("2026-11-16T15:00:00Z");
    expect(fetchedWords("2026-11-16 23:00:05+08:00", now)).toBe("23:00:05 SGT");
    expect(fetchedWords("2026-11-12 23:14:05+08:00", now)).toBe("Thu 20261112 23:14:05 SGT");
    expect(fetchedWords("x", now)).toBe("x");
  });

  it("marks every New York time ET, all year", () => {
    expect(marketClock("2026-11-16 23:00:05+08:00")).toBe("10:00:05 ET");
    expect(newYorkWhen("2026-11-14 05:14:59+08:00")).toBe("Fri 20261113 16:14 ET");
    expect(newYorkWhen("2026-07-14 05:14:59+08:00")).toBe("Mon 20260713 17:14 ET");
  });

  it("puts the zone on a served time the Levels and the References say", () => {
    setDisplayZone("Asia/Singapore");
    expect(servedWhen("2026-11-16 21:04:37+08:00", new Date("2026-11-16T14:00:00Z"))).toBe("21:04 SGT");
  });
});

describe("a date (the owner's standard of 2026-11-17)", () => {
  it("is YYYYMMDD, never ISO and never the day and month in words", () => {
    expect(writtenDate("2026-12-31")).toBe("20261231");
    expect(writtenDate("2026-11-01")).toBe("20261101");
    expect(writtenDate("not a date")).toBe("not a date");
    expect(writtenDate(null)).toBe("");
  });

  it("keeps its weekday beside a time", () => {
    expect(weekdayDate("2026-11-16")).toBe("Mon 20261116");
    expect(weekdayDate("2026-11-13")).toBe("Fri 20261113");
    expect(weekdayDate("not a date")).toBe("not a date");
  });
});

describe("manage-by", () => {
  const schedule = { manage_by_dte: 21, manage_by_due: false } as never;
  it("is days left, the threshold as detail, and due once reached", () => {
    expect(manageBy({ dte: 45, schedule })).toEqual({ text: "in 24d", detail: "at 21 DTE" });
    expect(manageBy({ dte: 20, schedule: { manage_by_dte: 21, manage_by_due: true } as never })).toEqual({ text: "due", detail: "at 21 DTE" });
    expect(manageBy({ dte: 45, schedule: null })).toEqual({ text: "—", detail: null });
  });
});
