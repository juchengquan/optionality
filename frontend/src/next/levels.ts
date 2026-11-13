import type { Holding } from "../shared/api";
import { servedClock } from "../shared/format";

/** A holding's Levels as its chip says them, on every surface that draws one (#354, re-keyed to
 *  the session by #371).
 *
 *  Outside New York's session the needs-you line says nothing of a holding's Levels: it uses only
 *  what is polled (ADR 0012), and outside the session the holdings are valued once — on opening,
 *  at the change of session, or by the refresh — rather than polled. The chip is drawn from that
 *  one valuation, so it says which one — "at stop · as valued at 21:04" — and the two cannot read
 *  as a disagreement (the owner's decision (b), ADR 0023 as amended 2026-11-13). In session the
 *  line and the chip read the same poll, and the chip carries no time. The mode on screen plays no
 *  part in either.
 *
 *  ONE function for the words, so the desk's row, its inspector, the phone's page and sheet, the
 *  saved picture and the desk's fitting, which counts the chip's characters, say the same thing. */
export type Level = "stop" | "target" | "manage";

export const LEVEL_WORDS: Record<Level, string> = {
  stop: "at stop", target: "at target", manage: "manage-by",
};

/** "21:04": the clock the service wrote on a valuation (`servedClock`), to the minute, for a chip,
 *  which is short. */
export function valuedClock(served: string | null | undefined): string | null {
  return servedClock(served)?.slice(0, 5) ?? null;
}

/** "21:04:37": when a valuation was made, for the note that says so above the book and in
 *  Settings — from the same stamp the chips read, so the page states ONE clock for it (#354). All
 *  of one answer's holdings carry the same stamp; null where none has one, or there are none. */
export function valuedAt(holdings: readonly Holding[]): string | null {
  for (const h of holdings) {
    const at = servedClock(h.fetched_at);
    if (at !== null) return at;
  }
  return null;
}

/** @param session whether New York's session is open: bare then, with its valuation's time
 *  outside it */
export function levelWords(level: Level, holding: Holding, session: boolean): string {
  const words = LEVEL_WORDS[level];
  if (session) return words;
  const at = valuedClock(holding.fetched_at);
  // a valuation with no time on it is still not live, and is said to be as last valued
  return `${words} · ${at ? `as valued at ${at}` : "as last valued"}`;
}
