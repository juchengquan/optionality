import { closedLineText } from "./levels";
import type { Holding } from "./shared/api";
import type { MarketPhase } from "./session";

/** "market closed — valued at 21:04" (#371; ADR 0023 amended 2026-11-13: one page, by the session).
 *
 *  Drawn outside New York's session only, on the desk and the phone alike, because that is when
 *  the holdings and the References are valued once rather than polled. The time is the SERVICE's stamp on the valuation (`valuedAt`), the clock every Level
 *  chip states "as valued at" (#354), so the line and the chips cannot disagree. None is said
 *  while nothing is valued, or after a valuation failed: the page says why beside it. Where the
 *  service valued a holding from its latest close (#380), the line names that close on New York's
 *  clock instead — "market closed — as of the close, Fri 13 Nov 16:14" — as `/holdings` does.
 *
 *  Words only since #410: the line had a refresh button of its own, which was the header's refresh
 *  under another name — one valuation, one read of the References and the closes, then the poll as
 *  it was. Two buttons for one press, so the header's is the one there is, and it sits in a header
 *  held at the top of the screen. The saved picture says the same words (`closedLineText`).
 */
export function ClosedLine({ at, served, holdings = null, className, phase = "closed" }: {
  /** "21:04:37" or "21:04", or null for no time */
  at: string | null;
  /** the valuation's stamp whole, which says its date where the time alone would mislead —
   *  "valued at Fri 16:15" (`servedWhen`, #371's review); `at` alone where it is not given */
  served?: string | null;
  /** the holdings drawn: where any was valued from a stored close (#380), the line names that close
   *  instead — "market closed — as of the close, Fri 13 Nov 16:14" (`closeLineWords`) */
  holdings?: readonly Holding[] | null;
  className: string;
  /** which session it is outside the regular one (#416): in the Curb and GTH the line says the
   *  quotes are live and thin rather than that the market is closed */
  phase?: MarketPhase;
}) {
  return (
    <p className={`nx-mkt-closed ${className}`} data-phase={phase}>
      <span>{closedLineText(at, served, holdings, new Date(), phase)}</span>
    </p>
  );
}
