/** The payoff chart's arithmetic, with nothing drawn (#396): the P&L at expiry at any SPX level, the
 *  window the chart shows, where a pointer or a key puts its crosshair, how a P&L is said, and how
 *  labels that would overlap are joined. `Payoff.tsx` draws from these.
 *
 *  NO PAYOFF MATHS OF ITS OWN. The figures are the service's (`payoffAtExpiry`, #291, served by
 *  `/positions/{id}/payoff` and `POST /positions/payoff`), every leg's quantity in them (#351). The
 *  curve is piecewise linear with its corners at the strikes, so the P&L at each strike and the
 *  slope beyond the outer two are all of it: `pnlAt` joins those corners, and a straight line
 *  between them is the curve rather than an approximation of it. Held to the domain's golden cases
 *  (`NextPayoffModel.test.ts`).
 */
import { money, points, signedPoints, spx } from "./shared/numbers";
import type { Payoff } from "./shared/api";

/** The P&L at expiry with SPX at `s`, joining the served corners: straight between strikes, and on
 *  at the served slope beyond the outer two. In the served payoff's points, across its contracts. */
export function pnlAt(p: Payoff, s: number): number {
  const at = p.at_strikes;
  if (at.length === 0) return p.max_profit ?? 0;
  const first = at[0]!, last = at[at.length - 1]!;
  if (s <= first.spx) return first.pnl + p.slope_below * (s - first.spx);
  if (s >= last.spx) return last.pnl + p.slope_above * (s - last.spx);
  const i = at.findIndex((a) => a.spx >= s);
  const [a, b] = [at[i - 1]!, at[i]!];
  return a.pnl + ((b.pnl - a.pnl) * (s - a.spx)) / (b.spx - a.spx);
}

/** An SPX level — a breakeven, the crosshair's price — to the cent, as SPX is written everywhere
 *  (`shared/numbers.ts`: `spx`). */
export const level = (x: number) => spx(x);

/** The SPX window drawn, and the step the crosshair moves by. */
export interface PriceWindow {
  d0: number;
  d1: number;
  step: number;
}

const STEPS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000];
/** At most this many steps across the window: fine enough to land near any price, few enough that
 *  the arrow keys cross it in a few seconds held down. */
const MOST_STOPS = 200;

/** Every strike, every breakeven and SPX, with room either side to show the slopes; its ends on the
 *  step, and never below an index of zero. */
export function payoffWindow(p: Payoff, spx: number | null): PriceWindow {
  const xs = [...p.at_strikes.map((a) => a.spx), ...p.breakevens, ...(spx === null ? [] : [spx])];
  const lo = xs.length ? Math.min(...xs) : 0, hi = xs.length ? Math.max(...xs) : 0;
  const pad = Math.max((hi - lo) * 0.15, 10);
  const [a, b] = [Math.max(0, lo - pad), hi + pad];
  const step = STEPS.find((s) => (b - a) / s <= MOST_STOPS) ?? STEPS[STEPS.length - 1]!;
  return { d0: Math.floor(a / step) * step, d1: Math.ceil(b / step) * step, step };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** The price a pointer at `raw` means: a marked price — a strike, a breakeven, SPX — within `reach`
 *  of it, so a breakeven can be landed on exactly; otherwise the nearest step. */
export function snapPrice(raw: number, marks: number[], w: PriceWindow, reach: number): number {
  let best: number | null = null;
  for (const m of marks) {
    if (Math.abs(m - raw) <= reach && (best === null || Math.abs(m - raw) < Math.abs(best - raw))) best = m;
  }
  if (best !== null) return clamp(best, w.d0, w.d1);
  return clamp(Math.round(raw / w.step) * w.step, w.d0, w.d1);
}

/** Every price the keys stop at: the steps across the window, and every marked price inside it. */
export function priceStops(w: PriceWindow, marks: number[]): number[] {
  const out = new Set<number>();
  for (let s = w.d0; s <= w.d1 + 1e-9; s += w.step) out.add(Number(s.toFixed(6)));
  for (const m of marks) if (m >= w.d0 && m <= w.d1) out.add(m);
  return [...out].sort((a, b) => a - b);
}

/** The price a key moves the crosshair to: the arrows a stop at a time — starting from SPX where
 *  there is a price for it, else the window's middle — Home and End to the ends, Escape lets go
 *  ("clear"); undefined for any other key, or for Escape with nothing chosen, which is then the
 *  page's: the desk's inspector closes on an Escape nobody took. */
export function stepPrice(key: string, at: number | null, stops: number[], spx: number | null): number | "clear" | undefined {
  if (stops.length === 0) return undefined;
  const first = stops[0]!, last = stops[stops.length - 1]!;
  const nearest = (v: number) => stops.reduce((b, s) => (Math.abs(s - v) < Math.abs(b - v) ? s : b), first);
  switch (key) {
    case "ArrowRight":
      if (at === null) return nearest(spx ?? (first + last) / 2);
      return stops.find((s) => s > at) ?? last;
    case "ArrowLeft":
      if (at === null) return nearest(spx ?? (first + last) / 2);
      return [...stops].reverse().find((s) => s < at) ?? first;
    case "Home": return first;
    case "End": return last;
    case "Escape": return at === null ? undefined : "clear";
    default: return undefined;
  }
}

/** How a P&L is said. The served payoff is in points across `contracts`; money is those points at
 *  the contract size a holding's valuation served, `size`, and null where there is none. */
export interface PayoffUnit {
  contracts: number;
  size: number | null;
  /** privacy: no money. The points stay, PER CONTRACT, which say no count — across the contracts
   *  held, points times 100 would be the very dollars privacy hides */
  hidden: boolean;
  /** a holding's points are said "per contract"; one spread nobody holds is one contract anyway */
  perContract: boolean;
}

function pointWords(pnl: number, unit: PayoffUnit, per: boolean): string {
  const pts = pnl / unit.contracts;
  const words = Math.abs(pts) < 0.005 ? "0.00" : signedPoints(pts);
  return `${words} pts${per && unit.perContract ? " per contract" : ""}`;
}

function moneyWords(pnl: number, unit: PayoffUnit): string | null {
  if (unit.size === null) return null;
  return unit.hidden ? "$•••" : money(pnl * unit.size);
}

/** A P&L in full: points per contract, then the money across the contracts held where there is a
 *  contract size — masked under privacy. */
export function pnlWords(pnl: number, unit: PayoffUnit): string {
  const dollars = moneyWords(pnl, unit);
  return dollars === null ? pointWords(pnl, unit, true) : `${pointWords(pnl, unit, true)} · ${dollars}`;
}



/** What the crosshair at `price` reads out: the price, how far it is from SPX's derived price where
 *  there is one (never a Reference's, ADR 0024), and the P&L at expiry there. */
export function readout(price: number, p: Payoff, unit: PayoffUnit, spx: number | null) {
  const d = spx === null ? null : price - spx;
  const away = d === null ? null
    : Math.abs(d) < 0.005 ? "at SPX now" : `${points(Math.abs(d))} ${d > 0 ? "above" : "below"} SPX now`;
  const pnl = pnlWords(pnlAt(p, price), unit);
  return {
    price: `SPX ${level(price)}`, away, pnl,
    words: `at expiry with SPX at ${level(price)}${away === null ? "" : `, ${away}`}: ${pnl}`,
  };
}

/** Labels along a line, each at `x` and `w` wide, joined where they would overlap (less than `gap`
 *  apart) into one centred on its members — its members' widths and a `gap` between each — and
 *  each kept inside `lo`..`hi`. No label is made wider than that: an item that would join one
 *  already as wide as the drawing goes onto the next row instead, so six legs a few points apart
 *  are named on two lines rather than cut at the edge. Each label says its `row`, 0 the first. */
export function labelRows<T extends { x: number; w: number }>(items: T[], gap: number, lo: number, hi: number) {
  type Placed = { items: T[]; x: number; w: number; row: number };
  const room = hi - lo;
  const place = (members: T[], row: number): Placed => {
    const w = members.reduce((s, m) => s + m.w, 0) + gap * (members.length - 1);
    const mid = members.reduce((s, m) => s + m.x, 0) / members.length;
    return { items: members, w, row, x: clamp(mid, lo + w / 2, Math.max(lo + w / 2, hi - w / 2)) };
  };
  const overlap = (a: Placed, b: Placed) => a.x + a.w / 2 + gap > b.x - b.w / 2;
  const rows: Placed[][] = [];
  for (const item of [...items].sort((a, b) => a.x - b.x)) {
    for (let r = 0; ; r++) {
      const row = (rows[r] ??= []);
      const next = place([item], r);
      const last = row[row.length - 1];
      if (last && overlap(last, next)) {
        const joined = place([...last.items, item], r);
        if (joined.w > room) continue;
        row.splice(row.length - 1, 1, joined);
      } else row.push(next);
      // a joined label may now reach the one before it, which it then joins too, room allowing
      while (row.length > 1 && overlap(row[row.length - 2]!, row[row.length - 1]!)) {
        const both = place([...row[row.length - 2]!.items, ...row[row.length - 1]!.items], r);
        if (both.w > room) break;
        row.splice(row.length - 2, 2, both);
      }
      break;
    }
  }
  return rows.flat();
}
