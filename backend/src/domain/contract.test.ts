/** SPX contract codes and the expiry dates they are built from.
 *
 *  The Python original (apis/aux.py) has no tests of its own — it leans on date.fromisoformat to
 *  both accept two spellings and reject impossible days, so there was nothing hand-written to
 *  port. These are written from what that function actually does, checked against it value by
 *  value (ADR 0009, phase 3).
 */
import { describe, expect, it } from "vitest";

import { buildSpxCode, normalizeStrikeDate } from "./contract.ts";

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
