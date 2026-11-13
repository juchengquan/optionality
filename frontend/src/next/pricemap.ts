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
import type { Entry, Holding } from "../shared/api";
import { entryName } from "./needs";
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
  /** SPX's price in the batch its own figures came from: the holdings' or the watchlist's */
  spx: number | null;
}

export interface Band {
  /** the short strike whose served one σ the band is */
  strike: ShortStrike;
  /** SPX's price in that strike's own batch, which the band is centred on */
  centre: number;
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

/** SPX's price for the map's one line, and the batch it is from. */
export interface SpxLine {
  spx: number | null;
  /** why `spx` is null, as the service said it */
  reason: string | null;
  /** which response's batch: `/quotes` (the watchlist) or `/positions/values` (the holdings) */
  source: "watchlist" | "holdings" | null;
  /** when that batch was fetched, as the service served it (`fetched_at`), or null where unsaid */
  at: string | null;
}

export interface PriceMap extends SpxLine {
  lanes: Lane[];
}

/** A served instant as a number to compare, or null where it is not one. */
const instant = (at: string | null) => {
  if (at === null) return null;
  const t = Date.parse(at.replace(" ", "T"));
  return Number.isNaN(t) ? null : t;
};

/** SPX's price for the map's one line: from ONE batch — the watchlist's or the holdings', each
 *  carrying its figure on every row (ADR 0024) — whichever was fetched most recently by its own
 *  served `fetched_at`. A batch that says no time ranks below one that does; with neither timed,
 *  the watchlist's, which is the poll's own. The watchlist's time is its single contracts'
 *  `quote.fetched_at` (a combo row carries no quote); the holdings' is their `fetched_at`. */
export function spxOfBook(quotes: Entry[], holdings: Holding[] | null): SpxLine {
  const batches = [
    { source: "watchlist" as const, rows: quotes as (Entry | Holding)[],
      at: quotes.map((q) => q.quote?.fetched_at).find((t): t is string => typeof t === "string") ?? null },
    { source: "holdings" as const, rows: (holdings ?? []) as (Entry | Holding)[],
      at: (holdings ?? []).map((h) => h.fetched_at).find((t): t is string => instant(t) !== null) ?? null },
  ];
  const priced = batches.filter((b) => typeof b.rows[0]?.spx === "number");
  if (priced.length > 0) {
    const best = priced.reduce((a, b) => ((instant(b.at) ?? -Infinity) > (instant(a.at) ?? -Infinity) ? b : a));
    return { spx: best.rows[0]!.spx!, reason: null, source: best.source, at: best.at };
  }
  const said = batches.flatMap((b) => b.rows).find((r) => r.spx_reason);
  return { spx: null, reason: said?.spx_reason ?? "nothing on the book to derive it from", source: null, at: null };
}

/** "23:14:35": the clock time of a served instant, as the service wrote it in DISPLAY_TZ. */
const clockOf = (at: string | null) => /\d{2}:\d{2}:\d{2}/.exec(at ?? "")?.[0] ?? null;

/** What the map says above its line: SPX's price, and which batch and when — outside the session,
 *  where the holdings are not polled, "as last valued" (#371) — or, with no price, why. */
export function spxWords(line: SpxLine, session: boolean): string {
  if (line.spx === null) return `SPX — ${line.reason ?? "no price"}`;
  const time = clockOf(line.at);
  const whose = !session ? "as last valued"
    : `from the ${line.source === "holdings" ? "holdings'" : "watchlist's"} batch`;
  return `SPX ${line.spx.toFixed(2)} · ${whose}${time ? `, ${time}` : ""}`;
}

const spreadOf = (id: string, name: string, kind: MapSpread["kind"],
  strip: { shorts: ShortStrike[]; longs: LongStrike[] }, spx: number | null | undefined): MapSpread | null => {
  const strikes = [...strip.shorts.map((k) => k.strike), ...strip.longs.map((k) => k.strike)];
  if (strikes.length === 0) return null;
  return {
    id, name, kind, shorts: strip.shorts, longs: strip.longs,
    lo: Math.min(...strikes), hi: Math.max(...strikes), spx: typeof spx === "number" ? spx : null,
  };
};

/** The map of a placed book, against the line's SPX (`spxOfBook`). */
export function priceMapOf(placed: BookModel, line: SpxLine): PriceMap {
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
      const s = spreadOf(holding.id, holding.name, "held", strip, holding.spx);
      if (s) lane(holding.strike_date, holding.dte).spreads.push(s);
    }
  }
  for (const g of placed.watchlist) {
    for (const { entry } of g.items) {
      // a single contract is no spread: the map draws spreads
      const strip = stripOfEntry(entry);
      const s = strip ? spreadOf(entry.id, entryName(entry), "watched", strip, entry.spx) : null;
      if (s) lane(entry.strike_date, entry.dte).spreads.push(s);
    }
  }
  const out = [...lanes.values()].sort((a, b) => a.expiry.localeCompare(b.expiry));
  for (const l of out) {
    // on the expiry day there is no time left for a σ to measure: the service serves none, and
    // the reason is the calendar, not a missing IV
    if (l.dte <= 0) {
      l.bandWhy = "no ±1σ: expiry day";
      continue;
    }
    // each short strike with the SPX of its own batch: the band is centred where its σ was measured
    const priced = l.spreads.flatMap((s) => (s.spx === null ? [] : s.shorts.map((k) => ({ k, centre: s.spx! }))));
    if (priced.length === 0) {
      l.bandWhy = "no ±1σ without SPX";
      continue;
    }
    const shorts = priced.filter(({ k }) => k.one_sigma !== null && k.one_sigma !== undefined && k.points !== null);
    if (shorts.length === 0) {
      l.bandWhy = "no ±1σ: no IV served";
      continue;
    }
    // nearest by DISTANCE, either side: a strike already passed is as near as one not yet reached
    const { k, centre } = shorts.reduce((a, b) => (Math.abs(b.k.points!) < Math.abs(a.k.points!) ? b : a));
    l.band = { strike: k, centre, lo: centre - k.one_sigma!, hi: centre + k.one_sigma! };
  }
  return { ...line, lanes: out };
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
