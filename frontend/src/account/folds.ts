/** What the account page has folded (the owner, 2026-11-24): its three sections, Stocks, Options and
 *  Other, and each underlying inside Options. As the book's expiry groups fold (`../folds.ts`):
 *
 *  - **Remembered in a cookie of its own** (`readAccountFolded`), which stores what is FOLDED, so
 *    everything starts open — a new underlying included.
 *  - **A press folds or opens what THIS tab shows**, applied to the cookie as it stands NOW
 *    (`pressed`): another tab may have folded or opened something since this one read it.
 *  - **An underlying the account no longer holds drops out** of the cookie when it is next written.
 *    The sections never do: they are the page's, not the account's, and one with nothing in it now
 *    may hold something tomorrow. An answer is the whole account, so there is no partial read to
 *    wait out, as the book waits for its holdings and its watchlist.
 */
import { useCallback, useState } from "react";

import { pressed } from "../folds";
import type { Account } from "../shared/api";
import { readAccountFolded, writeAccountFolded } from "../shared/prefs";

export type SectionKey = "stocks" | "options" | "other";

/** "options:SPX": an underlying as the cookie names it. */
export const underlyingKey = (symbol: string): string => `options:${symbol}`;

/** Every fold the page can draw for this account, as the cookie names them. */
function foldsOf(account: Account): Set<string> {
  return new Set(["stocks", "options", "other", ...account.options.map((o) => underlyingKey(o.symbol))]);
}

export function useAccountFolds(account: Account): {
  folded: (key: string) => boolean;
  toggle: (key: string) => void;
} {
  const [folds, setFolds] = useState(() => readAccountFolded());
  const toggle = useCallback((key: string) => {
    const next = pressed(readAccountFolded(), key, !folds.has(key), foldsOf(account));
    writeAccountFolded(next);
    setFolds(next);
  }, [account, folds]);
  const folded = useCallback((key: string) => folds.has(key), [folds]);
  return { folded, toggle };
}
