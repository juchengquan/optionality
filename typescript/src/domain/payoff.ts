/** The payoff at expiry: what a structure makes or loses on its expiry day, at every SPX level, for
 *  the Entry taken (#291, ADR 0023).
 *
 *  AT EXPIRY ONLY. On that day an option is worth its intrinsic value and nothing else, so the
 *  curve needs no pricing model and no market data: the legs, the Entry and the count. Anything
 *  before expiry — a T+0 curve, a "today" line, a probability — needs a model the service does not
 *  have (the backend map measured moomoo's IVs mispricing the far wings by 9–23% under a naive
 *  one), and ADR 0023 says never to draw what the system does not know.
 *
 *  The curve is piecewise linear with its corners at the strikes, so the P&L at each strike and
 *  the slope beyond the outer two describe all of it; a drawing joins the dots. Signed as
 *  everywhere else (ADR 0013): Entry is a credit RECEIVED, so a debit is negative, and a short leg
 *  costs its intrinsic value to settle while a long one pays it.
 *
 *  In POINTS, across the contracts held, as `realizedPoints` is: money needs a contract size that
 *  only a Quote carries, and this reads none.
 */
import type { Leg } from "./position.ts";
import { round4 } from "./quote.ts";

/** The P&L at expiry with SPX at `spx`. */
export interface PayoffAt {
  spx: number;
  pnl: number;
}

export interface Payoff {
  /** the P&L with SPX settling at each strike, the lowest strike first, each strike once */
  at_strikes: PayoffAt[];
  /** how much the P&L changes for each point SPX rises below the lowest strike (only puts are in
   *  the money there) and above the highest (only calls) — what "beyond the outer ones" is */
  slope_below: number;
  slope_above: number;
  /** each SPX level at which the P&L is zero, lowest first */
  breakevens: number[];
  /** the highest P&L, or null where it rises without limit as SPX does (a long call) */
  max_profit: number | null;
  /** the LOWEST P&L, signed: a loss is negative. Null where it falls without limit as SPX rises (a
   *  short call uncovered). Positive means the structure cannot lose, which for a credit is the
   *  sign of a leg entered the wrong way round — the thing a preview is for. Below the lowest
   *  strike it is bounded, because SPX stops at zero: a short put's worst is its strike less the
   *  credit. */
  max_loss: number | null;
}

/** What one leg settles for with SPX at `spx`: its intrinsic value. */
function intrinsic(leg: Leg, spx: number): number {
  return leg.option_type === "CALL" ? Math.max(0, spx - leg.strike) : Math.max(0, leg.strike - spx);
}

/** The P&L at expiry with SPX at `spx`: Entry less what the legs cost to settle, across the count.
 *  A plain left-to-right sum in the legs' order, which is what the Python port does too. */
function pnlAt(legs: Leg[], entry: number, contracts: number, spx: number): number {
  let settle = 0;
  for (const leg of legs) settle += (leg.side === "short" ? 1 : -1) * intrinsic(leg, spx);
  return (entry - settle) * contracts;
}

/** The payoff at expiry of `legs`, for an Entry of `entry` points per contract, over `contracts`.
 *
 *  Unrounded figures are used for every derivation and only the answers are rounded, to four
 *  places like every points figure, so a breakeven is not moved by its neighbours' rounding.
 */
export function payoffAtExpiry(legs: Leg[], entry: number, contracts: number): Payoff {
  const strikes = [...new Set(legs.map((l) => l.strike))].sort((a, b) => a - b);
  // SPX cannot settle below zero, so that is where the curve's left end is
  const xs = strikes.length > 0 && strikes[0]! <= 0 ? strikes : [0, ...strikes];
  const vs = xs.map((x) => pnlAt(legs, entry, contracts, x));

  // below every strike only puts pay, each a point per point SPX falls; above, only calls
  let below = 0;
  let above = 0;
  for (const leg of legs) {
    if (leg.option_type === "PUT") below += leg.side === "short" ? 1 : -1;
    else above += leg.side === "short" ? -1 : 1;
  }
  const slopeBelow = below * contracts;
  const slopeAbove = above * contracts;

  const breakevens: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    const [x, v] = [xs[i]!, vs[i]!];
    if (v === 0) breakevens.push(x);
    if (i + 1 < xs.length) {
      const [nx, nv] = [xs[i + 1]!, vs[i + 1]!];
      if ((v < 0 && nv > 0) || (v > 0 && nv < 0)) breakevens.push(x + (nx - x) * -v / (nv - v));
    }
  }
  // past the highest strike the line goes on for ever, and crosses zero once if it heads that way
  const last = vs[vs.length - 1]!;
  if ((last < 0 && slopeAbove > 0) || (last > 0 && slopeAbove < 0)) {
    breakevens.push(xs[xs.length - 1]! - last / slopeAbove);
  }

  return {
    at_strikes: strikes.map((spx) => ({ spx, pnl: round4(vs[xs.indexOf(spx)]!) })),
    slope_below: slopeBelow,
    slope_above: slopeAbove,
    breakevens: breakevens.map(round4),
    max_profit: slopeAbove > 0 ? null : round4(Math.max(...vs)),
    max_loss: slopeAbove < 0 ? null : round4(Math.min(...vs)),
  };
}
