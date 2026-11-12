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
import { dteAtOpen, onPace } from "./exit.ts";
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
 *  as absent, never as a guess. `paceExplained` says WHICH, in words.
 */
export function volAttribution(
  samples: readonly VolSample[], position: Position,
): VolAttribution | null {
  const m = measure(samples, position);
  return typeof m === "string" ? null : m;
}

/** The measurement, or the reason there is none — one walk, so the figure and the words that
 *  decline it cannot disagree about when the chain is whole. */
function measure(samples: readonly VolSample[], position: Position): VolAttribution | string {
  // The baseline is the vol you SOLD, and nothing else stands in for it. A Position declared
  // after the fact — which is how every one of these came to be — has no sample from that day,
  // and an undeclared Opened is the same statement: `observed_on` is a date and never matches a
  // null. The two are told apart only for the words; the figure is null either way.
  if (position.opened_at === null || position.opened_at === undefined) {
    return "Opened is not recorded, so there is no day to measure vol from";
  }
  if (samples.length === 0) return "no day has been recorded for it yet";
  if (samples[0]!.observed_on !== position.opened_at) {
    return `its samples begin on ${samples[0]!.observed_on}, not on ${position.opened_at} when it was `
      + "Opened: the vol it was sold at was never recorded";
  }

  const codes = positionLegCodes(position);
  // short +1, long -1: the signing costToClose uses, so the result is already in the gap's units
  const signs = position.legs.map((l) => (l.side === "short" ? 1 : -1));

  for (const s of samples) {
    const whole = s.legs_iv !== null && s.legs_vega !== null
      && codes.every((code) => reading(s.legs_iv![code]) && reading(s.legs_vega![code]));
    if (!whole) return `${s.observed_on} has no vol reading for every leg`;
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
    if (prev.dte - cur.dte !== 1) {
      return `the record skips from ${prev.observed_on} to ${cur.observed_on}: a day is missing`;
    }
    for (const [i, c] of codes.entries()) {
      // the vega held GOING INTO the move, which is the sensitivity you were actually carrying
      // when vol moved. Measured on the live condor, start/end/average spanned 0.034 points over
      // two days, so this is a small difference with a clear meaning.
      vol += signs[i]! * prev.legs_vega![c]! * (cur.legs_iv![c]! - prev.legs_iv![c]!);
    }
  }

  // the backstop. Every reading is finite and every step is one day, so this cannot fire — but
  // the route's own schema REJECTS NaN, which would answer 500 where the contract says null.
  if (!Number.isFinite(vol)) return "the readings do not add up to a finite figure";

  return {
    vol,
    from: samples[0]!.observed_on,
    to: samples[samples.length - 1]!.observed_on,
    days: samples.length - 1,
  };
}

/** One day's sample as the vol route reads it: the readings, and that day's Cost to close. */
export interface PacedSample extends VolSample {
  cost_to_close: number | null;
}

/** A pace gap explained, as far as the samples can explain it (#333): what `GET /positions/{id}/vol`
 *  serves, so every figure the dashboard says about the split is the service's own.
 *
 *  The gap it splits is the one at the LAST sample's close — the day the vol part runs to — so
 *  `vol + rest = gap` holds of three figures from one instant. A live gap minus a vol part measured
 *  to yesterday's close would charge today's vol moves to the rest.
 */
export interface PaceExplained {
  /** `volAttribution`'s four, null together where it gives nothing */
  vol: number | null;
  from: string | null;
  to: string | null;
  days: number | null;
  /** why the vol part is not to be read, in words; null when it is. Set on the day it was Opened
   *  too, where `vol` is a true zero and no measurement: nothing has moved yet. */
  reason: string | null;
  /** the day `gap`, `rest` and `vega` are at: the last sample's */
  at: string | null;
  /** that day's Cost to close less On-pace at its DTE: positive is BEHIND */
  gap: number | null;
  /** the gap less the vol part, left unattributed on purpose (CONTEXT.md: The rest); null
   *  wherever `reason` is set */
  rest: number | null;
  /** the structure's vega that day, exposure-signed as a holding's position vega is */
  vega: number | null;
  /** how many points of IV would account for the whole gap, |gap ÷ vega|: what can still be said
   *  where the vol part cannot. Null for a zero vega, which would be an infinity. */
  cover: number | null;
}

export function paceExplained(samples: readonly PacedSample[], position: Position): PaceExplained {
  const m = measure(samples, position);
  const measured = typeof m === "string" ? null : m;
  const reason = typeof m === "string" ? m
    : m.days === 0
      ? `only ${m.from}, the day it was Opened, is recorded: nothing has moved yet`
      : null;

  const last = samples.length === 0 ? null : samples[samples.length - 1]!;
  const openedDte = position.opened_at ? dteAtOpen(position.strike_date, position.opened_at) : null;
  const pace = last === null ? null : onPace(position.entry, openedDte, last.dte);
  const gap = last === null || pace === null || last.cost_to_close === null ? null : last.cost_to_close - pace;

  // exposure-signed, short −1, as `positionGreek` signs a holding's: the figure the inspector
  // already calls position vega, at this close rather than now
  let vega: number | null = null;
  if (last !== null && last.legs_vega !== null) {
    const codes = positionLegCodes(position);
    if (codes.every((c) => reading(last.legs_vega![c]))) {
      vega = 0;
      for (const [i, c] of codes.entries()) {
        vega += (position.legs[i]!.side === "short" ? -1 : 1) * last.legs_vega[c]!;
      }
    }
  }

  return {
    vol: measured?.vol ?? null,
    from: measured?.from ?? null,
    to: measured?.to ?? null,
    days: measured?.days ?? null,
    reason,
    at: last?.observed_on ?? null,
    gap,
    rest: reason === null && gap !== null ? gap - measured!.vol : null,
    vega,
    cover: gap === null || vega === null || vega === 0 ? null : Math.abs(gap / vega),
  };
}
