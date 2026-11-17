/** Every clock the page writes carries its zone (the owner's standard of 2026-11-16, part F; ADR 0023).
 *
 *  Two clocks, by what a time is ABOUT:
 *  - the MARKET's — a close, a last trade, a Level reached live, a session — on New York's clock,
 *    marked `ET` (`session.ts`'s `newYorkWhen` and its kin; `ET` and never EST/EDT, because the
 *    market's clock is one clock all year and the page names it one way);
 *  - the VIEWER's — when the service fetched, when the screen updated, when a holding was valued or a
 *    Reference read — in DISPLAY_TZ, as the service writes every stamp it serves, marked with that
 *    zone's short name: `SGT` for Asia/Singapore. Never a bare offset like `+08:00`.
 *
 *  The short name is the tz database's own (`timeZoneName: "short"`), asked of a few English locales
 *  in turn, because each spells only its own region's zones: en-US says `GMT+8` for Singapore and
 *  en-SG says `SGT`. Where none has a name, the offset itself, `GMT+8` — a zone still, if a plain one.
 *
 *  DISPLAY_TZ is the service's (`/health`'s `settings.display_tz`). Until the page has read it the
 *  device's own zone stands in where it agrees with the stamp's offset, which it does for the owner,
 *  and the stamp's offset where it does not: a stamp is never said in a zone it was not written in.
 */

/** New York's clock, as the page marks it. */
export const ET = "ET";

/** The service's DISPLAY_TZ as `/health` last said it, set by the page as it draws (`Next.tsx`), so
 *  every pure reader of a served stamp — the Levels, the References, the closed line, the picture —
 *  names the same zone without each being handed it. Null until the page has read it. */
let displayZone: string | null = null;

export function setDisplayZone(tz: string | null | undefined): void {
  displayZone = tz && validZone(tz) ? tz : null;
}

function validZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The device's zone, the stand-in until DISPLAY_TZ is known. */
function deviceZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
  } catch {
    return null;
  }
}

/** The locales asked for a zone's short name, in turn (above). */
const LOCALES = ["en-US", "en-GB", "en-SG", "en-AU", "en-IN", "en-HK", "en-NZ", "en-CA", "en-IE", "en-ZA"];

/** `GMT+8`, `GMT-4:30`, `UTC`: an offset in minutes east of UTC as a zone name. */
export function offsetName(minutes: number): string {
  if (minutes === 0) return "UTC";
  const sign = minutes < 0 ? "-" : "+";
  const a = Math.abs(minutes);
  const h = Math.floor(a / 60);
  const m = a % 60;
  return `GMT${sign}${h}${m ? `:${String(m).padStart(2, "0")}` : ""}`;
}

/** A zone's offset from UTC at an instant, in minutes east. */
export function offsetAt(tz: string, at: Date): number | null {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
      second: "2-digit", hourCycle: "h23",
    }).formatToParts(at).map((x) => [x.type, x.value]));
    const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
    return Math.round((wall - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
  } catch {
    return null;
  }
}

/** A zone's short name at an instant: `SGT`, `EST`, `CET`, `AEDT`, `UTC` — or its offset, `GMT+8`,
 *  where no English locale names it. */
export function zoneName(tz: string, at: Date): string {
  for (const locale of LOCALES) {
    try {
      const name = new Intl.DateTimeFormat(locale, { timeZone: tz, timeZoneName: "short" })
        .formatToParts(at).find((p) => p.type === "timeZoneName")?.value;
      if (name && !/^(GMT|UTC)[+-−]/.test(name)) return name === "GMT" && tz === "UTC" ? "UTC" : name;
    } catch {
      return offsetName(0);
    }
  }
  const offset = offsetAt(tz, at);
  return offset === null ? "UTC" : offsetName(offset);
}

/** The zone a stamp the service wrote is in, by name: DISPLAY_TZ's (or, before it is known, the
 *  device's) where that zone's offset at the instant is the stamp's own, and the offset otherwise.
 *  @param offset the stamp's, in minutes east of UTC */
export function zoneOfOffset(offset: number, at: Date): string {
  for (const tz of [displayZone, deviceZone()]) {
    if (tz && offsetAt(tz, at) === offset) return zoneName(tz, at);
  }
  return offsetName(offset);
}

/** The viewer's zone at an instant: DISPLAY_TZ's name, or the device's until it is known. */
export function viewerZone(at: Date): string {
  const tz = displayZone ?? deviceZone();
  return tz ? zoneName(tz, at) : "UTC";
}

const pad = (n: number) => String(n).padStart(2, "0");

/** `21:04:37 SGT`: an instant on the viewer's clock — DISPLAY_TZ's, never merely the device's — with
 *  its zone. What "screen updated" says. */
export function viewerClock(at: Date): string {
  const tz = displayZone ?? deviceZone();
  if (tz) {
    try {
      const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
        timeZone: tz, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
      }).formatToParts(at).map((x) => [x.type, x.value]));
      return `${p.hour}:${p.minute}:${p.second} ${zoneName(tz, at)}`;
    } catch {
      // an unknown zone: the device's clock below
    }
  }
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())} ${offsetName(-at.getTimezoneOffset())}`;
}

/** The parts of a stamp the service served (`2026-11-16 21:04:37+08:00`), or null for one that is
 *  not a stamp; `offset` is null where it carries none. */
export function stampParts(served: string | null | undefined): {
  date: string; clock: string; seconds: string; offset: number | null; at: Date | null;
} | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.exec(served ?? "");
  if (!m) return null;
  const zone = m[7];
  const offset = zone === undefined ? null : zone === "Z" ? 0
    : (zone[0] === "-" ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(-2)));
  const at = offset === null ? null
    : new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])) - offset * 60_000);
  return { date: `${m[1]}-${m[2]}-${m[3]}`, clock: `${m[4]}:${m[5]}`, seconds: m[6]!, offset, at };
}

/** The zone a served stamp names, or the viewer's where it carries no offset (it was still written
 *  in DISPLAY_TZ, which is all the service writes in). */
export function zoneOfStamp(served: string | null | undefined): string {
  const p = stampParts(served);
  if (p?.offset !== null && p?.offset !== undefined && p.at) return zoneOfOffset(p.offset, p.at);
  return viewerZone(p?.at ?? new Date());
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/* How a DATE is written, the owner's standard of 2026-11-17 (ADR 0023): one form everywhere a date is
   shown — the page, the picture, Copy as text and the bot — in three shapes, each written here and
   nowhere else:
   - a date alone is `writtenDate`, `20261231` — an expiry heading, a contract, an opened or closed
     day, a note, a history's day, the palette;
   - a date beside a time keeps its weekday, `weekdayDate`, `Mon 20261116` — `Mon 20261116 20:15 ET`
     (`session.newYorkWhen`, `servedWhen`, `format.fetchedWords`, the picture's "taken");
   - a chart's axis would write `1116` (MMDD) to stay narrow; no chart draws a date axis today (each
     runs on DTE), so nothing here writes one.
   A weekday alone beside a time, `Fri 16:14 ET`, names no date and stays. Before, these were
   `dateWords` ("Thu 31 Dec"), `format.shortDate` ("261231"), `session.marketDayWords` ("Fri 13 Nov"),
   the day in `servedWhen` ("13 Nov 21:04"), three `Intl` "3 Nov" formats (`burndown.ts`,
   `historyDays.ts`, `PaceExplained.tsx`), `format.shortContract`'s six digits and the picture's
   `Intl` "Sun 15 Nov 2026". */

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "20261231": a calendar date (YYYY-MM-DD) as the owner reads one. Anything that is not a date is
 *  returned untouched — a figure must never fail for the day it names. */
export function writtenDate(iso: string | null | undefined): string {
  const m = DATE.exec(iso ?? "");
  return m ? `${m[1]}${m[2]}${m[3]}` : iso ?? "";
}

/** "Mon 20261116": a date with its weekday, for a date written beside a time. Anything that is not a
 *  date is returned untouched. */
export function weekdayDate(iso: string | null | undefined): string {
  const m = DATE.exec(iso ?? "");
  if (!m) return iso ?? "";
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return `${WEEKDAYS[d.getUTCDay()]} ${m[1]}${m[2]}${m[3]}`;
}
