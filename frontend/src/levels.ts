import type { Holding } from "./shared/api";
import { servedClock } from "./shared/format";
import { marketDayWords, newYorkWhen, servedWhen } from "./session";

/** A holding's Levels as its chip says them, on every surface that draws one (#354, re-keyed to
 *  the session by #371).
 *
 *  Outside New York's session the needs-you line says nothing of a holding's Levels: it uses only
 *  what is polled (ADR 0012), and outside the session the holdings are valued once — on opening,
 *  at the change of session, or by the refresh — rather than polled. The chip is drawn from that
 *  one valuation, so it says which one — "at stop · as valued at 21:04" — and the two cannot read
 *  as a disagreement (the owner's decision (b), ADR 0023 as amended 2026-11-13). In session the
 *  line and the chip read the same poll, and the chip carries no time. Nothing but the session
 *  decides either.
 *
 *  ONE function for the words, so the desk's row, its inspector, the phone's page and sheet, the
 *  saved picture and the desk's fitting, which counts the chip's characters, say the same thing. */
type Level = "stop" | "target" | "manage";

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
  return servedClock(valuedStamp(holdings));
}

/** The service's stamp on a valuation, whole (`2026-11-12 21:04:37+08:00`), for words that say its
 *  DATE when it is not today's (`servedWhen`); null where none has a time, or there are none. */
export function valuedStamp(holdings: readonly Holding[]): string | null {
  return holdings.find((h) => servedClock(h.fetched_at) !== null)?.fetched_at ?? null;
}

/** @param session whether New York's session is open: bare then, with its valuation's time
 *  outside it — and its date too where the time alone would mislead (`servedWhen`, #371's review)
 *  @param now the clock that decides that, the page's own */
export function levelWords(level: Level, holding: Holding, session: boolean, now: Date = new Date()): string {
  const words = LEVEL_WORDS[level];
  if (session) return words;
  // valued from a stored close outside the session (#380): the market-closed line says which close
  // and when, on New York's clock; the chip says only that it is that close, so the two state ONE
  // clock between them (#354) and the chip stays short
  if (holding.valued_from === "close") {
    return `${words} · ${holding.valued_timing === "close" ? "as of the close" : "as of the last reading"}`;
  }
  const at = servedWhen(holding.fetched_at, now);
  // a valuation with no time on it is still not live, and is said to be as last valued
  return `${words} · ${at ? `as valued at ${at}` : "as last valued"}`;
}

/** Which stored row a holding was valued from, in words: "as of the close, Fri 13 Nov 16:14", on New
 *  York's clock — or, where no row with a cost was taken in a session, that reading's own timing, so
 *  it is never passed off as a close (#380): a weekend's by its time alone (#387). The bot's
 *  `/holdings` says the same words. */
export function closeWords(h: Holding): string {
  const when = newYorkWhen(h.fetched_at);
  switch (h.valued_timing) {
    case "close": return `as of the close, ${when ?? marketDayWords(h.valued_on ?? "") ?? "unknown"}`;
    case "after-close": return `as of ${when}, after the close`;
    case "before-open": return `as of ${when}, before the open`;
    case "weekend": return `as of ${when}`;
    default: return `as of ${marketDayWords(h.valued_on ?? "") ?? "an earlier day"}, at a time not recorded`;
  }
}

/** The market-closed line's words where any holding was valued from a stored close (#380):
 *  "market closed — as of the close, Fri 13 Nov 16:14", then how many holdings were valued from
 *  another row and how many had none and were valued live — or, where the Provider could not be
 *  asked for them (`valued_reason`), were not valued at all (#387). Null where every holding was
 *  valued live — the line then says when, as it did (`valuedStamp`). The bot's `closedLine`, word
 *  for word. */
export function closeLineWords(holdings: readonly Holding[] | null): string | null {
  const closes = (holdings ?? []).filter((h) => h.valued_from === "close");
  // one call prices every holding valued live, so either all of them were asked or none was
  const unasked = (holdings ?? []).some((h) => h.valued_from === "live" && h.valued_reason !== null);
  const liveWords = unasked ? "and the Provider could not be asked" : "valued live";
  if (closes.length === 0) return unasked ? `market closed — no close recorded yet, ${liveWords}` : null;
  const live = holdings!.length - closes.length;
  // the instant each was observed, for "latest": a stamp the service wrote in one zone compares as
  // text within it, and a missing one sorts first
  const stamp = (h: Holding) => h.fetched_at ?? "";
  const later = (a: Holding, b: Holding) =>
    (b.valued_on ?? "") > (a.valued_on ?? "") || (b.valued_on === a.valued_on && stamp(b) > stamp(a));
  const inHours = closes.filter((h) => h.valued_timing === "close");
  const pool = inHours.length > 0 ? inHours : closes;
  const latest = pool.reduce((a, b) => (later(a, b) ? b : a));
  const key = (h: Holding) => `${h.valued_on} ${h.valued_timing}`;
  const others = closes.filter((h) => key(h) !== key(latest)).length;
  let line = `market closed — ${closeWords(latest)}`;
  if (others > 0) line += `; ${others} as of another reading`;
  if (live > 0) line += `; ${live} with no close, ${liveWords}`;
  return line;
}
