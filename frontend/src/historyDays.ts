/** The days a holding's history steps through, and what its IV and SPX panels say of each (#395):
 *  the ONE crosshair the burndown, the IV chart and "SPX against the strikes" share, apart from
 *  their drawing (`Crosshair.tsx`, `History.tsx`, `SpxPath.tsx`).
 *
 *  - **The stops** are every day the service recorded, oldest first, then today's valuation while
 *    the holding is held and valued. A day with no row at all — the service down a whole New York
 *    day — is no stop: there is nothing recorded to say of it, and a pointer over its hatched column
 *    snaps to the nearest day that has one. A day a panel has no figure for IS a stop, and that
 *    panel says so: a day kept for its vol readings with no Cost to close (#380), a day stored
 *    without SPX's price, a day with no IV.
 *  - **Every figure is the service's** (ADR 0005): each leg's IV as stored, SPX as the sweep derived
 *    it (ADR 0024), and each short strike's distance in points and σ as the service placed it
 *    against that day's SPX (`short_strikes`, `strikeDistances`). Nothing here measures a distance;
 *    where the service could not, the reason is said instead.
 *  - **No money**: IV is in %, SPX and strikes in index points. Privacy has nothing to hide here.
 *
 *  Pure, so each is tested without a chart. */
import { spx as spxText } from "./shared/numbers";
import type { Holding, Sample } from "./shared/api";
import type { WrittenLeg } from "./shared/format";
import { writtenDate } from "./shared/times";
import { whyShort } from "./burndown";
import { distanceWords } from "./strip";

/** How a day's point is marked: the close filled, a day that is not one hollow, a row nobody
 *  timed faint — the same in all three panels. */
export const MARK: Record<Sample["timing"], "close" | "off-close" | "unrecorded"> = {
  close: "close", "after-close": "off-close", "before-open": "off-close", unrecorded: "unrecorded",
};

/** One stop of the shared crosshair: a recorded day, or today's valuation (`on` null). */
export interface Stop {
  on: string | null;
  dte: number;
  sample: Sample | null;
}

/** What the panels read of a holding for today's valuation: only while it is held and valued. */
export type Valued = Pick<Holding, "closed_on">
  & Partial<Pick<Holding, "dte" | "cost_to_close" | "spx" | "short_strikes" | "valued_from">>;

/** Today's valuation's DTE, while it is held and valued live with a Cost to close or SPX's price.
 *  Null for a closed trade, which has no "now"; and outside the session, where the valuation is the
 *  latest close restated (`valued_from: "close"`, #380) — a day the stops already have, which as
 *  "now" too was said twice (#399's review). */
export function nowDte(holding: Valued): number | null {
  if (holding.closed_on !== null || holding.valued_from === "close" || holding.dte === undefined || holding.dte < 0) {
    return null;
  }
  return holding.cost_to_close != null || typeof holding.spx === "number" ? holding.dte : null;
}

/** Every recorded day, then today's valuation. */
export function stopsOf(samples: Sample[], now: number | null): Stop[] {
  return [
    ...samples.map((s) => ({ on: s.observed_on, dte: s.dte, sample: s })),
    ...(now === null ? [] : [{ on: null, dte: now, sample: null }]),
  ];
}

/** "20261103": a market date as every date is written (`times.writtenDate`), by string, so no zone
 *  can move it — the way the service writes the days in its reasons. */
export const dayWords = writtenDate;

/** A stop's heading, as the burndown's tooltip says a day: "20261109 · 39 DTE", "valued now · 38 DTE". */
export const stopDay = (stop: Stop) =>
  stop.on === null ? `valued now · ${stop.dte} DTE` : `${dayWords(stop.on)} · ${stop.dte} DTE`;

/** A leg as the IV panel names it: its contract code, how it is written, and whether it is short. */
export interface IvLeg {
  code: string;
  leg: WrittenLeg;
}

/** What the IV panel says of a stop: its day, then each leg's IV that day or "no IV", or one line
 *  where the stop has none at all; and why a day is not the close. */
export function ivLines(stop: Stop, legs: IvLeg[]) {
  const why = stop.sample === null ? null : whyShort(stop.sample);
  const day = stopDay(stop);
  if (stop.sample === null) return { day, legs: [], none: "no IV in the history for today's valuation", why };
  const map = stop.sample.legs_iv;
  if (map === null) return { day, legs: [], none: "no IV recorded this day", why };
  return {
    day, none: null, why,
    legs: legs.map(({ code, leg }) => {
      const v = map[code];
      return { leg, words: typeof v === "number" ? `${v.toFixed(2)}%` : "no IV" };
    }),
  };
}

/** The IV panel's stop said in full, by its status line. */
export function ivWords(stop: Stop, legs: IvLeg[], name: (leg: IvLeg["leg"]) => string): string {
  const t = ivLines(stop, legs);
  const said = t.none ?? t.legs.map((l) => `${name(l.leg)} ${l.words}`).join(", ");
  return `${t.day}: ${said}${t.why === null ? "" : ` — ${t.why}`}`;
}

type Placed = NonNullable<Valued["short_strikes"]>[number];

/** One short strike's distance that day, or why there is none: points and σ as the service placed
 *  them; σ alone missing for want of the leg's IV, or on the expiry day, where no time is left. */
export function strikeWords(k: Placed, dte: number, now: boolean): string {
  if (k.points === null) return `— no SPX ${now ? "now" : "that day"}`;
  if (k.sigma !== null) return distanceWords(k);
  const why = dte <= 0 ? "no σ on the expiry day" : `no σ: no IV ${now ? "now" : "that day"}`;
  return `${distanceWords(k)} · ${why}`;
}

/** What the SPX panel says of a stop: its day, SPX that day (or why not), and each short strike's
 *  distance from it. Today's valuation is said from the valuation's own figures. */
export function spxLines(stop: Stop, holding: Valued) {
  const now = stop.sample === null;
  const spx = now ? (typeof holding.spx === "number" ? holding.spx : null) : stop.sample!.spx;
  const strikes = (now ? holding.short_strikes : stop.sample!.short_strikes) ?? [];
  return {
    day: stopDay(stop),
    spx: spx !== null ? `SPX ${now ? "now " : ""}${spxText(spx)}`
      : now ? "no SPX now: the valuation could not give it"
        : "no SPX this day: stored before it was recorded, or its batch could not give it",
    value: spx,
    strikes: strikes.map((k) => ({ k, words: strikeWords(k, stop.dte, now) })),
    why: now ? null : whyShort(stop.sample!),
  };
}

/** The SPX panel's stop said in full, by its status line. */
export function spxWords(stop: Stop, holding: Valued, name: (k: Placed) => string): string {
  const t = spxLines(stop, holding);
  const strikes = t.strikes.map(({ k, words }) => ` · ${name(k)} ${words}`).join("");
  return `${t.day}: ${t.spx}${strikes}${t.why === null ? "" : ` — ${t.why}`}`;
}
