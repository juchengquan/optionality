import type { Leg } from "./api";

/** Display rules the page shares between its arrangements. */

export const DASH = "—";

/** A leg as the page writes it: its side (`short` unset for the one contract a rule watches,
 *  which is no position and has no side), its type, its strike and its quantity, absent for one. */
export interface WrittenLeg { short?: boolean; option_type: string; strike: number; qty?: number }

/** How a place writes a leg: `signs` as the book writes it, `-2C8150`; `minus` with a true minus,
 *  as the charts write it, `−2C8150`; `words` as the inspector writes it, `short 2× CALL 8150`; and
 *  `name`, its contract alone, `C8150`, as the strike strip and the SPX chart name a strike. */
export type LegForm = "signs" | "minus" | "words" | "name";

/** +C8100 -C8150: the signs are what the signed-sum engine keys off, so a leg entered backwards is
 *  visible at a glance. A quantity sits between the sign and the contract, `-2C8150`, and a
 *  quantity of one is not written (#351). Every place that writes a leg draws it through
 *  `shared/Legs.tsx`, from these parts.
 *
 *  A leg's text in three parts — before its type, its type, after it — so the drawing can mark the
 *  type for its colour (#391) and still write exactly these characters. */
export function legParts(l: WrittenLeg, form: LegForm): [string, string, string] {
  const many = l.qty !== undefined && l.qty !== 1;
  if (form === "words") {
    return [`${l.short === undefined ? "" : l.short ? "short " : "long "}${many ? `${l.qty}× ` : ""}`, l.option_type, ` ${l.strike}`];
  }
  if (form === "name") return ["", l.option_type[0]!, String(l.strike)];
  const sign = l.short === undefined ? "" : l.short ? (form === "minus" ? "−" : "-") : "+";
  return [`${sign}${many ? l.qty : ""}`, l.option_type[0]!, String(l.strike)];
}

export const legText = (l: WrittenLeg, form: LegForm): string => legParts(l, form).join("");

/** A signed leg (`sign`, a combo's) and a held one (`side`, a holding's) as a written leg. */
export const signedLeg = (l: Leg): WrittenLeg =>
  ({ short: l.sign < 0, option_type: l.option_type, strike: l.strike, qty: l.qty });
export const heldLeg = (l: { side: string; option_type: string; strike: number; qty?: number }): WrittenLeg =>
  ({ short: l.side === "short", option_type: l.option_type, strike: l.strike, qty: l.qty });

/** "SPXW 261016 8050.00C" → "261016 8050C".
 *
 *  Every contract this service can create goes through build_spx_code, which hardcodes the
 *  SPXW symbol and builds the strike with int() — so the prefix and the decimals are
 *  identical on every row and carry no information at all. Eight of twenty characters, in
 *  the widest column on the page.
 *
 *  It matches strictly and returns anything else untouched: a name from a symbol this does
 *  not know about must not be quietly shortened into a different-looking contract. If SPX
 *  monthlies or fractional strikes ever appear, this stops applying rather than lying.
 */
const SPXW_NAME = /^SPXW (\d{6}) (\d+)\.00([CP])$/;

export function shortContract(name: string): string {
  const m = SPXW_NAME.exec(name);
  return m ? `${m[1]} ${m[2]}${m[3]}` : name;
}

/** "2026-10-16" → "261016", the form contract names use since they lost their SPXW. */
export function shortDate(iso: string): string {
  const m = /^(\d{2})(\d{2})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[2]}${m[3]}${m[4]}` : iso;
}

/** "2026-10-31 04:16:24+08:00" → "2026-10-31 04:16:24".
 *
 *  The service renders every timestamp it sends in DISPLAY_TZ, so the offset is identical on every
 *  row of every table and carries no information at all — the same argument `shortContract` makes
 *  about the SPXW prefix, and in the same place it matters: `last trade` is the widest column on
 *  the single-leg table, measured at 245px against the live book, and six of its twenty-five
 *  characters are this.
 *
 *  It stops at the offset. The DATE stays, because an SPX strike far from the money can go days
 *  without a print — the live book's last trades were yesterday's — and a bare `04:16:24` reads as
 *  this morning, which is a claim about liquidity rather than a shorter way of saying the same
 *  thing.
 *
 *  Strict, and returns anything else untouched: "x" is what every fixture in this repo passes for
 *  a timestamp, and a `Z` or a fractional second would mean the shape changed, which is a reason
 *  to show it whole rather than to guess at it.
 */
const ZONED = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})[+-]\d{2}:\d{2}$/;

export function shortStamp(served: string): string {
  const m = ZONED.exec(served);
  return m ? m[1]! : served;
}

/** Today's TRADING day, as the service counts it: the New York calendar date.
 *
 *  A mirror of `marketDate` in typescript/src/domain/expiry.ts, four lines of Intl rather than an
 *  import, because this package may import only the backend, and only its declared `exports`,
 *  which carry types and the input schemas and no runtime (check-boundaries, ADR 0014 and 0021).
 *  The domain copy is canonical; this one exists so the browser can NAME the day without a round
 *  trip, and `en-CA` is what makes it YYYY-MM-DD with no arithmetic of our own.
 *
 *  It matters because `position_samples.observed_on` is keyed to this calendar and a holding's
 *  `opened_at` has to agree with its first sample or the vol attribution is null. Singapore runs
 *  12 hours ahead of New York, so for the whole local morning — which is when a trade is recorded,
 *  the US session having closed at 04:00 — the local date is a day ahead of this one.
 */
const MARKET_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
});

export function marketDay(now: Date = new Date()): string {
  return MARKET_DAY.format(now);
}

/** "21:04:37": the wall clock the service wrote on something it served (`fetched_at`, rendered in
 *  DISPLAY_TZ as `2026-11-12 21:04:37+08:00`), read as written — the zone the owner reads every
 *  time the service states, and never the device's — or null where the stamp says no time. A
 *  holding's valuation and a Reference's reading both carry one (#354, #371). */
export function servedClock(served: string | null | undefined): string | null {
  const m = /^\d{4}-\d{2}-\d{2}[ T](\d{2}:\d{2}:\d{2})/.exec(served ?? "");
  return m ? m[1]! : null;
}

/** A wall clock as `HH:MM:SS`, built from the fields rather than formatted by locale.
 *
 *  `toLocaleTimeString()` with no arguments renders in whatever language the DEVICE is set to:
 *  the owner's browser is Chinese and the page read `screen updated 晚上9:39:53` beside the
 *  service's own `2026-10-21 21:47:23+08:00`, and on an en-US machine the same call gives
 *  `9:39:53 PM` — wrong in the same way and harder to spot. Passing a locale would only move the
 *  decision; this has none to make, pads every field so the line cannot jitter as the seconds
 *  tick, and matches how the service writes a time.
 *
 *  The zone is the DEVICE's, which is what "when this screen last fetched" means.
 */
export function clockTime(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

/** The same instant in New York, as `09:47:23 EDT`, or null where there is no instant to show.
 *
 *  The service renders its own timestamps in DISPLAY_TZ and sends them as strings
 *  (`2026-10-21 21:47:23+08:00`), which is the zone the owner reads — and says nothing about where
 *  in the TRADING day the figures are. That matters twice over now the dashboard saves pictures:
 *  the person receiving one does not know this dashboard's zone at all.
 *
 *  The abbreviation comes from the tz database (`timeZoneName: "short"`), never from an offset of
 *  ours: it is EDT in October and EST in January, and a second clock with no zone on it would be
 *  worse than no second clock. A space instead of `T` is ISO-adjacent rather than ISO, and V8
 *  parses it — the swap makes that explicit rather than relying on it.
 */
/* `en-US`, not `en-GB`: both put the clock in the same place, and only the American locale
   spells the zone as the market does — en-GB renders `GMT-4` where this needs `EDT`. `hourCycle`
   rather than `hour12: false`, which is the spelling that cannot render midnight as 24:00. */
const MARKET_CLOCK = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", second: "2-digit",
  hourCycle: "h23", timeZoneName: "short",
});

export function marketClock(served: string | null | undefined): string | null {
  if (!served) return null;
  const at = new Date(served.replace(" ", "T"));
  // "x" is what every fixture in this repo passes, and a service that has never swept sends
  // nothing at all: "Invalid Date" beside a real figure reads as a fault in the figure
  if (Number.isNaN(at.getTime())) return null;
  return MARKET_CLOCK.format(at);
}
