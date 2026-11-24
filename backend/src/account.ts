/** The IBKR account, read on demand and shared (ADR 0030, #470): the service behind `GET /account`,
 *  paired with `routes/account.ts`.
 *
 *  The read itself is the library's (`IbkrClient.account`), reached through the IB vendor's
 *  descriptor as a `ReadAccount`, which has already sorted every way a read can end. What is decided
 *  here is the rest:
 *
 *    - **which account**: `.env`'s `IBKR_ACCOUNT`, blank meaning unset, handed to the library as its
 *      `wanted` — the library chooses, and refuses where it cannot, every id masked;
 *    - **the sharing**: ONE read for every caller for `ACCOUNT_SHARED_FOR_MS`, counted from when it
 *      came back; a read in flight is joined, and a failure is shared like an answer, so a page
 *      refreshing often — or a gateway that is down — costs IB Gateway one read per window. Never
 *      polled by the service and never read by the sweep: a request is the only thing that reads;
 *    - **the answer**: the library's, stocks (`STK`) and options (`OPT`) apart and everything else
 *      under `other` with only what the page lists of it (the owner's decision on #470), and when
 *      the service read it;
 *    - **the status** each failure is: a vendor not configured 503 (the owner's decision on #473),
 *      a vendor down or refusing the session 502, a refusal to choose an account 422.
 *
 *  Nothing is stored: the answer lives in this object for the window and is gone.
 */
import { displayTime } from "optionality/domain/timefmt";
import type { ibkrFields } from "optionality/vendors/fields";

import type { AccountReading, ReadAccount } from "./ports.ts";

type IbkrHolding = ibkrFields.IbkrHolding;

/** How long one read is shared by every caller, from when it came back: 10 s, the owner's decision on
 *  #470 — under the page's 15 s refresh, so each refresh reads afresh, while two tabs, or a refresh
 *  beside a write's re-read, share one. */
export const ACCOUNT_SHARED_FOR_MS = 10_000;

/** The words for a build with no IB Gateway (`IBKR_HOST` blank). */
export const NOT_CONFIGURED = "IB Gateway is not configured";
/** The words for a gateway that could not be reached: down, or at its login screen, where its API
 *  port is shut. The connect's own words go to the log, not to the page. */
export const NOT_ANSWERING = "IB Gateway did not answer — is it running and logged in?";
/** How the library begins the words for a session the gateway refused (`socket.ts`, `ibkr.py`): it
 *  answered, and said why — a client id already in use is the one met — so the page is told that,
 *  in those words, rather than to start a gateway that is running. Held to the library's own words
 *  by `vendors/ibkr/vendor.test.ts`, against its `client-id-in-use` recording. */
export const REFUSED_SESSION = "IB Gateway refused the session:";

/** A holding that is neither a stock nor an option, with only what the page lists of it. */
export interface OtherHolding {
  sec_type: string;
  symbol: string;
  position: number | null;
  market_value: number | null;
  currency: string;
}

/** What `GET /account` answers. */
export interface AccountAnswer {
  account: string;
  paper: boolean;
  base_currency: string | null;
  updated_at: string | null;
  read_at: string;
  totals: ibkrFields.IbkrTotals;
  exchange_rates: Record<string, number>;
  stocks: IbkrHolding[];
  options: IbkrHolding[];
  other: OtherHolding[];
}

export interface AccountFault {
  status: 422 | 502 | 503;
  message: string;
}

export type AccountResult = { answer: AccountAnswer } | { fault: AccountFault };

export interface AccountDeps {
  /** null where IB Gateway is not configured */
  read: ReadAccount | null;
  /** `.env`'s `IBKR_ACCOUNT`, as written: blank is unset */
  wanted: string;
  now(): Date;
  displayTz: string;
}

/** The library's answer as the route serves it, read at `at`. */
export function accountAnswer(account: ibkrFields.IbkrAccount, at: Date, displayTz: string): AccountAnswer {
  const { holdings, ...rest } = account;
  return {
    ...rest,
    read_at: displayTime(at, displayTz)!,
    stocks: holdings.filter((h) => h.sec_type === "STK"),
    options: holdings.filter((h) => h.sec_type === "OPT"),
    other: holdings.filter((h) => h.sec_type !== "STK" && h.sec_type !== "OPT").map((h) => ({
      sec_type: h.sec_type, symbol: h.symbol, position: h.position, market_value: h.market_value,
      currency: h.currency,
    })),
  };
}

/** What a reading that is not an account says, and with which status. Where no session was had,
 *  the connect's own words are logged, once per read; the page is told a refused session in the
 *  gateway's words and anything else as a gateway that did not answer. Neither carries an account id:
 *  none is known before a session. */
function faultOf(reading: Exclude<AccountReading, { account: unknown }>): AccountFault {
  if ("unreachable" in reading) {
    console.error(`IBKR account: ${reading.unreachable}`);
    const refused = reading.unreachable.startsWith(REFUSED_SESSION);
    return { status: 502, message: refused ? reading.unreachable : NOT_ANSWERING };
  }
  if ("refused" in reading) return { status: 422, message: reading.refused };
  return { status: 502, message: reading.failed };
}

/** One per app, so every caller — today the page alone — shares its read. */
export class AccountBook {
  private readonly deps: AccountDeps;
  /** the read shared now: in flight while `at` is null, then its result until the window passes */
  private shared: { result: Promise<AccountResult>; at: number | null } | null = null;

  constructor(deps: AccountDeps) {
    this.deps = deps;
  }

  read(): Promise<AccountResult> {
    const { read, wanted, now, displayTz } = this.deps;
    if (read === null) return Promise.resolve({ fault: { status: 503, message: NOT_CONFIGURED } });
    const t = now().getTime();
    const held = this.shared;
    if (held !== null && held.at !== null) {
      // a clock that went BACK trusts nothing old
      const age = t - held.at;
      if (age < 0 || age >= ACCOUNT_SHARED_FOR_MS) this.shared = null;
    }
    if (this.shared !== null) return this.shared.result;

    const entry: { result: Promise<AccountResult>; at: number | null } = {
      at: null,
      result: read(wanted.trim() || null).then((reading) => {
        const at = now();
        entry.at = at.getTime();
        return "account" in reading
          ? { answer: accountAnswer(reading.account, at, displayTz) }
          : { fault: faultOf(reading) };
      }, (err: unknown) => {
        // a reader that throws breaks its own promise (`ReadAccount`): that is a bug, a 500, and
        // never shared — the next caller reads again
        if (this.shared === entry) this.shared = null;
        throw err;
      }),
    };
    this.shared = entry;
    return entry.result;
  }
}
