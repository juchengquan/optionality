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
import { inSampleHours, marketDate, sampleTiming } from "./expiry.ts";
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
    return `its samples begin on ${dayWords(samples[0]!.observed_on)}, not on ${dayWords(position.opened_at)} `
      + "when it was Opened: the vol it was sold at was never recorded";
  }

  const codes = positionLegCodes(position);
  // short +1, long -1: the signing costToClose uses, so the result is already in the gap's units —
  // times the leg's quantity, as costToClose multiplies it (#351); the readings stay per contract
  const signs = position.legs.map((l) => (l.side === "short" ? 1 : -1) * (l.qty ?? 1));

  for (const s of samples) {
    const whole = s.legs_iv !== null && s.legs_vega !== null
      && codes.every((code) => reading(s.legs_iv![code]) && reading(s.legs_vega![code]));
    if (!whole) return `${dayWords(s.observed_on)} has no vol reading for every leg`;
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
      return `the record skips from ${dayWords(prev.observed_on)} to ${dayWords(cur.observed_on)}: a day is missing`;
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

/** One day's sample as the vol route reads it: the readings, that day's Cost to close, and when
 *  it was observed (UTC as stored, null on rows from before observation times were kept). */
export interface PacedSample extends VolSample {
  cost_to_close: number | null;
  observed_at: string | null;
}

/** What the last sample is, said of the instant it was observed (`sampleTiming`, with the clock):
 *  `close` only once its day's hours are over — a row observed in the hours of a day still in them
 *  is rewritten by every sweep (`takesSample`) and is `in-hours` until they end. */
export type PacedTiming = "close" | "in-hours" | "before-open" | "after-close" | "unrecorded";

/** A pace gap explained, as far as the samples can explain it (#333): what `GET /positions/{id}/vol`
 *  serves, so every figure and every sentence the dashboard says about the split is the service's.
 *
 *  The gap it splits is the one at the LAST sample — the day the vol part runs to — so
 *  `vol + rest = gap` holds of three figures from one instant. A live gap minus a vol part measured
 *  to the last sample would charge the day's own vol moves to the rest (ADR 0011, 2026-11-12).
 *
 *  Each figure that can be absent says why when it is: `reason` for the vol part, `gap_reason` for
 *  the gap and so the rest, `cover_reason` for the cover. Dates in them are written "9 Nov".
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
  /** what that sample is: the day's close, or a reading in or out of the hours */
  timing: PacedTiming | null;
  /** that sample's Cost to close less On-pace at its DTE: positive is BEHIND */
  gap: number | null;
  /** why there is no gap, and so no rest; null when there is one */
  gap_reason: string | null;
  /** the gap less the vol part, left unattributed on purpose (CONTEXT.md: The rest); null wherever
   *  `reason` or `gap_reason` is set */
  rest: number | null;
  /** the structure's vega that day, exposure-signed as a holding's position vega is; 0 when it
   *  nets below display precision, where a sign or a quotient of it would be noise */
  vega: number | null;
  /** how many points of IV would account for the whole gap, |gap ÷ vega|: what can still be said
   *  where the vol part cannot */
  cover: number | null;
  /** why there is no cover; null when there is one */
  cover_reason: string | null;
}

/** A net vega smaller than this is zero: it is the precision every vega is shown at, and legs
 *  that cancel to 2.8e-17 would otherwise cover a gap with 1e17 vol points. */
export const VEGA_FLOOR = 0.005;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "9 Nov": a stored YYYY-MM-DD as the dashboard writes a day, by string, with no zone to move it. */
function dayWords(iso: string): string {
  return `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;
}

export function paceExplained(
  samples: readonly PacedSample[], position: Position, now: Date,
): PaceExplained {
  // The gap is at the last day with a Cost to close, and the vol part runs to that same day, so the
  // three stay one instant. A day kept only for its vol readings (#380: no two-sided quote out of
  // hours — a weekend, the small hours before the open) is SKIPPED, never the end of the split:
  // otherwise every weekend read "has no Cost to close". Where no day has a cost, nothing is skipped
  // and the last day says so.
  let priced = samples.length - 1;
  while (priced >= 0 && samples[priced]!.cost_to_close === null) priced -= 1;
  const upTo = priced < 0 ? samples : samples.slice(0, priced + 1);
  const m = measure(upTo, position);
  const measured = typeof m === "string" ? null : m;
  const reason = typeof m === "string" ? m
    : m.days === 0
      ? `only ${dayWords(m.from)}, the day it was Opened, is recorded: nothing has moved yet`
      : null;

  const last = upTo.length === 0 ? null : upTo[upTo.length - 1]!;

  let timing: PacedTiming | null = null;
  if (last !== null) {
    const t = sampleTiming(last.observed_at);
    timing = t === "close" && last.observed_on === marketDate(now) && inSampleHours(now) ? "in-hours" : t;
  }

  // the gap, or the first thing missing for one
  const openedDte = position.opened_at ? dteAtOpen(position.strike_date, position.opened_at) : null;
  let gap: number | null = null;
  let gapReason: string | null = null;
  if (openedDte === null) gapReason = "Opened is not recorded, so there is no On-pace to measure a gap from";
  else if (last === null) gapReason = "no day has been recorded for it yet";
  else if (position.entry === null) gapReason = "Entry is not recorded, so there is no On-pace to measure a gap from";
  else {
    const pace = onPace(position.entry, openedDte, last.dte);
    if (pace === null) {
      gapReason = `there is no On-pace at ${last.dte} DTE for a holding opened at ${openedDte} DTE`;
    } else if (last.cost_to_close === null) {
      gapReason = `${dayWords(last.observed_on)} has no Cost to close`;
    } else {
      gap = last.cost_to_close - pace;
    }
  }

  // exposure-signed, short −1, as `positionGreek` signs a holding's: the figure the inspector
  // already calls position vega, at that sample rather than now
  let vega: number | null = null;
  if (last !== null && last.legs_vega !== null) {
    const codes = positionLegCodes(position);
    if (codes.every((c) => reading(last.legs_vega![c]))) {
      vega = 0;
      for (const [i, c] of codes.entries()) {
        const leg = position.legs[i]!;
        vega += (leg.side === "short" ? -1 : 1) * (leg.qty ?? 1) * last.legs_vega[c]!;
      }
      if (Math.abs(vega) < VEGA_FLOOR) vega = 0;
    }
  }

  let cover: number | null = null;
  let coverReason: string | null = null;
  if (gap === null) coverReason = gapReason;
  else if (vega === null) coverReason = `${dayWords(last!.observed_on)} has no vega for every leg`;
  else if (vega === 0) coverReason = "its legs' vegas cancel out, so no move in vol would cover the gap";
  else cover = Math.abs(gap / vega);

  return {
    vol: measured?.vol ?? null,
    from: measured?.from ?? null,
    to: measured?.to ?? null,
    days: measured?.days ?? null,
    reason,
    at: last?.observed_on ?? null,
    timing,
    gap,
    gap_reason: gapReason,
    rest: reason === null && gap !== null ? gap - measured!.vol : null,
    vega,
    cover,
    cover_reason: coverReason,
  };
}
