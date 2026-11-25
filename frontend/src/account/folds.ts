/** What the account page has folded (the owner, 2026-11-24): its three sections, Options, Stocks and
 *  Other, and each underlying inside Options. As the book's expiry groups fold (`../folds.ts`; the
 *  press itself is `../shared/folds.ts`, so this page reaches nothing of the book's):
 *
 *  - **Stocks starts folded, everything else open** — a new underlying included (the owner,
 *    2026-11-25).
 *  - **Remembered in a cookie of its own** (`readAccountFolded`), which stores where a fold DIFFERS
 *    from how it starts: Options, Other or an underlying FOLDED, by its key, and Stocks OPENED, as
 *    `stocks:open` (`entryOf`). An old cookie's bare `stocks` (folded) is no entry and is dropped.
 *  - **A press folds or opens what THIS tab shows**, applied to the cookie as it stands NOW
 *    (`pressed`): another tab may have folded or opened something since this one read it.
 *  - **An underlying the account no longer holds drops out** of the cookie when it is next written.
 *    The sections never do: they are the page's, not the account's, and one with nothing in it now
 *    may hold something tomorrow. An answer is the whole account, so there is no partial read to
 *    wait out, as the book waits for its holdings and its watchlist.
 */
import { useCallback, useState } from "react";

import type { Account } from "../shared/api";
import { pressed } from "../shared/folds";
import { readAccountFolded, writeAccountFolded } from "../shared/prefs";

export type SectionKey = "stocks" | "options" | "other";

/** "options:SPX": an underlying as the cookie names it. */
export const underlyingKey = (symbol: string): string => `options:${symbol}`;

/** The folds that start folded, each stored as `<key>:open` once opened. */
const STARTS_FOLDED: ReadonlySet<string> = new Set<SectionKey>(["stocks"]);

/** A fold's entry in the cookie: what it says where the fold differs from how it starts. */
const entryOf = (key: string): string => (STARTS_FOLDED.has(key) ? `${key}:open` : key);

/** Every entry the cookie can hold for this account. */
function foldsOf(account: Account): Set<string> {
  return new Set(["stocks:open", "options", "other", ...account.options.map((o) => underlyingKey(o.symbol))]);
}

export function useAccountFolds(account: Account): {
  folded: (key: string) => boolean;
  toggle: (key: string) => void;
} {
  const [entries, setEntries] = useState(() => readAccountFolded());
  // an entry says folded, or for a fold that starts folded, opened
  const folded = useCallback((key: string) => entries.has(entryOf(key)) !== STARTS_FOLDED.has(key), [entries]);
  const toggle = useCallback((key: string) => {
    // the opposite of what THIS tab shows, its entry kept where that differs from how it starts
    const fold = !folded(key);
    const next = pressed(readAccountFolded(), entryOf(key), fold !== STARTS_FOLDED.has(key), foldsOf(account));
    writeAccountFolded(next);
    setEntries(next);
  }, [account, folded]);
  return { folded, toggle };
}
