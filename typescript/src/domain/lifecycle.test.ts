/** The hold: a price rule whose legs came back without a two-sided quote (#380).
 *
 *  The rest of lifecycle.ts is held by its golden cases alone; this is here as well because it is
 *  the one decision that keeps a rule from being quarantined every evening, and the cases say what
 *  it answers without saying why each answer matters.
 */
import { describe, expect, it } from "vitest";

import { buildSpxCode } from "./contract.ts";
import { holdsWithoutQuote } from "./lifecycle.ts";
import type { Monitor } from "./monitor.ts";

const EXP = "2026-12-31";
const SHORT = buildSpxCode(EXP, "CALL", 8050), LONG = buildSpxCode(EXP, "CALL", 8100);
const spread: Monitor = {
  code: "1231_8050", strike_date: EXP, option_type: "CMB", strike: 0, field: "mid_price",
  threshold: 5.51, direction: "above", compare: "abs",
  legs: [{ sign: -1, option_type: "CALL", strike: 8050 }, { sign: 1, option_type: "CALL", strike: 8100 }],
};
const single: Monitor = {
  code: SHORT, strike_date: EXP, option_type: "CALL", strike: 8050, field: "mid_price",
  threshold: 30, direction: "above", compare: "abs",
};
/** what moomoo answers out of hours: the sides at 0, no mid, the greeks still there */
const unquoted = { bid_price: 0, ask_price: 0, option_delta: 0.08 };
const quoted = { bid_price: 10.6, ask_price: 10.9, mid_price: 10.75, option_delta: 0.08 };

describe("holdsWithoutQuote", () => {
  it("holds a spread whose legs all came back with no book", () => {
    expect(holdsWithoutQuote(spread, { [SHORT]: unquoted, [LONG]: unquoted })).toBe(true);
  });

  it("holds a spread with one leg quoted and the other not: no partial sum, and no silence", () => {
    // the open quotes one leg before the other, and the spread read as one leg's whole price
    expect(holdsWithoutQuote(spread, { [SHORT]: quoted, [LONG]: unquoted })).toBe(true);
  });

  it("holds a single contract with no book", () => {
    expect(holdsWithoutQuote(single, { [SHORT]: unquoted })).toBe(true);
  });

  it("does not hold a leg that never came back: that is silence, and is counted", () => {
    expect(holdsWithoutQuote(spread, { [SHORT]: unquoted })).toBe(false);
    expect(holdsWithoutQuote(single, {})).toBe(false);
  });

  it("does not hold a rule on any other field: a missing delta is a figure that did not arrive", () => {
    const delta: Monitor = { ...single, field: "option_delta", threshold: 0.1 };
    expect(holdsWithoutQuote(delta, { [SHORT]: { bid_price: 0, ask_price: 0 } })).toBe(false);
  });

  it("does not hold a rule that has its price", () => {
    expect(holdsWithoutQuote(spread, { [SHORT]: quoted, [LONG]: quoted })).toBe(false);
  });
});
