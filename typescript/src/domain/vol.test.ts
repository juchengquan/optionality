/** What of a pace gap vol actually accounts for (ADR 0011).
 *
 *  The √T shape assumes IV has not moved. These tests pin the measurement that says how wrong
 *  that assumption was, in the gap's own units, so the gap can be split into a vol part and a
 *  remainder that is deliberately not attributed.
 */
import { describe, expect, it } from "vitest";

import { buildSpxCode } from "./contract.ts";
import { paceExplained, volAttribution, type PacedSample, type VolSample } from "./vol.ts";
import type { Position } from "./position.ts";

const EXPIRY = "2026-11-20";
const code = (type: "CALL" | "PUT", strike: number) => buildSpxCode(EXPIRY, type, strike);
const SC = code("CALL", 8200), LC = code("CALL", 8250);
const SP = code("PUT", 7100), LP = code("PUT", 7050);

const condor = (openedAt: string | null = "2026-10-06"): Position => ({
  name: "1120_IC_7100_8200",
  strike_date: EXPIRY,
  contracts: 1,
  entry: 6.86,
  opened_at: openedAt,
  legs: [
    { side: "short", option_type: "CALL", strike: 8200 },
    { side: "long", option_type: "CALL", strike: 8250 },
    { side: "short", option_type: "PUT", strike: 7100 },
    { side: "long", option_type: "PUT", strike: 7050 },
  ],
});

/** one day's row: dte, then each leg's IV, then each leg's vega */
const day = (
  observed_on: string, dte: number,
  iv: [number, number, number, number], vega: [number, number, number, number],
): VolSample => ({
  observed_on, dte,
  legs_iv: { [SC]: iv[0], [LC]: iv[1], [SP]: iv[2], [LP]: iv[3] },
  legs_vega: { [SC]: vega[0], [LC]: vega[1], [SP]: vega[2], [LP]: vega[3] },
});

const FLAT: [number, number, number, number] = [10, 10, 22, 22];
const VEGA: [number, number, number, number] = [4, 3, 3.5, 3];

describe("what vol did to the cost of closing", () => {
  it("is zero on the day it was opened, because no vol has moved yet", () => {
    // the open's row is the baseline, not an increment. Zero is the true answer, and it is a
    // different statement from "cannot say", which is null.
    expect(volAttribution([day("2026-10-06", 45, FLAT, VEGA)], condor())).toEqual({
      vol: 0, from: "2026-10-06", to: "2026-10-06", days: 0,
    });
  });

  it("makes a short leg DEARER to buy back when its own IV rises", () => {
    // signed the way costToClose is signed, so the answer lands in the gap's units and adds
    // straight onto it: you sold the 8200 call, its vol rose a point, buying it back costs its
    // vega more.
    const a = volAttribution([
      day("2026-10-06", 45, [10, 10, 22, 22], VEGA),
      day("2026-10-07", 44, [11, 10, 22, 22], VEGA),
    ], condor());
    expect(a?.vol).toBeCloseTo(4, 10);
  });

  it("makes a long leg CHEAPER to buy back when its own IV rises", () => {
    const a = volAttribution([
      day("2026-10-06", 45, [10, 10, 22, 22], VEGA),
      day("2026-10-07", 44, [10, 11, 22, 22], VEGA),
    ], condor());
    expect(a?.vol).toBeCloseTo(-3, 10);
  });

  it("sees a SKEW change that one average vol would cancel out", () => {
    // this is the whole reason the readings are kept per leg. The calls rise a point and the puts
    // fall a point, so any single weighted vol barely moves — while the structure is short the
    // high-vega call and short the put, and the two do not offset.
    const a = volAttribution([
      day("2026-10-06", 45, [10, 10, 22, 22], VEGA),
      day("2026-10-07", 44, [11, 11, 21, 21], VEGA),
    ], condor());
    // calls: +4 (short) -3 (long) = +1 ; puts: -(-3.5) ... sold put IV fell, so cheaper: -3.5
    // bought put fell, so you get less back: +3
    expect(a?.vol).toBeCloseTo(4 - 3 - 3.5 + 3, 10);
  });

  it("uses the vega held GOING INTO each move, not the one left after it", () => {
    // first order, the loss is the sensitivity you were carrying when vol moved. Measured on the
    // live condor the three choices (start, end, average) spanned 0.034 points over two days, so
    // this is a small difference with a clear meaning rather than a numerical refinement.
    const a = volAttribution([
      day("2026-10-06", 45, [10, 10, 22, 22], [4, 0, 0, 0]),
      day("2026-10-07", 44, [11, 10, 22, 22], [99, 0, 0, 0]),
    ], condor());
    expect(a?.vol).toBeCloseTo(4, 10);
  });

  it("adds each day up, so a round trip in vol nets to nothing", () => {
    const a = volAttribution([
      day("2026-10-06", 45, [10, 10, 22, 22], VEGA),
      day("2026-10-07", 44, [12, 10, 22, 22], VEGA),
      day("2026-10-08", 43, [10, 10, 22, 22], VEGA),
    ], condor());
    expect(a?.vol).toBeCloseTo(0, 10);
    expect(a?.days).toBe(2);
  });

  it("walks straight through a weekend, because the sampler records one", async () => {
    // The sampler keys a row to the New York CALENDAR date on every sweep and has no market-day
    // filter, so Saturday and Sunday are in the chain like any other day — their readings simply
    // repeat Friday's close and contribute nothing. An earlier version of this test asserted a
    // Friday-to-Monday jump of three days, which cannot happen while those rows exist.
    const a = volAttribution([
      day("2026-10-09", 42, [10, 10, 22, 22], VEGA),
      day("2026-10-10", 41, [10, 10, 22, 22], VEGA),
      day("2026-10-11", 40, [10, 10, 22, 22], VEGA),
      day("2026-10-12", 39, [11, 10, 22, 22], VEGA),
    ], { ...condor(), opened_at: "2026-10-09" });
    expect(a?.vol).toBeCloseTo(4, 10);
    expect(a?.days).toBe(3);
  });
});

describe("when it declines to say anything", () => {
  // a missing fact shows as absent, never as a guess — the rule opened_at already follows.
  it("gives nothing without a sample from the day it was opened", () => {
    // the live condor's case: recording began six days after it was put on, so the baseline it
    // would be measured against does not exist and never will.
    expect(volAttribution([
      day("2026-10-12", 39, FLAT, VEGA),
      day("2026-10-13", 38, [11, 10, 22, 22], VEGA),
    ], condor("2026-10-06"))).toBeNull();
  });

  it("gives nothing when a market day in the middle is missing", () => {
    // bridging the gap would charge one day with a move that happened over several, so the day
    // either side of an outage would both be wrong.
    expect(volAttribution([
      day("2026-10-06", 45, FLAT, VEGA),
      day("2026-10-20", 31, [11, 10, 22, 22], VEGA),
    ], condor())).toBeNull();
  });

  it("gives nothing when any day's IV was not recorded", () => {
    expect(volAttribution([
      day("2026-10-06", 45, FLAT, VEGA),
      { ...day("2026-10-07", 44, FLAT, VEGA), legs_iv: null },
      day("2026-10-08", 43, [11, 10, 22, 22], VEGA),
    ], condor())).toBeNull();
  });

  it("gives nothing when any day's vega was not recorded", () => {
    // every row written before 0003 is in this state, which is why the figure appears on trades
    // opened from then on and not before.
    expect(volAttribution([
      { ...day("2026-10-06", 45, FLAT, VEGA), legs_vega: null },
      day("2026-10-07", 44, [11, 10, 22, 22], VEGA),
    ], condor())).toBeNull();
  });

  it("gives nothing when a day is missing one of the legs", () => {
    const partial = day("2026-10-07", 44, [11, 10, 22, 22], VEGA);
    delete partial.legs_iv![LP];
    expect(volAttribution([day("2026-10-06", 45, FLAT, VEGA), partial], condor())).toBeNull();
  });

  it("gives nothing for a Position whose Opened was never declared", () => {
    expect(volAttribution([day("2026-10-06", 45, FLAT, VEGA)], condor(null))).toBeNull();
  });

  it("gives nothing at all when there are no samples", () => {
    expect(volAttribution([], condor())).toBeNull();
  });
});

describe("what the first version got wrong", () => {
  /** Three findings from a code review, each verified by running the code before it was fixed.
   *  All three share a shape: the docstring promised "cannot say" and the code answered with a
   *  number. */

  it("will not bridge a single missing market day, which a DTE step cannot see", async () => {
    // `step > 4` was meant to catch a hole while allowing a weekend (Fri->Mon is 3) and a holiday
    // Monday (Fri->Tue is 4). It allows Mon->Wed with Tuesday absent, which is 2 — so the whole
    // two-day move was priced at Monday's vega and reported as `days: 1`, under-stating the span
    // the sheet then prints. Returned {vol: 8, days: 1} before the fix.
    expect(volAttribution([
      day("2026-10-05", 46, [10, 10, 22, 22], VEGA),   // Monday
      day("2026-10-07", 44, [12, 10, 22, 22], VEGA),   // Wednesday; Tuesday missing
    ], { ...condor(), opened_at: "2026-10-05" })).toBeNull();
  });

  it("refuses a chain missing any calendar day at all, holiday or not", async () => {
    // A DTE step cannot tell a holiday from an outage, and now it does not have to: the sampler
    // writes a row for every calendar date, so a date absent from the chain means the service was
    // down for a whole New York day. That IS a hole, and refusing is the designed answer.
    //
    // Not fragile in the way a market-day rule would be: the row is keyed per date and rewritten
    // every sweep, so a deploy restart or a brief outage still leaves that day recorded.
    for (const [label, gap] of [["a weekday", 2], ["a long weekend", 4]] as [string, number][]) {
      expect(volAttribution([
        day("2026-10-09", 42, [10, 10, 22, 22], VEGA),
        day(`2026-10-${9 + gap}`, 42 - gap, [11, 10, 22, 22], VEGA),
      ], { ...condor(), opened_at: "2026-10-09" }), label).toBeNull();
    }
  });

  it("treats a reading stored as JSON null as missing, not as zero", async () => {
    // Reachable from the writer, not just a hand-edited row: legReadings accepts a quote field
    // that Number()s to NaN — it only rejects null and undefined — and JSON.stringify turns NaN
    // into null. So one bad field from OpenD stored a null reading, and `=== undefined` let it
    // through to contribute a zero weight and a zero move. Returned {vol: 0} before the fix:
    // "vol did nothing" where the truth was "cannot say".
    const baseline = day("2026-10-06", 45, FLAT, VEGA);
    baseline.legs_vega![SC] = null as unknown as number;
    expect(volAttribution([
      baseline,
      day("2026-10-07", 44, [12, 10, 22, 22], VEGA),
    ], condor())).toBeNull();
  });

  it("treats a reading that is not a finite number as missing", async () => {
    // the same rule, stated against the value rather than its spelling: NaN and Infinity are
    // numbers to `typeof` and are not readings
    const baseline = day("2026-10-06", 45, FLAT, VEGA);
    baseline.legs_iv![SP] = NaN;
    expect(volAttribution([baseline, day("2026-10-07", 44, FLAT, VEGA)], condor())).toBeNull();

    const other = day("2026-10-06", 45, FLAT, VEGA);
    other.legs_vega![LP] = Infinity;
    expect(volAttribution([other, day("2026-10-07", 44, FLAT, VEGA)], condor())).toBeNull();
  });

  it("gives nothing when finite readings multiply out to something that is not", async () => {
    // the backstop earning its place. Each reading passes `reading()` — 1e308 is finite — and the
    // product overflows, so without this the route would be handed Infinity, which its schema
    // rejects as surely as NaN. A mutation sweep found the guard unreachable by every other test.
    const base = day("2026-10-06", 45, [0, 0, 0, 0], [1e308, 0, 0, 0]);
    const next = day("2026-10-07", 44, [1e308, 0, 0, 0], [1e308, 0, 0, 0]);
    expect(volAttribution([base, next], condor())).toBeNull();
  });

  it("never returns a vol that is not a finite number", async () => {
    // the backstop, because the route's zod schema REJECTS NaN and the request then 500s. Whatever
    // reaches here, the answer is a number or null.
    const a = volAttribution([
      day("2026-10-06", 45, FLAT, VEGA),
      day("2026-10-07", 44, [12, 10, 22, 22], VEGA),
    ], condor());
    expect(a === null || Number.isFinite(a.vol)).toBe(true);
  });
});

/** The whole explanation of a pace gap, as the vol route serves it (#333): the vol part with the
 *  reason when there is none, and the gap it splits measured at the SAME close the vol part runs
 *  to, so vol + rest = gap holds of three figures from one instant. */
describe("the pace gap explained", () => {
  /** a day with that day's Cost to close, as the route reads `position_samples` */
  const paced = (cost: number | null, ...args: Parameters<typeof day>): PacedSample =>
    ({ ...day(...args), cost_to_close: cost });
  const pace = (dte: number) => 6.86 * Math.sqrt(dte / 45);
  // exposure-signed, as a holding's position vega is: a short leg's vega counts against you
  const netVega = -VEGA[0] + VEGA[1] - VEGA[2] + VEGA[3];

  it("splits the gap at the last close into the vol part and the rest", () => {
    const chain = [
      paced(6.86, "2026-10-06", 45, FLAT, VEGA),
      paced(6.9, "2026-10-07", 44, [11, 10, 22, 22], VEGA),
    ];
    const e = paceExplained(chain, condor());
    const gap = 6.9 - pace(44);
    expect(e).toEqual({
      vol: 4, from: "2026-10-06", to: "2026-10-07", days: 1, reason: null,
      at: "2026-10-07", gap, rest: gap - 4, vega: netVega, cover: Math.abs(gap / netVega),
    });
  });

  it("says why on the day it was opened, when nothing has moved yet", () => {
    const e = paceExplained([paced(6.86, "2026-10-06", 45, FLAT, VEGA)], condor());
    expect(e.reason).toBe("only 2026-10-06, the day it was Opened, is recorded: nothing has moved yet");
    expect(e.rest).toBeNull();
    // the zero is still the true answer volAttribution gives; it is the reason that says not to read it
    expect(e.vol).toBe(0);
  });

  it("says why when the samples begin after it was Opened, and still says what would cover the gap", () => {
    const e = paceExplained([
      paced(6.9, "2026-10-07", 44, FLAT, VEGA),
      paced(7.1, "2026-10-08", 43, FLAT, VEGA),
    ], condor());
    expect(e.reason).toBe(
      "its samples begin on 2026-10-07, not on 2026-10-06 when it was Opened: the vol it was sold at was never recorded",
    );
    expect([e.vol, e.from, e.to, e.days, e.rest]).toEqual([null, null, null, null, null]);
    const gap = 7.1 - pace(43);
    expect([e.at, e.gap, e.vega, e.cover]).toEqual(["2026-10-08", gap, netVega, Math.abs(gap / netVega)]);
  });

  it("names the day a reading is missing on", () => {
    const e = paceExplained([
      paced(6.86, "2026-10-06", 45, FLAT, VEGA),
      { ...paced(6.9, "2026-10-07", 44, FLAT, VEGA), legs_iv: null },
    ], condor());
    expect(e.reason).toBe("2026-10-07 has no vol reading for every leg");
  });

  it("names the two days a missing one falls between", () => {
    const e = paceExplained([
      paced(6.86, "2026-10-06", 45, FLAT, VEGA),
      paced(6.9, "2026-10-08", 43, FLAT, VEGA),
    ], condor());
    expect(e.reason).toBe("the record skips from 2026-10-06 to 2026-10-08: a day is missing");
  });

  it("says nothing has been recorded when there are no samples", () => {
    expect(paceExplained([], condor())).toEqual({
      vol: null, from: null, to: null, days: null, reason: "no day has been recorded for it yet",
      at: null, gap: null, rest: null, vega: null, cover: null,
    });
  });

  it("says Opened is missing when it was never declared, and has no gap to split", () => {
    const e = paceExplained([paced(6.86, "2026-10-06", 45, FLAT, VEGA)], condor(null));
    expect(e.reason).toBe("Opened is not recorded, so there is no day to measure vol from");
    expect([e.gap, e.rest, e.cover]).toEqual([null, null, null]);
  });

  it("has no gap where the last close has no Cost to close, and keeps the vol part", () => {
    const e = paceExplained([
      paced(6.86, "2026-10-06", 45, FLAT, VEGA),
      paced(null, "2026-10-07", 44, [11, 10, 22, 22], VEGA),
    ], condor());
    expect([e.vol, e.reason, e.gap, e.rest, e.cover]).toEqual([4, null, null, null, null]);
  });

  it("covers nothing with a net vega of zero, rather than an infinity", () => {
    const e = paceExplained([
      paced(6.86, "2026-10-06", 45, FLAT, [3, 3, 3, 3]),
      paced(7.2, "2026-10-07", 44, FLAT, [3, 3, 3, 3]),
    ], condor());
    expect([e.vega, e.cover]).toEqual([0, null]);
  });

  it("has no vega where the last close is missing one leg's", () => {
    const last = paced(7.2, "2026-10-08", 43, FLAT, VEGA);
    const e = paceExplained([
      paced(6.9, "2026-10-07", 44, FLAT, VEGA),
      { ...last, legs_vega: { [SC]: 4, [LC]: 3, [SP]: 3.5 } },
    ], condor());
    expect([e.vega, e.cover]).toEqual([null, null]);
    expect(e.gap).toBe(7.2 - pace(43));
  });
});
