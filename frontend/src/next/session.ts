import { useEffect, useState } from "react";

/** New York's session, which decides what the page fetches and what the needs-you line says (ADR
 *  0023, amended 2026-11-13: one page, by the session; #371).
 *
 *  The clock that matters is New York's: the session opens at 09:30 there whatever zone the owner
 *  reads in, so the rule is written in New York time and DISPLAY_TZ changes only how times are
 *  shown. 16:15 is the close of SPX/SPXW options. Holidays are not detected: on one the page polls
 *  as in session with nothing moving, which costs one bounded call per poll and nothing else.
 *
 *  NOT the domain's `inSampleHours` (`typescript/src/domain/expiry.ts`), though its edges are the
 *  same, and the two must not be "unified":
 *  - the frontend cannot import it — `tools/check-boundaries.mjs`' `DEPENDS` lets `frontend`
 *    import only `backend`;
 *  - and it is the wrong question here even apart from that. It counts WEEKENDS, on purpose: the
 *    daily sample is written every calendar day, because the vol chain steps exactly one day (ADR
 *    0011, amended). A page that took Saturday for the session would poll the Provider all weekend.
 */

/** Seconds since New York midnight, both ends included: 16:15:00 is the close, as the daily
 *  sample's window has it, and 16:15:01 is not. */
const OPEN = (9 * 60 + 30) * 60;
const CLOSE = (16 * 60 + 15) * 60;

/** Fields, not a formatted string: `formatToParts` cannot be misread by a locale's punctuation,
 *  and `hourCycle: "h23"` is the spelling that cannot render midnight as 24. */
const DAY_FIELDS = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

/** New York's wall clock at an instant: its calendar day (as a UTC midnight, for arithmetic), its
 *  weekday and the seconds since its midnight. */
function newYork(at: Date): { day: number; weekday: string; second: number } {
  const parts = DAY_FIELDS.formatToParts(at);
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  return {
    day: Date.UTC(Number(part("year")), Number(part("month")) - 1, Number(part("day"))),
    weekday: part("weekday"),
    second: (Number(part("hour")) * 60 + Number(part("minute"))) * 60 + Number(part("second")),
  };
}

/** 09:30:00 to 16:15:00 New York, Monday to Friday. */
export function inSession(now: Date): boolean {
  const { weekday, second } = newYork(now);
  if (weekday === "Sat" || weekday === "Sun") return false;
  return second >= OPEN && second <= CLOSE;
}

/** The instant New York's wall clock reads `second` on the calendar `day` (a UTC midnight). Found
 *  by correcting a guess by the offset it lands on, twice: once is enough except across a change of
 *  clocks, and the edges here (09:30, 16:15) are never inside the hour a change skips or repeats. */
function atNewYork(day: number, second: number): Date {
  const wall = day + second * 1000;
  let t = wall + 5 * 3_600_000;
  for (let i = 0; i < 2; i++) {
    const seen = newYork(new Date(t));
    t += wall - (seen.day + seen.second * 1000);
  }
  return new Date(t);
}

/** The last edge of the session at or before `now`: today's open (09:30:00) while it is open, its
 *  close (16:15:01, the first second out) after it, and before a weekday's open — or all weekend —
 *  the last weekday's close.
 *
 *  WHICH session the page is in or after, where `inSession` says only whether: Monday 20:00 and
 *  Tuesday 20:00 New York are both out of session, a whole session apart. The page re-values the
 *  book when this changes, so a tab asleep through a session (iOS suspends its timers) is valued
 *  again when it wakes rather than drawing the day before's valuation (#371's review). The same
 *  instant says whether a served stamp predates the session's last edge (`servedWhen`). */
export function sessionEdge(now: Date): Date {
  const { day, weekday, second } = newYork(now);
  const weekend = weekday === "Sat" || weekday === "Sun";
  if (!weekend && second > CLOSE) return atNewYork(day, CLOSE + 1);
  if (!weekend && second >= OPEN) return atNewYork(day, OPEN);
  // the last weekday before today, at its close
  let back = day - 86_400_000;
  while ([0, 6].includes(new Date(back).getUTCDay())) back -= 86_400_000;
  return atNewYork(back, CLOSE + 1);
}

/** The clock, read every 15 seconds and again whenever the page comes back into view: a phone
 *  woken at 09:31 must not wait out a timer that slept with it before the session opens on it. */
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
