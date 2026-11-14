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

const WEEKDAY = new Intl.DateTimeFormat("en-US", { timeZone: MARKET_TZ, weekday: "short" });

/** Whether New York's SESSION is open at `now`: 09:30:00 to 16:15:00 there, both ends included,
 *  Monday to Friday. Holidays are not detected (#380, F7), as the page's own `inSession` does not
 *  detect them: on one the service values the book live and finds no price, which is a dash.
 *
 *  The same edges as `inSampleHours`, and a different question: the daily sample is written on EVERY
 *  calendar day, because the vol chain steps one day at a time (ADR 0011), while the session is when
 *  the market is open to be priced. Outside it the service values a holding from its latest close
 *  rather than from the Provider's out-of-hours quote (`valuesFromClose`, #380) — moomoo quotes every
 *  option bid 0 / ask 0 then, which is no price at all.
 *
 *  The page asks the same question of its own clock (`frontend/src/session.ts`), which it cannot
 *  import from here; the two are held to the same edges by their own tests.
 */
export function inSession(now: Date = new Date()): boolean {
  const weekday = WEEKDAY.format(now);
  if (weekday === "Sat" || weekday === "Sun") return false;
  return inSampleHours(now);
}

/** Milliseconds since midnight in New York at `now`. */
function sinceNewYorkMidnight(now: Date): number {
  const part = Object.fromEntries(SAMPLE_CLOCK.formatToParts(now).map((p) => [p.type, p.value]));
  // every zone New York has used is a whole number of hours from UTC, so the milliseconds are the
  // same in both and can be read straight off the instant
  return ((Number(part.hour) * 60 + Number(part.minute)) * 60 + Number(part.second)) * 1000
    + now.getUTCMilliseconds();
}

/** What a day's row reads, as stored: the two vol readings as JSON text, or null where the feed
 *  withheld one, and the Cost to close, or null where no leg had a two-sided quote to price it
 *  (#380) — out of hours, when moomoo quotes every option 0/0 and the vol is still served. */
export interface SampleReadings {
  legs_iv: string | null;
  legs_vega: string | null;
  cost_to_close: number | null;
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
 *    one for that day — but a COMPLETE provisional row only by complete readings: traded for one
 *    without its IV or vega, the day would lose its Vol for good unless a later sweep before
 *    midnight had both. An incomplete provisional row loses nothing by being replaced. A settled row missing its IV or vega is completed by a sweep that has BOTH
 *    (the row is written whole, so a sweep missing the other map would trade one hole for another).
 *    A complete settled row is never changed: a close stays the close.
 *
 *  So some points are not closes, and every write stamps `observed_at` so a chart can say which.
 *
 *  **An empty Cost to close never replaces a stored one** (#380), whatever the hour. A sweep with no
 *  two-sided quote for a leg has no cost — moomoo's 0/0 out of hours — but still reads the vol, so
 *  a day with no row is filled with an empty cost and its readings (the chain needs the day), while
 *  a row that has a cost keeps it. A row without one counts as incomplete and is given one by the
 *  first whole reading after the close; a costless reading is never complete.
 */
export function takesSample(
  now: Date, stored: StoredSample | null, observed: SampleReadings,
): SampleWrite {
  if (stored === null) return "yes";
  // an empty cost never replaces a stored one, at any hour (#380): out of hours moomoo quotes every
  // option 0/0, and the open quotes one leg before another, so a reading with no cost says nothing
  // about the day's price — it would blank the close, or a fill the session priced
  if (stored.cost_to_close !== null && observed.cost_to_close === null) return "no";
  const provisional = stored.observed_at !== null && sinceNewYorkMidnight(
    new Date(`${stored.observed_at.slice(0, 10)}T${stored.observed_at.slice(11, 23)}Z`),
  ) < SAMPLE_FROM;
  const t = sinceNewYorkMidnight(now);
  if (t < SAMPLE_FROM) return "no";
  if (t <= SAMPLE_UNTIL) return provisional ? "yes" : "if-changed";
  // a row without a cost is incomplete as one without its IV or vega is, and only a reading with
  // all three is complete: a costless reading must not rewrite a costless row on every sweep
  const incomplete = stored.legs_iv === null || stored.legs_vega === null || stored.cost_to_close === null;
  const complete = observed.legs_iv !== null && observed.legs_vega !== null && observed.cost_to_close !== null;
  if (provisional) return incomplete || complete ? "yes" : "no";
  return incomplete && complete ? "yes" : "no";
}

/** When a stored row was observed, against its day's close: what a chart of the samples marks.
 *
 *  - **close**: inside 09:30–16:15 New York, where the row is written freely and settles on the
 *    last sweep by the options' close — or, on a weekend or a holiday, carries the last close
 *    forward (`inSampleHours`).
 *  - **before-open**: a fill from overnight marks, taken before 09:30 and never replaced, because
 *    no sweep ran in that day's hours or that evening.
 *  - **after-close**: taken after 16:15 — an opening day recorded in New York's evening, a missed
 *    session filled that night, or a row completed then.
 *  - **unrecorded**: a row written before `observed_at` existed (migration 0009). Nothing says
 *    when it was observed, so nothing here claims it was a close or that it was not.
 *
 *  By the hour alone, as `takesSample`'s provisional check is: the sweep keys every row to the New
 *  York date it was observed on, so the instant's own day is the row's. A stamp in any spelling but
 *  the stored one (`storedInstant`) is `unrecorded` too: a corrupt row costs its own figure, and
 *  never the request that reads it (#295).
 */
/** UTC as the database spells it — "2026-11-09 21:00:00.000000", the fraction optional and any
 *  length — as an instant to the millisecond, or null for anything else: another spelling (a "T", a
 *  zone), or a day or a time that does not exist. Read strictly, so the Python reads the same
 *  strings the same way; a JavaScript Date would take 24:00 as the next midnight. */
function storedInstant(text: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/.exec(text);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const ms = Number((m[7] ?? "").slice(0, 3).padEnd(3, "0"));
  const when = new Date(Date.UTC(y, mo - 1, d, h, mi, s, ms));
  // Date.UTC rolls an impossible field into the next one; a stamp that does not come back as
  // itself named a day or a time that does not exist
  const same = when.getUTCFullYear() === y && when.getUTCMonth() === mo - 1 && when.getUTCDate() === d
    && when.getUTCHours() === h && when.getUTCMinutes() === mi && when.getUTCSeconds() === s;
  return same ? when : null;
}

export type SampleTiming = "close" | "before-open" | "after-close" | "unrecorded";

export function sampleTiming(observedAt: string | null): SampleTiming {
  const when = observedAt === null ? null : storedInstant(observedAt);
  if (when === null) return "unrecorded";
  const t = sinceNewYorkMidnight(when);
  if (t < SAMPLE_FROM) return "before-open";
  return t <= SAMPLE_UNTIL ? "close" : "after-close";
}

/** A stored day's row as far as choosing the one to value a holding from reads it. */
export interface CloseCandidate {
  /** the New York market day it is that day's row for */
  observed_on: string;
  /** UTC as the database spells it, or null on a row from before migration 0009 */
  observed_at: string | null;
  /** null on a day kept for its vol readings with no price to give (#380) */
  cost_to_close: number | null;
}

/** Which of a holding's stored rows it is valued from outside the session (#380, F6), or null where
 *  none can value it.
 *
 *  The LATEST row with a Cost to close that was taken in the hours, 09:30–16:15 New York
 *  (`sampleTiming` "close"): the day's close, which is what the sample is for (ADR 0011). Where no
 *  row with a cost was taken in the hours — a holding recorded in New York's evening and not yet
 *  through a session — the latest row with a cost of any timing, which the caller states
 *  (`sampleTiming`), so an evening's reading is never passed off as a close. A row without a cost
 *  values nothing: a weekend's row since #380 carries only the vol.
 *
 *  Latest by its market day, whatever order the rows come in.
 */
export function closeSample<T extends CloseCandidate>(samples: readonly T[]): T | null {
  let close: T | null = null;
  let any: T | null = null;
  for (const s of samples) {
    if (s.cost_to_close === null) continue;
    if (any === null || s.observed_on > any.observed_on) any = s;
    if (takenInSession(s.observed_at) && (close === null || s.observed_on > close.observed_on)) close = s;
  }
  return close ?? any;
}

/** Whether a stored row was observed IN New York's session — a weekday's 09:30–16:15 — and so is
 *  that day's close. `sampleTiming` says "close" by the hour alone, which a weekend's or a holiday's
 *  row in those hours also is: a Saturday noon reading carries Friday's close forward at best, and
 *  must never beat Friday's own (#380 review). Holidays are not detected, as `inSession` does not. */
function takenInSession(observedAt: string | null): boolean {
  if (sampleTiming(observedAt) !== "close") return false;
  return inSession(storedInstant(observedAt!)!);
}

/** What the row a holding is valued from is (`closeSample`): `sampleTiming`, except that a row in
 *  the hours on a day with no session — a weekend's — is "weekend", never "close" (#387).
 *
 *  `sampleTiming` calls a weekend's row in the hours "close" on purpose: on a chart of the samples it
 *  carries Friday's close forward (ADR 0011). But a row a holding is VALUED from is a close only if
 *  `closeSample` counts it as one, and that asks the session: a Saturday-noon row with a cost is at
 *  most the fallback, priced by a Provider that quotes at weekends, and must not read "as of the
 *  close". The same test as `closeSample`'s, so the label and the choice cannot disagree. Holidays
 *  are not detected, as `inSession` does not detect them. */
export type ValuedTiming = SampleTiming | "weekend";

export function valuedTiming(observedAt: string | null): ValuedTiming {
  const timing = sampleTiming(observedAt);
  if (timing !== "close") return timing;
  return takenInSession(observedAt) ? "close" : "weekend";
}

/** Whether a WHOLE session — a weekday's 09:30 to 16:15 New York — has run and closed on or after
 *  the market day `day` (YYYY-MM-DD), by `now` (#380 review).
 *
 *  What bounds the manage-by notice's wait for a Cost to close: a holding inside its window with no
 *  price at all through a session the market was open for is not going to get one by waiting, and
 *  the notice is sent without its "now" line rather than never. A session still running, or a day
 *  that is a weekend, has not closed. Holidays are not detected, as `inSession` does not detect them.
 */
export function sessionClosedSince(day: string, now: Date): boolean {
  const today = marketDate(now);
  const from = Date.parse(`${normalizeStrikeDate(day)}T00:00:00Z`);
  const until = Date.parse(`${today}T00:00:00Z`);
  for (let t = from; t <= until; t += 86_400_000) {
    const weekday = new Date(t).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    if (t < until || sinceNewYorkMidnight(now) > SAMPLE_UNTIL) return true;
  }
  return false;
}

/** The row a holding is valued from at `now`, or null to value it LIVE (#380).
 *
 *  In the session, always live: the Provider's quote is the price. Outside it, the holding's latest
 *  close (`closeSample`) — moomoo quotes every option bid 0 / ask 0 out of hours, which is no price,
 *  and the close is what the owner reviews a trade against. A holding with no row that has a cost is
 *  still valued live, which out of hours is a dash rather than a figure (`midPrice`).
 */
export function valuesFromClose<T extends CloseCandidate>(now: Date, samples: readonly T[]): T | null {
  return inSession(now) ? null : closeSample(samples);
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
