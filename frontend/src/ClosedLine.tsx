import { RefreshCw } from "lucide-react";

import { closeLineWords } from "./levels";
import type { Holding } from "./shared/api";
import { servedWhen } from "./session";

/** "market closed — valued at 21:04", with a button that values the book once more (#371; ADR
 *  0023 amended 2026-11-13: one page, by the session).
 *
 *  Drawn outside New York's session only, on the desk and the phone alike, because that is when
 *  the holdings and the References are valued once rather than polled. The time is the SERVICE's stamp on the valuation (`valuedAt`), the clock every Level
 *  chip states "as valued at" (#354), so the line and the chips cannot disagree. None is said
 *  while nothing is valued, or after a valuation failed: the page says why beside it. Where the
 *  service valued a holding from its latest close (#380), the line names that close on New York's
 *  clock instead — "market closed — as of the close, Fri 13 Nov 16:14" — as `/holdings` does.
 *
 *  The button is the header's refresh — one valuation and one read of the References, then the
 *  poll as it was. It starts no poll: outside the session only the line is polled. The saved
 *  picture draws the line with no button (`onRefresh` absent): nothing in it can be pressed.
 */
export function ClosedLine({ at, served, holdings = null, onRefresh, refreshing = false, className }: {
  /** "21:04:37" or "21:04", or null for no time */
  at: string | null;
  /** the valuation's stamp whole, which says its date where the time alone would mislead —
   *  "valued at Fri 16:15" (`servedWhen`, #371's review); `at` alone where it is not given */
  served?: string | null;
  /** the holdings drawn: where any was valued from a stored close (#380), the line names that close
   *  instead — "market closed — as of the close, Fri 13 Nov 16:14" (`closeLineWords`) */
  holdings?: readonly Holding[] | null;
  onRefresh?: () => void;
  refreshing?: boolean;
  className: string;
}) {
  const words = at === null ? null : served ? servedWhen(served) ?? at.slice(0, 5) : at.slice(0, 5);
  const close = closeLineWords(holdings);
  return (
    <p className={`nx-mkt-closed ${className}`}>
      <span>{close ?? (words ? `market closed — valued at ${words}` : "market closed")}</span>
      {onRefresh ? (
        <button type="button" className="nx-mkt-closed-refresh" aria-label="refresh the valuation" disabled={refreshing}
                onClick={onRefresh}>
          <RefreshCw aria-hidden="true" className={refreshing ? "animate-spin" : undefined} />
          refresh
        </button>
      ) : null}
    </p>
  );
}
