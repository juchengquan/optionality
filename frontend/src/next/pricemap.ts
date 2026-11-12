/** The price map's figures (#298, ADR 0023's prototype C as a desk panel): every spread on the
 *  book, held and watched, in a lane per expiry on ONE SPX axis, SPX's derived price as the line
 *  through all of them, and a ±1σ band per lane. Pure — no React, no DOM — so what the panel draws
 *  is decided and tested here.
 *
 *  Every figure is the service's (ADR 0005):
 *  - the strikes, each short strike's Δ and its distance are `short_strikes` (`strikeDistances`);
 *  - SPX is the rows' own `spx`, derived from their batch (ADR 0024) and never a Reference's;
 *    where there is none, `spx_reason` says why and no line is drawn, never one at zero;
 *  - a lane's band is SPX ± the served `one_sigma` of the lane's short strike nearest SPX. A lane
 *    has one band and the skew gives each strike its own IV, so the nearest one's stands for the
 *    lane, and the lane says whose it is. A lane whose short strikes carry no `one_sigma` has no
 *    band, and says so: none is worked out here.
 *
 *  What is placed is `placeBook`'s, the table's own grouping, so the map and the table cannot
 *  disagree about what is held and what watched. Each spread carries the id of the table row it
 *  is, which is how a selection in one is a selection in the other.
 */
import type { Entry, Holding } from "../api";
import type { BookModel } from "./placement";
import { strikeName, stripOfEntry, stripOfHolding, type LongStrike, type ShortStrike } from "./strip";

export interface MapSpread {
  /** the desk row it is: a holding's id, or a watched rule's */
  id: string;
  name: string;
  kind: "held" | "watched";
  shorts: ShortStrike[];
  longs: LongStrike[];
  /** its lowest and highest strike: what the bar spans */
  lo: number;
  hi: number;
}

export interface Band {
  /** the short strike whose served one σ the band is */
  strike: ShortStrike;
  lo: number;
  hi: number;
}

export interface Lane {
  expiry: string;
  dte: number;
  spreads: MapSpread[];
  band: Band | null;
  /** why there is no band, in words; null when there is one */
  bandWhy: string | null;
}

export interface PriceMap {
  lanes: Lane[];
  spx: number | null;
  /** why `spx` is null, as the service said it */
  reason: string | null;
}

/** SPX's price for the whole map: the watchlist's batch's, or the holdings' where that one had
 *  none. Each response is one batch and carries its figure on every row (ADR 0024); the two are
 *  polled together, so either is the book's instant. */
export function spxOfBook(quotes: Entry[], holdings: Holding[] | null): { spx: number | null; reason: string | null } {
  const rows: (Entry | Holding)[] = [...quotes, ...(holdings ?? [])];
  const priced = rows.find((r) => typeof r.spx === "number");
  if (priced) return { spx: priced.spx!, reason: null };
  const said = rows.find((r) => r.spx_reason);
  return { spx: null, reason: said?.spx_reason ?? "nothing on the book to derive it from" };
}

const spreadOf = (id: string, name: string, kind: MapSpread["kind"],
  strip: { shorts: ShortStrike[]; longs: LongStrike[] }): MapSpread | null => {
  const strikes = [...strip.shorts.map((k) => k.strike), ...strip.longs.map((k) => k.strike)];
  if (strikes.length === 0) return null;
  return { id, name, kind, shorts: strip.shorts, longs: strip.longs, lo: Math.min(...strikes), hi: Math.max(...strikes) };
};

/** The map of a placed book, against the book's SPX (`spxOfBook`). */
export function priceMapOf(placed: BookModel, { spx, reason }: { spx: number | null; reason: string | null }): PriceMap {
  const lanes = new Map<string, Lane>();
  const lane = (expiry: string, dte: number) => {
    let l = lanes.get(expiry);
    if (!l) {
      l = { expiry, dte, spreads: [], band: null, bandWhy: null };
      lanes.set(expiry, l);
    }
    return l;
  };
  for (const g of placed.holdings) {
    for (const { holding } of g.rows.flat()) {
      // a holding's own legs, short or long: a lone long hedge is still something held on the axis
      const strip = stripOfHolding(holding) ?? {
        shorts: [], longs: holding.legs.map((l) => ({ option_type: l.option_type, strike: l.strike })),
      };
      const s = spreadOf(holding.id, holding.name, "held", strip);
      if (s) lane(holding.strike_date, holding.dte).spreads.push(s);
    }
  }
  for (const g of placed.watchlist) {
    for (const { entry } of g.items) {
      // a single contract is no spread: the map draws spreads
      const strip = stripOfEntry(entry);
      const s = strip ? spreadOf(entry.id, entry.code, "watched", strip) : null;
      if (s) lane(entry.strike_date, entry.dte).spreads.push(s);
    }
  }
  const out = [...lanes.values()].sort((a, b) => a.expiry.localeCompare(b.expiry));
  for (const l of out) {
    if (spx === null) {
      l.bandWhy = "no ±1σ without SPX";
      continue;
    }
    const shorts = l.spreads.flatMap((s) => s.shorts)
      .filter((k) => k.one_sigma !== null && k.one_sigma !== undefined && k.points !== null);
    if (shorts.length === 0) {
      l.bandWhy = "no ±1σ: no IV served";
      continue;
    }
    const strike = shorts.reduce((a, b) => (Math.abs(b.points!) < Math.abs(a.points!) ? b : a));
    l.band = { strike, lo: spx - strike.one_sigma!, hi: spx + strike.one_sigma! };
  }
  return { lanes: out, spx, reason };
}

/** "±1σ 401 pts · P7150's IV": the band's width and whose IV it was worked from. */
export function bandWords(lane: Lane): string {
  if (!lane.band) return lane.bandWhy ?? "";
  return `±1σ ${lane.band.strike.one_sigma!.toFixed(0)} pts · ${strikeName(lane.band.strike)}'s IV`;
}

/** The axis: every strike, SPX and every band, padded so nothing sits on an edge. */
export function domainOf(map: PriceMap): [number, number] {
  const xs = map.lanes.flatMap((l) => [
    ...l.spreads.flatMap((s) => [s.lo, s.hi]), ...(l.band ? [l.band.lo, l.band.hi] : []),
  ]);
  if (map.spx !== null) xs.push(map.spx);
  if (xs.length === 0) return [0, 1];
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  const pad = Math.max((hi - lo) * 0.04, 10);
  return [lo - pad, hi + pad];
}

/** Round strikes to mark the axis with, about `count` of them, inside it. */
export function ticksOf(lo: number, hi: number, count: number): number[] {
  const raw = (hi - lo) / Math.max(1, count);
  const step = [5, 10, 25, 50, 100, 250, 500, 1000, 2500].find((s) => s >= raw) ?? 5000;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(v);
  return out;
}

/** Each footprint's row: the first one it overlaps nothing on, so no two spreads' marks or labels
 *  are drawn over each other. Footprints are [left, right] in any one unit. */
export function slotRows(footprints: [number, number][]): number[] {
  const rows: [number, number][][] = [];
  return footprints.map(([a, b]) => {
    let i = rows.findIndex((taken) => taken.every(([x, y]) => b < x || a > y));
    if (i < 0) {
      rows.push([]);
      i = rows.length - 1;
    }
    rows[i]!.push([a, b]);
    return i;
  });
}
