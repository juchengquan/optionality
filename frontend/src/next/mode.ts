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

/** Seconds since New York midnight, both ends included: 16:15:00 is the close, as the daily
 *  sample's window has it (`inSampleHours`), and 16:15:01 is not. */
const OPEN = (9 * 60 + 30) * 60;
const CLOSE = (16 * 60 + 15) * 60;

/** Fields, not a formatted string: `formatToParts` cannot be misread by a locale's punctuation,
 *  and `hourCycle: "h23"` is the spelling that cannot render midnight as 24. */
const NEW_YORK = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit",
  second: "2-digit", hourCycle: "h23",
});

export function inSession(now: Date): boolean {
  const parts = NEW_YORK.formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  if (part("weekday") === "Sat" || part("weekday") === "Sun") return false;
  const second = (Number(part("hour")) * 60 + Number(part("minute"))) * 60 + Number(part("second"));
  return second >= OPEN && second <= CLOSE;
}

export function clockMode(now: Date): Mode {
  return inSession(now) ? "live" : "review";
}

/** The clock, read every 15 seconds and again whenever the page comes back into view: a phone
 *  woken at 09:31 must not wait out a timer that slept with it before it turns LIVE. */
export function useSessionClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const read = () => setNow(new Date());
    const id = setInterval(read, 15_000);
    const onShow = () => { if (document.visibilityState === "visible") read(); };
    document.addEventListener("visibilitychange", onShow);
    window.addEventListener("focus", read);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onShow);
      window.removeEventListener("focus", read);
    };
  }, []);
  return now;
}
