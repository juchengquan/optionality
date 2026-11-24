/** The account page's reads of `GET /account` (#471): on opening, on the refresh button, and at the
 *  page's own cadence while it is in view — never by New York's session, which decides nothing here.
 *
 *  - Off (`null`) reads on opening and on the button, and nothing by itself. Every read goes through
 *    the poll, the opening one included.
 *  - A tick while the page is hidden reads nothing; coming back into view reads at once if a read
 *    fell due meanwhile, and the cadence runs on from that read. Back sooner, nothing extra is read.
 *  - A tick never stacks a read on one still out (`skipWhileOut`, as the book's poll), for at most
 *    two ticks' worth and never less than a minute.
 *  - The button reads afresh whatever is out, through the poll so no tick stacks on it, and restarts
 *    the cadence at the press: a press just before a tick must displace it rather than add a read.
 *  - An answer lands unless a newer one already has. A failure keeps the last good answer, if there
 *    was one, beside the error (the owner, 2026-11-23): the page draws it dimmed, as of when it was
 *    read. A first read that fails leaves no answer, and the page draws no figure. */
import { useCallback, useEffect, useRef, useState } from "react";

import { fetchAccount, type Account } from "../shared/api";
import { rawError } from "../shared/errors";
import type { AccountRefresh } from "../shared/prefs";
import { givenUpAfter, skipWhileOut } from "../poll";

export interface AccountRead {
  /** the last good answer — kept through a failure after it — or null before the first */
  account: Account | null;
  /** what the last failed read threw, as thrown, or null */
  error: string | null;
  /** whether the button's read is out */
  refreshing: boolean;
  refreshNow: () => Promise<void>;
}

export function useAccount(refresh: AccountRefresh): AccountRead {
  const [account, setAccount] = useState<Account | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [pollFrom, setPollFrom] = useState(0);
  const asked = useRef(0);
  const landed = useRef(0);
  // when the last read started, by the page's clock: what coming back into view is measured against
  const lastAsked = useRef(0);

  const load = useCallback(async () => {
    const mine = ++asked.current;
    lastAsked.current = Date.now();
    try {
      const answer = await fetchAccount();
      if (mine < landed.current) return;
      landed.current = mine;
      setAccount(answer);
      setError(null);
    } catch (e: unknown) {
      if (mine < landed.current) return;
      landed.current = mine;
      setError(rawError(e));
    }
  }, []);

  const cadence = useRef(refresh);
  cadence.current = refresh;
  const [poll] = useState(() => skipWhileOut(load, () => givenUpAfter(cadence.current ?? 60)));

  // once on opening, through the poll: a tick that falls due while it is still out reads nothing
  // (review of #474: read beside the poll, a 15 s tick sent a second read on top of a held one)
  useEffect(() => { void poll(); }, [poll]);

  useEffect(() => {
    if (refresh === null) return;
    const id = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void poll();
    }, refresh * 1000);
    return () => clearInterval(id);
  }, [refresh, pollFrom, poll]);

  useEffect(() => {
    const onShow = () => {
      const every = cadence.current;
      if (document.visibilityState === "hidden" || every === null) return;
      if (Date.now() - lastAsked.current < every * 1000) return;
      void poll();
      setPollFrom((n) => n + 1);
    };
    document.addEventListener("visibilitychange", onShow);
    return () => document.removeEventListener("visibilitychange", onShow);
  }, [poll]);

  // The button's read goes THROUGH the poll, after giving up on whatever it had out: so it is the
  // read a tick finds out, and a tick that falls due while it is held reads nothing (review of #474:
  // read beside the poll, a tick 2 s after a held press sent a third read). And the cadence restarts
  // at the press, so the next tick is a whole interval after it.
  const refreshNow = useCallback(async () => {
    poll.reset();
    setPollFrom((n) => n + 1);
    setRefreshing(true);
    try {
      await poll();
    } finally {
      setRefreshing(false);
    }
  }, [poll]);

  return { account, error, refreshing, refreshNow };
}
