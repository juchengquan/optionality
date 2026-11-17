/** The days a holding's history steps through, and what its IV panel says of each (#395): the ONE
 *  crosshair the burndown and the IV chart share, apart from their drawing (`Crosshair.tsx`,
 *  `History.tsx`).
 *
 *  - **The stops** are every day the service recorded, oldest first, then today's valuation while
 *    the holding is held and valued. A day with no row at all — the service down a whole New York
 *    day — is no stop: there is nothing recorded to say of it, and a pointer over its hatched column
 *    snaps to the nearest day that has one. A day a panel has no figure for IS a stop, and that
 *    panel says so: a day kept for its vol readings with no Cost to close (#380), a day with no IV.
 *  - **Every figure is the service's** (ADR 0005): each leg's IV as stored.
 *  - **No money**: IV is in %. Privacy has nothing to hide here.
 *
 *  Pure, so each is tested without a chart. */
import type { Holding, Sample } from "./shared/api";
import type { WrittenLeg } from "./shared/format";
import { writtenDate } from "./shared/times";
import { whyShort } from "./burndown";

/** How a day's point is marked: the close filled, a day that is not one hollow, a row nobody
 *  timed faint — the same in both panels. */
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
type Valued = Pick<Holding, "closed_on">
  & Partial<Pick<Holding, "dte" | "cost_to_close" | "valued_from">>;

/** Today's valuation's DTE, while it is held and valued live with a Cost to close: the burndown's
 *  figure, and the only one a panel draws for today (SPX's price was, until its chart went).
 *  Null for a closed trade, which has no "now"; and outside the session, where the valuation is the
 *  latest close restated (`valued_from: "close"`, #380) — a day the stops already have, which as
 *  "now" too was said twice (#399's review). */
export function nowDte(holding: Valued): number | null {
  if (holding.closed_on !== null || holding.valued_from === "close" || holding.dte === undefined || holding.dte < 0) {
    return null;
  }
  return holding.cost_to_close != null ? holding.dte : null;
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
const dayWords = writtenDate;

/** A stop's heading, as the burndown's tooltip says a day: "20261109 · 39 DTE", "valued now · 38 DTE". */
const stopDay = (stop: Stop) =>
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
