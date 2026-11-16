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

export function getDisplayZone(): string | null {
  return displayZone;
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
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Thu 31 Dec": a calendar date (YYYY-MM-DD) as prose names it — an expiry in a sentence, the day a
 *  holding was opened or closed — as `session.marketDayWords` and the bot name a market day. No year:
 *  the weekday already pins the date within years of it, and every other date on the page is written
 *  without one. Anything that is not a date is returned untouched. Never ISO on screen (part F): the
 *  compact `261231` is `format.shortDate`, for dense places — the table, the picture, the palette. */
export function dateWords(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? "");
  if (!m) return iso ?? "";
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}
