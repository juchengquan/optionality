/** How much life an option has left. Ported from service/timefmt.py's days_to_expiry
 *  (ADR 0009, phase 3).
 *
 *  The rest of timefmt.py is display formatting and arrives with the routes that need it. This
 *  one figure is domain: it is what the dashboard's `dte` column shows, and it has no test in the
 *  Python at all.
 */
import { normalizeStrikeDate } from "./contract.ts";

/** moomoo delivers market timestamps as naive strings in US Eastern exchange time. */
export const MARKET_TZ = "America/New_York";

const MARKET_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: MARKET_TZ, year: "numeric", month: "2-digit", day: "2-digit",
});

/** Today's date where the option trades, as YYYY-MM-DD. */
export function marketDate(now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD, so this is the market calendar day without any arithmetic of
  // our own — the system's tz database decides, including across a daylight-saving change
  return MARKET_DAY.format(now);
}

/** Calendar days from the current MARKET date to expiry.
 *
 *  Market date, not DISPLAY_TZ: at 09:40 in Singapore it is still the previous afternoon in New
 *  York, and an option's remaining life is counted where it trades. This is why the figure can
 *  differ by one from the local calendar — and why it agrees with moomoo's own
 *  option_expiry_date_distance.
 */
export function daysToExpiry(strikeDate: string, now: Date = new Date()): number {
  // both ends as UTC midnights, so the subtraction is whole days and no daylight-saving shift
  // inside either zone can turn a day into 23 or 25 hours
  const utcMidnight = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
  // the Python reaches date.fromisoformat here too, so both spellings and only real days
  const expiry = utcMidnight(normalizeStrikeDate(strikeDate));
  return Math.round((expiry - utcMidnight(marketDate(now))) / 86_400_000);
}
