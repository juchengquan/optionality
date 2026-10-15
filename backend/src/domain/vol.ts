/** What of a pace gap vol actually accounts for (ADR 0011).
 *
 *  The On-pace line is a pure decay shape, `√(d/D₀)`, with no IV input by design — that is what
 *  makes it falsifiable from the stored samples. So this does NOT move the line. It measures how
 *  much of the GAP between Cost to close and that line is vol, leaving a remainder which is
 *  deliberately not attributed: spot, skew beyond first order, and the shape being approximate
 *  away from the money all live in it, and spot is usually the larger half.
 *
 *  Per leg and signed, never through one average vol. On the live condor the two methods disagreed
 *  in SIGN over two days — 0.30 against -0.29, 9% of the credit — because a weighted vol fell
 *  while the highest-vega leg, a short call, rose. A structure has no IV; it has four, and they
 *  move apart.
 */
import { positionLegCodes, type Position } from "./position.ts";

/** One market day's readings, as the sampler stored them. */
export interface VolSample {
  observed_on: string;
  dte: number;
  /** contract code -> implied volatility, or null where not every leg was priced that day */
  legs_iv: Record<string, number> | null;
  /** contract code -> vega. Null on every row written before migration 0003. */
  legs_vega: Record<string, number> | null;
}

export interface VolAttribution {
  /** In Cost-to-close units and signed the way `costToClose` is signed, so it adds straight onto
   *  a pace gap: POSITIVE means vol made the holding dearer to buy back, i.e. pushed you behind. */
  vol: number;
  /** the sample this was measured from — always the day the Position was Opened */
  from: string;
  to: string;
  /** market days counted, so a caller can say how long the measurement covers */
  days: number;
}

/** A finite number, and nothing else that `typeof` would call one.
 *
 *  `undefined` was the only thing checked, so a reading stored as JSON `null` passed and then
 *  contributed a zero weight and a zero move — "vol did nothing" where the truth was "cannot
 *  say". That is reachable from the writer, not only from a hand-edited row: a quote field that
 *  `Number()`s to NaN used to be stored, and `JSON.stringify(NaN)` is `null`. */
const reading = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Vol's share of the gap, or null when it cannot be said.
 *
 *  `samples` must be ordered by `observed_on`. Null — rather than a number — whenever the chain
 *  is not whole: no sample from the day it was Opened, a market day missing in the middle, or any
 *  day whose readings were not recorded. The same rule Opened itself follows: a missing fact shows
 *  as absent, never as a guess.
 */
export function volAttribution(
  samples: readonly VolSample[], position: Position,
): VolAttribution | null {
  // The baseline is the vol you SOLD, and nothing else stands in for it. A Position declared
  // after the fact — which is how every one of these came to be — has no sample from that day,
  // and an undeclared Opened is the same statement: `observed_on` is a date and never matches a
  // null. A separate `!opened_at` guard sat here and a mutation sweep showed it could not fail —
  // this one check covers both, so there is no inert guard reading as though it were load-bearing.
  if (samples.length === 0 || samples[0]!.observed_on !== position.opened_at) return null;

  const codes = positionLegCodes(position);
  // sold +1, bought -1: the signing costToClose uses, so the result is already in the gap's units
  const signs = position.legs.map((l) => (l.side === "sold" ? 1 : -1));

  for (const s of samples) {
    if (s.legs_iv === null || s.legs_vega === null) return null;
    for (const code of codes) {
      if (!reading(s.legs_iv[code]) || !reading(s.legs_vega[code])) return null;
    }
  }

  let vol = 0;
  for (let d = 1; d < samples.length; d++) {
    const prev = samples[d - 1]!, cur = samples[d]!;
    // EXACTLY one day. The sampler keys a row to the New York calendar date (`marketDate`) on
    // every sweep, weekends included — there is no market-day filter anywhere — so consecutive
    // rows are consecutive calendar days and any larger step is a hole in the record.
    //
    // This was `step > 4`, meant to allow a weekend and a holiday Monday. It allowed Mon -> Wed
    // with Tuesday absent, which is the hole the docstring promises to refuse, and it priced the
    // whole two-day move at Monday's vega while reporting `days: 1`. A code review found it.
    // Needing no holiday calendar is the point: a DTE step cannot tell a holiday from an outage,
    // and a calendar-day step does not have to.
    if (prev.dte - cur.dte !== 1) return null;
    for (const [i, c] of codes.entries()) {
      // the vega held GOING INTO the move, which is the sensitivity you were actually carrying
      // when vol moved. Measured on the live condor, start/end/average spanned 0.034 points over
      // two days, so this is a small difference with a clear meaning.
      vol += signs[i]! * prev.legs_vega![c]! * (cur.legs_iv![c]! - prev.legs_iv![c]!);
    }
  }

  // the backstop. Every reading is finite and every step is one day, so this cannot fire — but
  // the route's own schema REJECTS NaN, which would answer 500 where the contract says null.
  if (!Number.isFinite(vol)) return null;

  return {
    vol,
    from: samples[0]!.observed_on,
    to: samples[samples.length - 1]!.observed_on,
    days: samples.length - 1,
  };
}
