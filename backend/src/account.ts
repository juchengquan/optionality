/** The IBKR account, held while it is asked (ADR 0031, #477): the service behind `GET /account`,
 *  paired with `routes/account.ts`.
 *
 *  The watch itself is the library's (`IbkrClient.watchAccount`), reached through the IB vendor's
 *  descriptor as an `AccountSource`, which has already sorted every way a start can end. What is
 *  decided here is the rest:
 *
 *    - **which account**: `.env`'s `IBKR_ACCOUNT`, blank meaning unset, handed to the library as its
 *      `wanted` — the library chooses, and refuses where it cannot, every id masked;
 *    - **the hold**: the first read starts the watch and waits for its first picture, every caller
 *      meanwhile joining that wait; every read renews the hold, which is released
 *      `ACCOUNT_HELD_FOR_MS` after the last — the watch stopped and nothing kept — and a read after
 *      that starts afresh. A read is answered from the picture in memory, asking IB Gateway nothing.
 *      Never started by the service and never read by the sweep, the bot or the MCP door: a request
 *      is the only thing that holds it. A start that fails holds nothing, and is remembered for
 *      `ACCOUNT_FAILED_FOR_MS`: no start is tried in that time, whoever asks, and a read is told
 *      what the last one came to;
 *    - **a lost connection**: while held, a watch whose connection closed is a 502 in words until
 *      it is back. It is watched again at the next read, and whenever the client answers anything
 *      else (its connection back), never at the moment it is lost; a lost watch is dropped, never
 *      stopped: the loss has already ended it in the library, so a stop would send nothing;
 *    - **the answer**: the picture, stocks (`STK`) and options (`OPT`) apart and everything else
 *      under `other` with only what the page lists of it (the owner's decision on #470); the totals'
 *      P&L from the account's P&L stream once it has spoken, and the account updates' until then or
 *      where it left one unset; when that stream last spoke (`live`), and when the service answered
 *      (`read_at`, the owner's decision on #480: the time of the answer, not of a read from IB);
 *    - **the status** each failure is: a vendor not configured 503 (the owner's decision on #473),
 *      a vendor down, refusing the session or lost 502, a refusal to choose an account 422.
 *
 *  Nothing is stored: the picture lives in the library's watch for the hold and is gone.
 */
import { displayTime } from "optionality/domain/timefmt";
import type { ibkrFields } from "optionality/vendors/fields";

import type { AccountSource, AccountWatch, AccountWatching, IbkrLiveAccount, IbkrLiveHolding } from "./ports.ts";

/** How long the account is held after the last read: 90 s, the owner's decision on #477 — sized for
 *  the page's refresh options as #478 sets them, a minute at the slowest, so every refresh keeps it;
 *  a slower refresh (main's 3 min until #478 lands) starts a fresh watch on each refresh. */
export const ACCOUNT_HELD_FOR_MS = 90_000;

/** How long a start that failed is remembered, from when it came back: 5 s, the owner's decision on
 *  #477 — while IB Gateway is down or logged out the service tries to start the watch at most once
 *  in that time, whoever asks, and every read meanwhile is told what the last try came to. */
export const ACCOUNT_FAILED_FOR_MS = 5_000;

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
/** The words for a held watch whose connection closed, until it is back — and for a watch again
 *  that failed, whatever its own words, which go to the log. */
export const LOST = "The connection to IB Gateway was lost";

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
  totals: ibkrFields.IbkrTotals & { daily_pnl: number | null };
  exchange_rates: Record<string, number>;
  stocks: IbkrLiveHolding[];
  options: IbkrLiveHolding[];
  other: OtherHolding[];
  /** when the account's P&L stream last spoke, in the display zone; null before it first speaks */
  live: { updated_at: string } | null;
}

export interface AccountFault {
  status: 422 | 502 | 503;
  message: string;
}

export type AccountResult = { answer: AccountAnswer } | { fault: AccountFault };

/** Wake `fn` in `ms`, answering how to cancel it. */
export type Wake = (ms: number, fn: () => void) => () => void;

/** A real timer that keeps no process alive on its own. */
const realWake: Wake = (ms, fn) => {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
};

export interface AccountDeps {
  /** null where IB Gateway is not configured */
  source: AccountSource | null;
  /** `.env`'s `IBKR_ACCOUNT`, as written: blank is unset */
  wanted: string;
  now(): Date;
  displayTz: string;
  /** the release's timer; a real one unless a test says otherwise. It only WAKES the hold, which
   *  asks `now` whether the 90 s are up, so the clock stays the one injected. */
  wake?: Wake;
}

/** The picture as the route serves it, answered at `at`. */
export function accountAnswer(picture: IbkrLiveAccount, at: Date, displayTz: string): AccountAnswer {
  const { holdings, pnl, totals } = picture;
  return {
    account: picture.account,
    paper: picture.paper,
    base_currency: picture.base_currency,
    updated_at: picture.updated_at,
    read_at: displayTime(at, displayTz)!,
    totals: {
      net_liquidation: totals.net_liquidation,
      total_cash: totals.total_cash,
      // the P&L stream's once it has spoken, and a figure it left unset the account update's, as a
      // holding's is (the owner's decision on #480): null only where neither has one, and the
      // account updates carry no daily figure
      unrealized_pnl: pnl?.unrealized_pnl ?? totals.unrealized_pnl,
      realized_pnl: pnl?.realized_pnl ?? totals.realized_pnl,
      daily_pnl: pnl?.daily_pnl ?? null,
    },
    exchange_rates: picture.exchange_rates,
    stocks: holdings.filter((h) => h.sec_type === "STK"),
    options: holdings.filter((h) => h.sec_type === "OPT"),
    other: holdings.filter((h) => h.sec_type !== "STK" && h.sec_type !== "OPT").map((h) => ({
      sec_type: h.sec_type, symbol: h.symbol, position: h.position, market_value: h.market_value,
      currency: h.currency,
    })),
    live: picture.pnl_at === null ? null : { updated_at: displayTime(new Date(picture.pnl_at), displayTz)! },
  };
}

/** What a start that is not a watch says, and with which status: the page is told a refused session
 *  in the gateway's words and anything else unreachable as a gateway that did not answer — the
 *  connect's own words are the log's. Neither carries an account id: none is known before a
 *  session. */
function faultOf(started: Exclude<AccountWatching, { watch: unknown }>): AccountFault {
  if ("unreachable" in started) {
    const refused = started.unreachable.startsWith(REFUSED_SESSION);
    return { status: 502, message: refused ? started.unreachable : NOT_ANSWERING };
  }
  if ("refused" in started) return { status: 422, message: started.refused };
  return { status: 502, message: started.failed };
}

function wordsOf(started: Exclude<AccountWatching, { watch: unknown }>): string {
  return "unreachable" in started ? started.unreachable : "refused" in started ? started.refused : started.failed;
}

/** The account held now. */
interface Hold {
  /** the last read, by `now` */
  lastRead: number;
  /** the first start, which every read before it ends joins: the watch, or what the page is told */
  first: Promise<{ watch: AccountWatch } | { fault: AccountFault }>;
  /** the watch, once the first start has given one; replaced by each watch again that works */
  watch: AccountWatch | null;
  /** whether a watch again is in flight */
  again: boolean;
  cancelWake: () => void;
}

/** One per app, so every caller — today the page alone — reads the one hold.
 *
 *  The library refuses a SECOND watch on one client with a plain `Error` ("this client already holds
 *  a watch of …; stop it first"), which the descriptor sorts as a start that `failed`: a 502 in the
 *  library's words, remembered like any failed start — never a 500. The hold almost never meets it,
 *  because it never starts a watch while the library holds one: a release stops its watch first, and
 *  a stop forgets the watch at once, before anything is sent; a watch again starts only once the
 *  held watch is lost, which the library has forgotten too. The one window is a release while a
 *  start is still in flight (the timer, or the client answering, at the 90 s), followed at once by a
 *  read: that read's start is refused as above, and the start in flight, when it ends, finds the hold
 *  gone and is stopped. The library's other plain refusal — the account read finding a watch of
 *  another account — cannot reach here: the service reads the account only through the watch, and
 *  `IBKR_ACCOUNT` is fixed for the life of the process. */
export class AccountBook {
  private readonly deps: AccountDeps;
  private hold: Hold | null = null;
  /** the last start that failed — a first start or a watch again — and when it came back */
  private failed: { fault: AccountFault; at: number } | null = null;

  constructor(deps: AccountDeps) {
    this.deps = deps;
    deps.source?.onAnswered(() => this.clientAnswered());
  }

  async read(): Promise<AccountResult> {
    const { source, now, displayTz } = this.deps;
    if (source === null) return { fault: { status: 503, message: NOT_CONFIGURED } };
    const t = now().getTime();
    let hold = this.hold;
    if (hold !== null && this.expired(hold, t)) {
      this.release(hold);
      hold = null;
    }
    if (hold === null) {
      const remembered = this.recentlyFailed(t);
      if (remembered !== null) return { fault: remembered };
      hold = this.begin(source, t);
    } else {
      hold.lastRead = t;
    }

    let watch = hold.watch;
    if (watch === null) {
      const first = await hold.first;
      if ("fault" in first) return first;
      watch = first.watch;
    }
    if (watch.lost !== null) {
      this.watchAgain(hold);
      return { fault: { status: 502, message: LOST } };
    }
    return { answer: accountAnswer(watch.picture(), now(), displayTz) };
  }

  private wanted(): string | null {
    return this.deps.wanted.trim() || null;
  }

  /** What the last start that failed came to, while it is under `ACCOUNT_FAILED_FOR_MS` old; a
   *  clock that went back trusts nothing old. */
  private recentlyFailed(t: number): AccountFault | null {
    const failed = this.failed;
    if (failed === null) return null;
    const age = t - failed.at;
    if (age >= 0 && age < ACCOUNT_FAILED_FOR_MS) return failed.fault;
    this.failed = null;
    return null;
  }

  /** A start that failed, remembered from now; the connect's own words to the log. */
  private remember(started: Exclude<AccountWatching, { watch: unknown }>, log: string): AccountFault {
    console.error(`IBKR account: ${log}${wordsOf(started)}`);
    const fault = faultOf(started);
    this.failed = { fault, at: this.deps.now().getTime() };
    return fault;
  }

  /** 90 s since the last read; a clock that went back is a read now, never a hold expired. */
  private expired(hold: Hold, t: number): boolean {
    return t - hold.lastRead >= ACCOUNT_HELD_FOR_MS;
  }

  private begin(source: AccountSource, t: number): Hold {
    // eslint-disable-next-line prefer-const -- the start's callbacks run after it is assigned
    let hold: Hold;
    const first = source.watch(this.wanted()).then((started): { watch: AccountWatch } | { fault: AccountFault } => {
      if (!("watch" in started)) {
        // a start that failed holds nothing, and is remembered: the next read after
        // `ACCOUNT_FAILED_FOR_MS` starts afresh
        this.drop(hold);
        return { fault: this.remember(started, "") };
      }
      this.failed = null;
      this.took(hold, started.watch);
      return started;
    }, (err: unknown) => {
      // a source that throws breaks its own promise (`AccountSource`): that is a bug, a 500, and
      // never held — the next caller starts again
      this.drop(hold);
      throw err;
    });
    hold = { lastRead: t, first, watch: null, again: false, cancelWake: () => {} };
    this.hold = hold;
    this.sleep(hold, ACCOUNT_HELD_FOR_MS);
    return hold;
  }

  /** A watch a start gave `hold`: kept while the hold is, stopped where it was released meanwhile. */
  private took(hold: Hold, watch: AccountWatch): void {
    if (this.hold !== hold) {
      this.stop(watch);
      return;
    }
    hold.watch = watch;
    watch.onLost((err) => console.error(`IBKR account: the watch was lost: ${err.message}`));
  }

  /** Start the watch again, under a hold whose watch was lost: one at a time, and not within
   *  `ACCOUNT_FAILED_FOR_MS` of a start that failed. */
  private watchAgain(hold: Hold): void {
    const { source, now } = this.deps;
    if (hold.again || source === null || this.recentlyFailed(now().getTime()) !== null) return;
    hold.again = true;
    source.watch(this.wanted()).then((started) => {
      hold.again = false;
      if (!("watch" in started)) {
        this.remember(started, "watching again failed: ");
        return;
      }
      this.failed = null;
      this.took(hold, started.watch);
    }, (err: unknown) => {
      hold.again = false;
      console.error(`IBKR account: watching again failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /** The client answered something else: while the held watch is lost, its connection is back. */
  private clientAnswered(): void {
    const hold = this.hold;
    if (hold === null || hold.watch === null || hold.watch.lost === null) return;
    if (this.expired(hold, this.deps.now().getTime())) {
      this.release(hold);
      return;
    }
    this.watchAgain(hold);
  }

  /** Wake in `ms` and release the hold if the 90 s are up by then, else sleep the rest. */
  private sleep(hold: Hold, ms: number): void {
    const wake = this.deps.wake ?? realWake;
    hold.cancelWake = wake(ms, () => {
      if (this.hold !== hold) return;
      const age = this.deps.now().getTime() - hold.lastRead;
      if (age >= ACCOUNT_HELD_FOR_MS) this.release(hold);
      else this.sleep(hold, ACCOUNT_HELD_FOR_MS - Math.max(age, 0));
    });
  }

  /** Let it all go: the watch stopped, unless it was lost (the loss ended it already), and nothing
   *  kept. A start still in flight finds the hold gone and stops what it brings. */
  private release(hold: Hold): void {
    this.drop(hold);
    if (hold.watch !== null && hold.watch.lost === null) this.stop(hold.watch);
  }

  private drop(hold: Hold): void {
    if (this.hold === hold) this.hold = null;
    hold.cancelWake();
  }

  private stop(watch: AccountWatch): void {
    watch.stop().catch((err: unknown) => {
      console.error(`IBKR account: stopping the watch failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}
