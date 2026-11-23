/** The account page (#471): the whole IBKR account as IBKR marks it, read-only — its totals, then
 *  its stocks, its options and anything else apart. At `/opt/account` (`pages.ts`), reached from
 *  the book's header and left by a plain link, so neither page polls while the other is shown.
 *
 *  One arrangement or the other as the book chooses (`arrangement.ts`): a table per kind on the
 *  desk, a card per holding on the phone. Nothing on it writes anything: the cadence is a cookie,
 *  and the refresh button reads. The book's privacy setting applies here too. */
import { useEffect, useState } from "react";
import { ArrowLeft, RefreshCw } from "lucide-react";

import "../next.css";
import "./account.css";
import { Button, buttonVariants } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { arrangementFor, useViewportWidth } from "../arrangement";
import { bookHref } from "../pages";
import { ErrorWords } from "../shared/ErrorWords";
import { fetchedWords } from "../shared/format";
import {
  ACCOUNT_REFRESHES, readAccountRefresh, readArrangement, readPrivacy, readUp, writeAccountRefresh,
  type AccountRefresh,
} from "../shared/prefs";
import { AccountView } from "./AccountView";
import { useAccount } from "./useAccount";

/** The cadences as the control says them. */
const CADENCE_WORDS: Record<(typeof ACCOUNT_REFRESHES)[number], string> = {
  15: "15 s", 30: "30 s", 60: "1 min", 180: "3 min",
};

export function Account({ base }: { base: string }) {
  const [refresh, setRefresh] = useState<AccountRefresh>(readAccountRefresh);
  const [up] = useState(readUp);
  // the book's setting, set in its Settings: the account's money hidden as the book's is
  const [privacy] = useState(readPrivacy);
  const [choice] = useState(readArrangement);
  const width = useViewportWidth();
  const arrangement = arrangementFor(width, choice);
  const phone = arrangement === "phone";
  const read = useAccount(refresh);

  // on the document as well as the page, as the book does: the phone's 44pt targets are set there
  useEffect(() => {
    document.documentElement.dataset.nxArrangement = arrangement;
    return () => { delete document.documentElement.dataset.nxArrangement; };
  }, [arrangement]);

  const choose = (value: string) => {
    const chosen = value === "off" ? null : ACCOUNT_REFRESHES.find((s) => String(s) === value) ?? null;
    writeAccountRefresh(chosen);
    setRefresh(chosen);
  };

  return (
    <div className="nx nx-acct" data-arrangement={arrangement} data-up={up}>
      <header className="nx-head">
        <a href={bookHref(base)} aria-label="back to the book" data-slot="button"
           className={buttonVariants({ variant: "ghost", size: "sm" })}>
          <ArrowLeft />
        </a>
        <h1>Account</h1>
        <span className="nx-spacer" />
        <Button variant="ghost" size="sm" aria-label="refresh now" disabled={read.refreshing}
                onClick={() => void read.refreshNow()}>
          <RefreshCw className={read.refreshing ? "animate-spin" : undefined} />
        </Button>
      </header>

      <main className="nx-main">
        <div className="nx-acct-cadence nx-meta">
          <label htmlFor="nx-acct-refresh">refresh every</label>
          <NativeSelect id="nx-acct-refresh" size="sm" value={refresh === null ? "off" : String(refresh)}
                        onChange={(e) => choose(e.target.value)}>
            {ACCOUNT_REFRESHES.map((s) => <NativeSelectOption key={s} value={String(s)}>{CADENCE_WORDS[s]}</NativeSelectOption>)}
            <NativeSelectOption value="off">off</NativeSelectOption>
          </NativeSelect>
        </div>
        {read.error !== null ? (
          <div className="nx-banner" role="alert">
            {"the account could not be read — "}
            <ErrorWords raw={read.error} again={refresh === null ? "try again" : "tried again at the next refresh"} />
          </div>
        ) : null}
        {read.account === null ? (
          read.error === null ? <p className="nx-meta">reading the account…</p> : null
        ) : (
          <>
            {/* a refresh that failed after a good read: its figures kept, dimmed, saying when (the
                owner, 2026-11-23) — only a first read that fails draws none */}
            {read.error !== null ? <p className="nx-meta nx-acct-asof">{`as of ${fetchedWords(read.account.read_at)}`}</p> : null}
            <AccountView account={read.account} phone={phone} privacy={privacy} stale={read.error !== null} />
          </>
        )}
      </main>
    </div>
  );
}
