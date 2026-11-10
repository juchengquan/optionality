import { useEffect, useState } from "react";

/** LIVE is the session — detect and act; REVIEW is after it — understand (ADR 0023).
 *
 *  The default follows the clock, and the clock that matters is New York's: the session opens at
 *  09:30 there whatever zone the owner reads in, so the rule is written in New York time and
 *  DISPLAY_TZ changes only how times are shown. 16:15 is the close of SPX/SPXW options, the same
 *  edge the daily sample uses (ADR 0011, amended). Holidays are not detected: on one the page opens
 *  in LIVE with nothing moving, which costs nothing and the switch answers.
 */
export type Mode = "live" | "review";

const OPEN = 9 * 60 + 30;
const CLOSE = 16 * 60 + 15;

/** Fields, not a formatted string: `formatToParts` cannot be misread by a locale's punctuation,
 *  and `hourCycle: "h23"` is the spelling that cannot render midnight as 24. */
const NEW_YORK = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit",
  hourCycle: "h23",
});

export function inSession(now: Date): boolean {
  const part = (type: string) => NEW_YORK.formatToParts(now).find((p) => p.type === type)!.value;
  if (part("weekday") === "Sat" || part("weekday") === "Sun") return false;
  const minute = Number(part("hour")) * 60 + Number(part("minute"));
  return minute >= OPEN && minute <= CLOSE;
}

export function clockMode(now: Date): Mode {
  return inSession(now) ? "live" : "review";
}

/** The clock, read once a minute: enough for a page left open across 09:30 to turn LIVE by itself
 *  — unless the owner chose a mode, which holds until the page is opened again. */
export function useMinuteClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  return now;
}
