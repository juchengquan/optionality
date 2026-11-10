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
/** 09:30 and 16:15 in New York, as milliseconds since its midnight. */
const SAMPLE_FROM = (9 * 60 + 30) * 60_000;
const SAMPLE_UNTIL = (16 * 60 + 15) * 60_000;

/** Whether `now` is inside the sample hours: 09:30 to 16:15 in New York, both ends included, on
 *  EVERY calendar day.
 *
 *  The sample is the day's CLOSE, and a burndown labelled "close" has to mean it. Without this the
 *  day's row was rewritten whenever a figure moved until New York's midnight, and SPXW trades again
 *  from about 20:15 in Global Trading Hours, so the row that survived could be an overnight mark.
 *  Inside these hours the row is written and rewritten freely, so it settles on the last sweep at
 *  or before 16:15 — the OPTIONS' close, a quarter hour after the stocks', and the one their own
 *  marks settle on; a half-day closes them at 13:15 by the same rule. 16:15 itself is in: a sweep
 *  landing exactly on the close is the best observation of it there is. Outside the hours a row is
 *  only ever filled or completed, never changed (`takesSample`).
 *
 *  Every day, weekends included, and that is not an oversight: `volAttribution` chains samples
 *  EXACTLY one calendar day apart (vol.ts), so a row skipped on a Saturday breaks the vol figure
 *  across every weekend. Nothing trades in these hours on a weekend, so a Saturday's row is the
 *  Friday close carried forward — which is what weekend rows have always held. A holiday is the
 *  same case and needs no calendar, and a half-day (the Friday after Thanksgiving, Christmas Eve:
 *  13:00, options 13:15) is static from its close to 16:15, so its row is its close too.
 */
export function inSampleHours(now: Date = new Date()): boolean {
  const t = sinceNewYorkMidnight(now);
  return t >= SAMPLE_FROM && t <= SAMPLE_UNTIL;
}

/** Milliseconds since midnight in New York at `now`. */
function sinceNewYorkMidnight(now: Date): number {
  const part = Object.fromEntries(SAMPLE_CLOCK.formatToParts(now).map((p) => [p.type, p.value]));
  // every zone New York has used is a whole number of hours from UTC, so the milliseconds are the
  // same in both and can be read straight off the instant
  return ((Number(part.hour) * 60 + Number(part.minute)) * 60 + Number(part.second)) * 1000
    + now.getUTCMilliseconds();
}

/** The two vol readings of a day's row, as stored: JSON text, or null where the feed withheld one. */
export interface SampleReadings {
  legs_iv: string | null;
  legs_vega: string | null;
}

/** The day's row as stored, as far as `takesSample` reads it. */
export interface StoredSample extends SampleReadings {
  /** UTC, as the database spells it ("2026-11-09 16:00:00.000000"); null on rows written before
   *  migration 0009, which are taken as settled */
  observed_at: string | null;
}

/** What the sweep does with the day's row: leave it, write it only if its figures moved, or write
 *  it regardless — the last so a provisional row is restamped even when nothing moved. */
export type SampleWrite = "no" | "if-changed" | "yes";

/** What the sweep at `now` does with the day's row, given the row already stored for that market
 *  day (null if none) and the two vol readings this sweep took.
 *
 *  A stored row is PROVISIONAL when it was observed before its own day's 09:30 open — a fill taken
 *  from overnight marks — and SETTLED once observed inside the hours or after the close. A row from
 *  before `observed_at` existed counts as settled: it was written under the old rule, which never
 *  wrote one in the small hours on purpose, and there is nothing to say otherwise.
 *
 *  - **no row yet**: written, whatever the hour. Two things leave a day without one. The owner
 *    records trades in the Singapore morning, New York's evening after the close of the day they
 *    went on, so the holding's first row would otherwise be the next day's and never its Opened
 *    day. And a session can be missed whole — a reboot waiting at the FileVault login, OpenD waiting
 *    for one. `volAttribution` needs a row on Opened and on every day after, so either hole blanked
 *    the holding's Vol part for good.
 *  - **before the open**: that fill and nothing else. A row that stands is not touched.
 *  - **inside the hours (09:30–16:15)**: written whenever the figures moved, as always — and a
 *    provisional row regardless, so it is restamped with an in-hours instant. That is a WEEKEND's
 *    row: filled just after midnight, and never rewritten since nothing moves, it would otherwise
 *    keep its 00:05 stamp and read for ever as an overnight mark.
 *  - **after the close (16:15 to midnight)**: a provisional row is replaced — the first sweep after
 *    midnight filled the day, the session was then missed, and the evening's reading is the better
 *    one for that day. A settled row missing its IV or vega is completed by a sweep that has BOTH
 *    (the row is written whole, so a sweep missing the other map would trade one hole for another).
 *    A complete settled row is never changed: a close stays the close.
 *
 *  So some points are not closes, and every write stamps `observed_at` so a chart can say which.
 */
export function takesSample(
  now: Date, stored: StoredSample | null, observed: SampleReadings,
): SampleWrite {
  if (stored === null) return "yes";
  const provisional = stored.observed_at !== null && sinceNewYorkMidnight(
    new Date(`${stored.observed_at.slice(0, 10)}T${stored.observed_at.slice(11, 23)}Z`),
  ) < SAMPLE_FROM;
  const t = sinceNewYorkMidnight(now);
  if (t < SAMPLE_FROM) return "no";
  if (t <= SAMPLE_UNTIL) return provisional ? "yes" : "if-changed";
  if (provisional) return "yes";
  const incomplete = stored.legs_iv === null || stored.legs_vega === null;
  return incomplete && observed.legs_iv !== null && observed.legs_vega !== null ? "yes" : "no";
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
