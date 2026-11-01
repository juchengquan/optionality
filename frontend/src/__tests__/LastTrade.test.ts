import { describe, expect, it } from "vitest";

import type { Entry } from "../api";
import { cellValue } from "../cells";
import { SINGLE_COLUMNS, widthsFromContent } from "../columns";
import { DASH, shortStamp } from "../format";

/** The widest column on the single-leg table, and six of its characters say nothing.
 *
 *  `last trade` draws the service's own timestamp, which arrives rendered in DISPLAY_TZ as
 *  `2026-10-31 04:16:24+08:00` — twenty-five characters, of which the trailing `+08:00` is the
 *  same on every row of every table, because the service renders every timestamp it sends in that
 *  one zone. Measured against the live book on 2026-11-01 it made this column 245px wide, nearly
 *  three times the next widest; the offset alone is 54px of it.
 *
 *  The DATE stays, and that is the point of stopping here rather than trimming to a clock. These
 *  contracts last traded yesterday — an SPX strike far from the money can go days without a
 *  print — and `04:16:24` with no date reads as this morning, which is a claim about liquidity
 *  that would be false.
 */
describe("the service's timestamp, as a cell", () => {
  it("drops the zone every row repeats", () => {
    expect(shortStamp("2026-10-31 04:16:24+08:00")).toBe("2026-10-31 04:16:24");
  });

  it("drops a negative one too — DISPLAY_TZ is a setting, not a constant", () => {
    expect(shortStamp("2026-10-31 04:16:24-04:00")).toBe("2026-10-31 04:16:24");
  });

  it("keeps the day, which is the half that carries information", () => {
    // a far strike can go days without a print, and a bare clock would read as this morning
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
    // the same rule `shortContract` states: a shape this does not know must not be quietly
    // reformatted into something that LOOKS right, or the day the service changes how it writes a
    // timestamp the page shows a plausible half of it instead of an obvious whole one. An ISO `T`
    // with an offset is the near miss that matters — the offset falls exactly where this would cut.
    expect(shortStamp("2026-10-31T04:16:24-05:00")).toBe("2026-10-31T04:16:24-05:00");
  });
});

const row = (update_time: string | null) => ({
  code: "US.SPXW261204C8100000", field: "option_delta", threshold: 0.5, direction: "above",
  compare: "abs", triggered: false, strike_date: "2026-12-04", option_type: "CALL", dte: 33,
  scope: null, positions: [], legs: null, entry: null, pnl: null, cost_to_close: null,
  schedule: null, combo_value: null, combo_greeks: {},
  quote: { name: "SPXW 261204 8100.00C", update_time },
}) as unknown as Entry;

describe("the cell the table draws", () => {
  it("shows the stamp without its zone", () => {
    expect(cellValue(row("2026-10-31 04:16:24+08:00"), "last_trade", false))
      .toBe("2026-10-31 04:16:24");
  });

  it("still says nothing rather than something, where there has been no trade", () => {
    expect(cellValue(row(null), "last_trade", false)).toBe(DASH);
  });
});

describe("what the fitting is told", () => {
  const width = (rows: Entry[]) =>
    widthsFromContent(SINGLE_COLUMNS.filter((c) => c.key === "last_trade"), rows, false, 10)
      .last_trade!;

  it("asks for six characters less than the served string", () => {
    // 10px per character, so the six of "+08:00" are 60px this column no longer spends — the
    // whole reason for the trim, and the only part of it a width measurement can see
    expect(width([row("2026-10-31 04:16:24+08:00")])).toBe(19 * 10 + 22);
    // and no narrower than the stamp it draws, which is the claim the picture above rests on
    expect(width([row("2026-10-31 04:16:24")]))
      .toBe(width([row("2026-10-31 04:16:24+08:00")]));
  });
});
