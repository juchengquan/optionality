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

const SAMPLE_CLOCK = new Intl.DateTimeFormat("en-US", {
  timeZone: MARKET_TZ, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});
/** 09:30 and 16:00 in New York, as milliseconds since its midnight. */
const SAMPLE_FROM = (9 * 60 + 30) * 60_000;
const SAMPLE_UNTIL = 16 * 60 * 60_000;

/** Whether a holding's daily sample may be taken at `now`: 09:30 to 16:00 in New York, both ends
 *  included, on EVERY calendar day.
 *
 *  The sample is the day's CLOSE, and a burndown labelled "close" has to mean it. Without this the
 *  day's row was rewritten whenever a figure moved until New York's midnight, and SPXW trades again
 *  from about 20:15 in Global Trading Hours, so the row that survived could be an overnight mark.
 *  Writing only inside these hours makes the day's row the last sweep at or before 16:00, and
 *  nothing after it can move the row. 16:00 itself is in: a sweep landing exactly on the close is
 *  the best observation of it there is. 09:30 is the floor so a service that slept through a whole
 *  session writes no row for it, rather than one made of the morning's overnight marks.
 *
 *  Every day, weekends included, and that is not an oversight: `volAttribution` chains samples
 *  EXACTLY one calendar day apart (vol.ts), so a row skipped on a Saturday breaks the vol figure
 *  across every weekend. Nothing trades in these hours on a weekend, so a Saturday's row is the
 *  Friday close carried forward — which is what weekend rows have always held. A holiday is the
 *  same case and needs no calendar, and a half-day (the Friday after Thanksgiving, Christmas Eve:
 *  13:00, options 13:15) is static from its close to 16:00, so its row is its close too.
 */
export function inSampleHours(now: Date = new Date()): boolean {
  const part = Object.fromEntries(SAMPLE_CLOCK.formatToParts(now).map((p) => [p.type, p.value]));
  // every zone New York has used is a whole number of hours from UTC, so the milliseconds are the
  // same in both and can be read straight off the instant
  const sinceMidnight = ((Number(part.hour) * 60 + Number(part.minute)) * 60 + Number(part.second))
    * 1000 + now.getUTCMilliseconds();
  return sinceMidnight >= SAMPLE_FROM && sinceMidnight <= SAMPLE_UNTIL;
}

/** Whether the sweep at `now` writes a holding's daily sample, given whether it has any yet.
 *
 *  Inside the sample hours, always (`inSampleHours`). Outside them, only for a holding with NO
 *  sample at all: its first row is taken at the next sweep whatever the hour, dated the market day
 *  as every row is, and once it exists the hours rule holds for it too, so no later overnight mark
 *  rewrites it.
 *
 *  The exception exists because of when trades are RECORDED. The owner enters a trade in the
 *  Singapore morning, which is New York's evening, after the close of the day it was put on. Under
 *  the hours alone, that holding's first row would be the next day's, never its Opened day — and
 *  `volAttribution` refuses any chain that does not start on Opened, so the Vol part would stay
 *  blank for every holding entered that way. The price is that the opening day's point can be a
 *  post-close or overnight mark rather than the close; a baseline from that evening is still that
 *  day's, which the chain needs, where no baseline at all is no answer.
 */
export function takesSample(now: Date, sampled: boolean): boolean {
  return inSampleHours(now) || !sampled;
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
