import type { Leg } from "./api";

/** Display rules mirrored from the server so both dashboards read identically. */

// %.4g served money and greeks alike, which rendered prices as a bare "1" and gamma as
// "-9.351e-05". Per-column precision keeps decimal points lined up under tabular-nums.
const PLACES: Record<string, number> = {
  delta: 4, gamma: 6, theta: 4, vega: 4, iv: 2, mid: 2, bid: 2, ask: 2,
};

export const DASH = "—";

export function fmt(value: number | null | undefined, column: string): string {
  if (value === null || value === undefined) return DASH;
  return value.toFixed(PLACES[column] ?? 4);
}

export function fmtText(value: string | null | undefined): string {
  return value ?? DASH;
}

/** +C8100 -C8150: the signs are what the signed-sum engine keys off, so a leg entered
 *  backwards is visible at a glance. */
export function legSummary(legs: readonly Leg[]): string {
  return legs
    .map((l) => `${l.sign > 0 ? "+" : "-"}${l.option_type[0]}${l.strike}`)
    .join(" ");
}

const FIELD_LABEL: Record<string, string> = {
  option_delta: "delta",
  option_gamma: "gamma",
  option_theta: "theta",
  option_vega: "vega",
  option_implied_volatility: "IV",
  mid_price: "mid",
};

export function alarmText(field: string, direction: string, threshold: number, compare: string): string {
  const sign = direction === "below" ? "≤" : "≥";
  const mode = compare === "signed" ? " signed" : "";
  return `${FIELD_LABEL[field] ?? field} ${sign} ${threshold}${mode}`;
}

/** Column key whose cell carries the bar. Mirrors the server's fallback chain. */
export const FIELD_COLUMN: Record<string, string> = {
  option_delta: "delta",
  option_gamma: "gamma",
  option_theta: "theta",
  option_vega: "vega",
  option_implied_volatility: "iv",
  mid_price: "mid",
};

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

/** Today's TRADING day, as the service counts it: the New York calendar date.
 *
 *  A mirror of `marketDate` in backend/src/domain/expiry.ts, four lines of Intl rather than an
 *  import, because this package may not reach into the backend's source tree — only its declared
 *  `exports`, which carry types and the input schemas and no runtime (check-boundaries, ADR 0014).
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
