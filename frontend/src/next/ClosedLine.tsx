import { RefreshCw } from "lucide-react";

/** "market closed — valued at 21:04", with a button that values the book once more (#371; ADR
 *  0023 amended 2026-11-13: one page, by the session).
 *
 *  Drawn outside New York's session only, on the desk and the phone alike and whatever the mode on
 *  screen, because that is when the holdings and the References are valued once rather than
 *  polled. The time is the SERVICE's stamp on the valuation (`valuedAt`), the clock every Level
 *  chip states "as valued at" (#354), so the line and the chips cannot disagree. None is said
 *  while nothing is valued, or after a valuation failed: the page says why beside it.
 *
 *  The button is the header's refresh — one valuation and one read of the References, then the
 *  poll as it was. It starts no poll: outside the session only the line is polled. The saved
 *  picture draws the line with no button (`onRefresh` absent): nothing in it can be pressed.
 */
export function ClosedLine({ at, onRefresh, refreshing = false, className }: {
  /** "21:04:37" or "21:04", or null for no time */
  at: string | null;
  onRefresh?: () => void;
  refreshing?: boolean;
  className: string;
}) {
  return (
    <p className={`nx-mkt-closed ${className}`}>
      <span>{at ? `market closed — valued at ${at.slice(0, 5)}` : "market closed"}</span>
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
