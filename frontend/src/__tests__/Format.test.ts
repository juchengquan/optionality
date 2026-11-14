/** `shared/format.ts`'s readers, which the page still uses: a contract's short name, the service's
 *  stamp without its zone, New York's trading day and the screen's own clock.
 *
 *  Their cases lived in the old page's suites (`Columns`, `LastTrade`, `Opened`, `Clock`), beside
 *  the tables and forms that drew them, and went with those suites in the swap (#301). They come
 *  back here, against the module alone. The suite runs under TZ=UTC (vitest.config.ts), so a case
 *  that reads the DEVICE's zone writes its instant in another one and states the conversion.
 */
import { describe, expect, it } from "vitest";

import { clockTime, heldLeg, legText, marketDay, shortContract, shortStamp, signedLeg } from "../shared/format";

describe("legs, short as minus (#351)", () => {
  it("writes a quantity between the sign and the contract, and a quantity of one not at all", () => {
    expect([
      { sign: 1, option_type: "CALL", strike: 7300 }, { sign: -1, option_type: "CALL", strike: 7350, qty: 2 },
      { sign: 1, option_type: "CALL", strike: 7400, qty: 1 },
    ].map((l) => legText(signedLeg(l), "signs")).join(" ")).toBe("+C7300 -2C7350 +C7400");
    expect([
      { side: "long", option_type: "PUT", strike: 6400 }, { side: "short", option_type: "PUT", strike: 6350, qty: 2 },
    ].map((l) => legText(heldLeg(l), "signs")).join(" ")).toBe("+P6400 -2P6350");
  });
});

describe("contract names", () => {
  it("drops the noise that every contract carries", () => {
    // build_spx_code hardcodes SPXW and builds strikes with int(), so the symbol and the
    // decimals are identical on every row this service can create — twenty characters of
    // which eight say nothing
    expect(shortContract("SPXW 261016 8050.00C")).toBe("261016 8050C");
    expect(shortContract("SPXW 261120 7100.00P")).toBe("261120 7100P");
  });

  it("leaves anything it does not recognise exactly as it found it", () => {
    // a name from somewhere else must not be quietly mangled into a different contract: an SPX
    // monthly, a fractional strike, and something that is not a contract at all
    expect(shortContract("SPX 261016 8050.00C")).toBe("SPX 261016 8050.00C");
    expect(shortContract("SPXW 261016 8050.50C")).toBe("SPXW 261016 8050.50C");
    expect(shortContract("1016_bs_8050")).toBe("1016_bs_8050");
  });
});

/** The service renders every timestamp in DISPLAY_TZ, so the trailing offset is the same on every
 *  row. The DATE stays: a far strike can go days without a print, and a bare clock would read as
 *  this morning. */
describe("the service's timestamp, shortened", () => {
  it("drops the zone every row repeats", () => {
    expect(shortStamp("2026-10-31 04:16:24+08:00")).toBe("2026-10-31 04:16:24");
  });

  it("drops a negative one too — DISPLAY_TZ is a setting, not a constant", () => {
    expect(shortStamp("2026-10-31 04:16:24-04:00")).toBe("2026-10-31 04:16:24");
  });

  it("keeps the day, which is the half that carries information", () => {
    expect(shortStamp("2026-10-29 04:16:24+08:00")).toContain("2026-10-29");
  });

  it("leaves a stamp that has no zone on it alone", () => {
    expect(shortStamp("2026-10-31 04:16:24")).toBe("2026-10-31 04:16:24");
  });

  it("leaves anything it does not recognise untouched", () => {
    // "x" is what every fixture in this repo passes for a timestamp; a shortener that mangles
    // the unexpected is worse than one that declines
    expect(shortStamp("x")).toBe("x");
    expect(shortStamp("2026-10-31T04:16:24.123Z")).toBe("2026-10-31T04:16:24.123Z");
  });

  it("declines a stamp of a different shape rather than cutting it to length", () => {
    // the same rule `shortContract` states: an ISO `T` with an offset is the near miss that
    // matters — the offset falls exactly where this would cut
    expect(shortStamp("2026-10-31T04:16:24-05:00")).toBe("2026-10-31T04:16:24-05:00");
  });
});

/** Opened is a TRADING day. Samples are keyed to New York's calendar, and vol attribution is null
 *  unless a holding's `opened_at` matches its first sample's day — so through the Singapore
 *  morning, when a trade gets recorded after the 04:00 close, the local date is a day ahead. */
describe("the trading day", () => {
  it("is New York's date, not the local one, through the Singapore morning", () => {
    // 09:20 in Singapore on the 20th: 21:20 on the 19th in New York
    expect(marketDay(new Date("2026-10-20T01:20:00Z"))).toBe("2026-10-19");
  });

  it("rolls when New York's does, not when Singapore's does", () => {
    // 21:00 SGT on the 20th is 09:00 in New York, half an hour before the open
    expect(marketDay(new Date("2026-10-20T13:00:00Z"))).toBe("2026-10-20");
  });
});

/** The one clock the SERVICE does not format: "screen updated …". It was `toLocaleTimeString()`
 *  and read `晚上9:39:53` in the owner's Chinese browser, beside the service's 24-hour ISO. */
describe("the screen's own clock", () => {
  it("is 24-hour and digits only, whatever locale the device is in", () => {
    // written in +08 and read in the pinned UTC: 13, not "1:39:05 PM"
    const time = clockTime(new Date("2026-10-21T21:39:05+08:00"));
    expect(time).toBe("13:39:05");
    expect(time, "a language chose part of this line").not.toMatch(/[AP]M|[　-鿿]/);
  });

  it("pads every field, so the line does not jitter as the seconds tick", () => {
    // 09:08:07 in +08 is 01:08:07 here, which pads the hour as well as the minute and the second
    expect(clockTime(new Date("2026-10-21T09:08:07+08:00"))).toBe("01:08:07");
  });
});
