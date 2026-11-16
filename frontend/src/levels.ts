import type { Holding } from "./shared/api";
import { servedClock } from "./shared/format";
import { marketDayWords, marketPhase, newYorkClock, newYorkWhen, servedInstant, servedWhen, type MarketPhase } from "./session";
import { zoneOfStamp } from "./shared/times";

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

/** "21:04:37": when a valuation was made, for the note that says so above the book and in
 *  Settings — from the same stamp the chips read, so the page states ONE clock for it (#354). All
 *  of one answer's holdings carry the same stamp; null where none has one, or there are none. */
export function valuedAt(holdings: readonly Holding[]): string | null {
  const stamp = valuedStamp(holdings);
  const clock = servedClock(stamp);
  // with its zone by name, as every clock on the page (part F)
  return clock === null ? null : `${clock} ${zoneOfStamp(stamp)}`;
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
  // valued from a stored close outside the session (#380) — or in the Curb or GTH where a leg had
  // no quote (#416): the session line says which close and when, on New York's clock; the chip says
  // only that it is that close, so the two state ONE clock between them (#354) and the chip stays short
  if (holding.valued_from === "close") {
    return `${words} · ${holding.valued_timing === "close" ? "as of the close" : "as of the last reading"}`;
  }
  if (session) {
    // polled: bare in the regular session; in the Curb and GTH (#416) a live valuation from thin
    // quotes, so the chip says when it was made
    const made = servedInstant(holding.fetched_at);
    const thin = made !== null && ["overnight", "curb"].includes(marketPhase(made));
    if (!thin) return words;
    // a session's time, so New York's clock (part F): "live at 03:12 ET"
    return `${words} · live at ${newYorkClock(made)}`;
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

/** The session line's words in the Curb and overnight (GTH, #416): the page is polled and the
 *  holdings valued live where every leg is quoted, and the quotes are thin — then how many holdings
 *  had a leg unquoted and were valued from their latest close, and which close; and where the
 *  Provider could not be asked, that. The bot's `/holdings` line, word for word (`thinLine`). */
export function thinLineWords(holdings: readonly Holding[] | null, phase: "overnight" | "curb"): string {
  let line = phase === "overnight" ? "overnight session — live quotes, thin" : "Curb — live quotes, thin";
  const closes = (holdings ?? []).filter((h) => h.valued_from === "close");
  if (closes.length > 0) {
    const latest = closes.reduce((a, b) => ((b.valued_on ?? "") > (a.valued_on ?? "") ? b : a));
    line += `; ${closes.length} not quoted, ${closeWords(latest)}`;
  }
  // every holding is asked in the Curb and GTH, so a failure is said whichever way each was valued:
  // one valued from its close for want of a quote carries it too (#416)
  if ((holdings ?? []).some((h) => h.valued_reason !== null)) {
    line += "; the Provider could not be asked";
  }
  return line;
}

/** Whether every holding was VALUED, which is what lets the needs-you list claim to be whole (ADR
 *  0012): an answer arrived, without an error, and no holding in it is one the service could not
 *  value because the Provider could not be asked out of the session (`valued_reason`, #387) — a 200
 *  of dashes is no valuation, and a holding at its Level is the one need only a valuation shows. */
export function everyHoldingValued(holdings: readonly Holding[] | null, error: string | null): boolean {
  return holdings !== null && error === null && holdings.every((h) => h.valued_reason === null);
}

/** The market-closed line's words, for the line (`ClosedLine.tsx`) and the saved picture's header
 *  (#394), so the two cannot word the session apart. `now` is the clock that decides whether a time
 *  needs its date. */
export function closedLineText(
  at: string | null, served: string | null | undefined, holdings: readonly Holding[] | null,
  now: Date = new Date(), phase: MarketPhase = "closed",
): string {
  if (phase === "overnight" || phase === "curb") return thinLineWords(holdings, phase);
  // a time with no stamp beside it said to the minute, as a stamp's is
  const words = at === null ? null : (served ? servedWhen(served, now) : null) ?? at.replace(/^(\d\d:\d\d):\d\d/, "$1");
  return closeLineWords(holdings) ?? (words ? `market closed — valued at ${words}` : "market closed");
}
