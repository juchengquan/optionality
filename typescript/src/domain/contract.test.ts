/** SPX contract codes and the expiry dates they are built from.
 *
 *  The Python original (apis/aux.py) has no tests of its own — it leans on date.fromisoformat to
 *  both accept two spellings and reject impossible days, so there was nothing hand-written to
 *  port. These are written from what that function actually does, checked against it value by
 *  value (ADR 0009, phase 3).
 */
import { describe, expect, it } from "vitest";

import {
  buildSpxCode, compactStrikeDate, expandSpxShort, normalizeStrikeDate, parseSpxCode, shortSpxCode,
} from "./contract.ts";

describe("strike dates", () => {
  it("takes both spellings the API accepts", () => {
    expect(normalizeStrikeDate("2026-12-18")).toBe("2026-12-18");
    expect(normalizeStrikeDate("20261218")).toBe("2026-12-18");
  });

  it("refuses a day that does not exist", () => {
    // date.fromisoformat does this for the Python; a bare regex would not, and a wrong code
    // reaches OpenD as a contract that simply is not there
    for (const bad of ["2026-13-01", "2026-02-30", "2026-00-10", "2026-01-32", "20260230"]) {
      expect(() => normalizeStrikeDate(bad), bad).toThrow(/invalid strike_date/);
    }
  });

  it("refuses anything that is not one of the two forms", () => {
    for (const bad of ["18/12/2026", "2026-12-18T00:00", "26-12-18", "", "2026-12-1"]) {
      expect(() => normalizeStrikeDate(bad), bad).toThrow(/invalid strike_date/);
    }
  });

  it("accepts a leap day in a leap year and not otherwise", () => {
    expect(normalizeStrikeDate("2028-02-29")).toBe("2028-02-29");
    expect(() => normalizeStrikeDate("2026-02-29")).toThrow(/invalid strike_date/);
  });
});

describe("contract codes", () => {
  it("builds the code moomoo expects", () => {
    expect(buildSpxCode("2026-10-16", "CALL", 7100)).toBe("US.SPXW261016C7100000");
    expect(buildSpxCode("2026-10-16", "PUT", 7100)).toBe("US.SPXW261016P7100000");
  });

  it("truncates a fractional strike rather than rounding it", () => {
    // Python writes int(strike), which goes toward zero. Math.round would move 7100.5 to 7101
    // and silently name a different contract.
    expect(buildSpxCode("2026-10-16", "CALL", 7100.5)).toBe("US.SPXW261016C7100000");
    expect(buildSpxCode("2026-10-16", "CALL", 7100.9)).toBe("US.SPXW261016C7100000");
  });

  it("treats anything that is not a CALL as a put, as the Python does", () => {
    expect(buildSpxCode("2026-10-16", "call", 7100)).toContain("C7100000");
    expect(buildSpxCode("2026-10-16", "put", 7100)).toContain("P7100000");
  });

  it("accepts the compact date here too", () => {
    expect(buildSpxCode("20261016", "CALL", 7100)).toBe("US.SPXW261016C7100000");
  });
});

describe("reading a code back", () => {
  /** buildSpxCode had no inverse, and three places therefore knew its grammar by heart: the bot's
   *  printed short form, the short form /unwatch accepts, and the dashboard's own regex. The pair
   *  below is the property that matters — anything buildSpxCode writes, parseSpxCode reads back. */
  it("is buildSpxCode read backwards", () => {
    expect(parseSpxCode("US.SPXW261120P6500000"))
      .toEqual({ strike_date: "2026-11-20", option_type: "PUT", strike: 6500 });
    expect(parseSpxCode("US.SPXW261016C7100000"))
      .toEqual({ strike_date: "2026-10-16", option_type: "CALL", strike: 7100 });
  });

  it("round-trips every code the service can create", () => {
    for (const date of ["2026-10-16", "2026-12-31", "2028-02-29", "2026-01-01"]) {
      for (const type of ["CALL", "PUT"] as const) {
        for (const strike of [0, 5, 6500, 8100.9, 12345]) {
          const code = buildSpxCode(date, type, strike);
          const back = parseSpxCode(code);
          expect(back, code).toEqual({ strike_date: date, option_type: type, strike: Math.trunc(strike) });
          expect(buildSpxCode(back!.strike_date, back!.option_type, back!.strike), code).toBe(code);
        }
      }
    }
  });

  it("answers null rather than throwing, because every caller leaves what it cannot read alone", () => {
    for (const bad of ["US.WEIRD123", "sep-condor", "", "US.SPXW261120X6500000",
      "US.SPXW261120P6500", "SPXW261120P6500000", "US.SPXW2611P6500000"]) {
      expect(parseSpxCode(bad), bad).toBeNull();
    }
  });

  it("refuses a well-formed code naming a day that does not exist", () => {
    // the regex alone would hand back strike_date 2026-02-30, and a date nothing can be
    // expiring on is worse than no answer
    expect(parseSpxCode("US.SPXW260230P6500000")).toBeNull();
    expect(parseSpxCode("US.SPXW261332P6500000")).toBeNull();
  });

  it("refuses a strike spelled with a leading zero, which buildSpxCode never writes", () => {
    // it parses to 6500, whose code is a different string — so accepting it would break the
    // round trip above while looking entirely correct
    expect(parseSpxCode("US.SPXW261120P06500000")).toBeNull();
  });

  it("writes the six digits a code and the bot's short form share", () => {
    expect(compactStrikeDate("2026-10-16")).toBe("261016");
    expect(compactStrikeDate("20261016")).toBe("261016");
    expect(() => compactStrikeDate("2026-02-30")).toThrow(/invalid strike_date/);
  });
});

describe("the short form", () => {
  it("drops the SPXW and the trailing 000, which every contract has", () => {
    expect(shortSpxCode("US.SPXW260918C8100000")).toBe("260918 C8100");
    expect(shortSpxCode("US.SPXW261218P6425000")).toBe("261218 P6425");
  });

  it("leaves a name that is not one of our codes alone", () => {
    expect(shortSpxCode("US.WEIRD123")).toBe("US.WEIRD123");
    expect(shortSpxCode("sep-condor")).toBe("sep-condor");
  });

  it("reads back what it printed, which is what /unwatch is given", () => {
    // the bot prints "260918 C8100" and accepts it typed back, and before these were one pair
    // nothing said so: two regexes in two files, each correct on its own
    const code = "US.SPXW260918C8100000";
    expect(expandSpxShort(shortSpxCode(code))).toBe(code);
  });

  it("takes it as a person types it — any case, with or without the space", () => {
    expect(expandSpxShort("260918c8100")).toBe("US.SPXW260918C8100000");
    expect(expandSpxShort("260918 C8100")).toBe("US.SPXW260918C8100000");
    expect(expandSpxShort("  260918   c8100 ")).toBe("US.SPXW260918C8100000");
  });

  it("answers null for anything else, including a day that does not exist", () => {
    for (const bad of ["260918", "C8100", "sep-condor", "", "26091C8100", "260230C8100"]) {
      expect(expandSpxShort(bad), bad).toBeNull();
    }
  });
});
