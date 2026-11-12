/** The strike strip's figures (#297): a spread's short and long strikes, SPX's derived price, and
 *  how far the one is from the other. Pure — no React, no DOM — so the strip, the desk's column and
 *  its measuring read one text.
 *
 *  Every figure is the service's (ADR 0005): the short strikes, their Δ and their distances in
 *  points and σ are `short_strikes` (`strikeDistances` in the domain), and SPX is the row's own
 *  `spx`, derived from the same batch (ADR 0024). Where it has none, the row's `spx_reason` says
 *  why, and nothing here fills the gap — not the References strip's SPX, which nothing derives
 *  from (ADR 0018). The one piece of arithmetic is where a strike sits on the drawn scale.
 */
import type { Entry, Holding } from "../api";
import { DASH } from "../format";

export type ShortStrike = Holding["short_strikes"][number];

export interface LongStrike {
  option_type: string;
  strike: number;
}

export interface Strip {
  shorts: ShortStrike[];
  longs: LongStrike[];
  spx: number | null;
  /** why `spx` is null, as the service said it */
  reason: string | null;
}

/** A holding's strip; null for one with no short leg — a lone long held as a hedge — which has no
 *  short strike for SPX to near, as `stripOfEntry` draws none for a single contract. */
export function stripOfHolding(h: Holding): Strip | null {
  if (!h.legs.some((l) => l.side === "short")) return null;
  return {
    // `?? []`: a payload from before the field was served draws no short strikes rather than failing
    shorts: h.short_strikes ?? [],
    longs: h.legs.filter((l) => l.side === "long").map((l) => ({ option_type: l.option_type, strike: l.strike })),
    spx: h.spx ?? null, reason: h.spx_reason ?? null,
  };
}

/** A watched spread's strip; null for a single contract, which is no spread. Its legs are signed,
 *  minus short (the canonical convention), so plus is long. */
export function stripOfEntry(e: Entry): Strip | null {
  if (!e.legs || e.legs.length === 0) return null;
  return {
    shorts: e.short_strikes ?? [],
    longs: e.legs.filter((l) => l.sign > 0).map((l) => ({ option_type: l.option_type, strike: l.strike })),
    spx: e.spx ?? null, reason: e.spx_reason ?? null,
  };
}

/** A condor held as two spreads, on one strip: both came from the same response, so one SPX. */
export function joinStrips(a: Strip, b: Strip): Strip {
  return { shorts: [...a.shorts, ...b.shorts], longs: [...a.longs, ...b.longs], spx: a.spx, reason: a.reason };
}

/** The short strike SPX is nearest to — or furthest past — by the served points; null with none. */
export function nearest(strip: Strip): ShortStrike | null {
  let best: ShortStrike | null = null;
  for (const k of strip.shorts) {
    if (k.points === null) continue;
    if (best === null || k.points < best.points!) best = k;
  }
  return best;
}

const pts = (n: number) => Math.abs(n).toFixed(2);

/** "500.50 pts · 1.25σ away", "249.50 pts · 0.62σ past it", or a dash where there is no distance. */
export function distanceWords(k: ShortStrike): string {
  if (k.points === null) return DASH;
  const sigma = k.sigma === null ? "" : ` · ${pts(k.sigma)}σ`;
  const where = k.points > 0 ? "away" : k.points < 0 ? "past it" : "at the strike";
  return `${pts(k.points)} pts${sigma} ${where}`;
}

/** What a row says beside its strip: the nearest short strike's distance, or a dash. */
export function cellWords(strip: Strip): string {
  const k = nearest(strip);
  if (k === null || k.points === null) return DASH;
  const signed = (n: number) => `${n < 0 ? "−" : ""}${pts(n)}`;
  return `${signed(k.points)} pts${k.sigma === null ? "" : ` · ${signed(k.sigma)}σ`}`;
}

/** "P6400": which short strike, as the legs column writes it. */
export const strikeName = (k: { option_type: string; strike: number }) => `${k.option_type[0]}${k.strike}`;

/** Δ to three places with a true minus, as the strip writes it on its strike. */
export const deltaWords = (d: number | null) => d === null ? `Δ ${DASH}` : `Δ ${d.toFixed(3).replace("-", "−")}`;

/** Where a price sits across the drawn scale, as a percentage of its width: every strike and SPX
 *  inside it, padded so the outermost labels have room. */
export function scaleOf(strip: Strip): (price: number) => number {
  const xs = [...strip.shorts.map((k) => k.strike), ...strip.longs.map((k) => k.strike)];
  if (strip.spx !== null) xs.push(strip.spx);
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  const pad = Math.max((hi - lo) * 0.08, 5);
  const [from, to] = [lo - pad, hi + pad];
  return (price) => 6 + (88 * (price - from)) / (to - from);
}
