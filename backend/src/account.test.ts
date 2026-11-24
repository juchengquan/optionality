/** The IBKR account behind `GET /account` (ADR 0031, #477): what a start comes to, the answer from
 *  the watch's picture, and the hold — started by the first read, renewed by every read, released
 *  `ACCOUNT_HELD_FOR_MS` (90 s) after the last, and watched again after its connection is lost. */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ibkrFields } from "optionality/vendors/fields";

import {
  ACCOUNT_FAILED_FOR_MS, ACCOUNT_HELD_FOR_MS, AccountBook, LOST, NOT_ANSWERING, NOT_CONFIGURED,
} from "./account.ts";
import type {
  AccountSource, AccountWatch, AccountWatching, IbkrLiveAccount, IbkrLiveHolding, IbkrPnl,
} from "./ports.ts";

/** The hold, stated rather than imported, so the number itself is held: 90 s, the owner's decision
 *  on #477 — the page's slowest refresh is a minute, so every refresh keeps it. */
const HELD_MS = 90_000;
/** How long a failed start is remembered, stated for the same reason: 5 s, the owner's decision on
 *  #477 — at most one try in that time while IB Gateway is down, whoever asks. */
const FAILED_MS = 5_000;

const NOW = new Date("2026-11-23T15:00:00.000Z");

const holding = (over: Partial<IbkrLiveHolding>): IbkrLiveHolding => ({
  sec_type: "STK", symbol: "ACME", currency: "USD", expiry: null, strike: null, right: null,
  multiplier: null, position: 100, market_price: 41.25, market_value: 4125, average_cost: 38.5,
  unrealized_pnl: 275, realized_pnl: 0, daily_pnl: 62.5, ...over,
});

const STOCK = holding({});
const OPTION = holding({
  sec_type: "OPT", expiry: "20261218", strike: 45, right: "C", multiplier: 100, position: -2,
  market_price: 1.5, market_value: -300, average_cost: 2.25, daily_pnl: null,
});
const FUTURE = holding({
  sec_type: "FUT", symbol: "ES", expiry: "20261218", multiplier: 50, position: 1, market_value: 0,
});
const CASH = holding({ sec_type: "CASH", symbol: "EUR.USD", currency: "USD", position: 1200, market_value: 1290 });

const TOTALS: ibkrFields.IbkrTotals = {
  net_liquidation: 184523.17, total_cash: 61230.55, unrealized_pnl: 2071.4, realized_pnl: -412.8,
};
const PNL: IbkrPnl = { daily_pnl: 318.25, unrealized_pnl: 2104.6, realized_pnl: -398.15 };

/** A picture whose P&L stream has not spoken yet. */
const QUIET: IbkrLiveAccount = {
  account: "masked-by-the-library", paper: false, base_currency: "USD", updated_at: "14:32",
  totals: TOTALS, exchange_rates: { USD: 1, EUR: 1.075 },
  holdings: [STOCK, FUTURE, OPTION, CASH], pnl: null, pnl_at: null,
};
/** The same, the P&L stream having spoken 4 s before NOW. */
const LIVE: IbkrLiveAccount = { ...QUIET, pnl: PNL, pnl_at: NOW.getTime() - 4000 };

/** A watch the test controls: its picture, its loss, and whether it was stopped. */
class FakeWatch implements AccountWatch {
  account: IbkrLiveAccount;
  lost: Error | null = null;
  stopped = 0;
  private readonly listeners: ((err: Error) => void)[] = [];
  constructor(account: IbkrLiveAccount) { this.account = account; }
  picture() { return structuredClone(this.account); }
  onLost(listener: (err: Error) => void) { this.listeners.push(listener); }
  stop() { this.stopped += 1; return Promise.resolve(); }
  lose(words = "IB Gateway closed the connection") {
    this.lost = new Error(words);
    for (const l of this.listeners) l(this.lost);
  }
}

/** A source answering each start with the next of `answers` (the last repeating) — a picture is a
 *  new watch on it — counting what it was asked, settling when told to. */
function source(...answers: (IbkrLiveAccount | Exclude<AccountWatching, { watch: unknown }>)[]) {
  const asked: (string | null)[] = [];
  const watches: FakeWatch[] = [];
  const pending: (() => void)[] = [];
  const answeredListeners: (() => void)[] = [];
  let hold = false;
  const next = (n: number): AccountWatching => {
    const a = answers[Math.min(n, answers.length - 1)] ?? LIVE;
    if ("unreachable" in a || "refused" in a || "failed" in a) return a;
    const w = new FakeWatch(a as IbkrLiveAccount);
    watches.push(w);
    return { watch: w };
  };
  const s: AccountSource = {
    watch(wanted) {
      const n = asked.push(wanted) - 1;
      if (!hold) return Promise.resolve(next(n));
      return new Promise((resolve) => pending.push(() => resolve(next(n))));
    },
    onAnswered(listener) { answeredListeners.push(listener); },
  };
  return {
    source: s, asked, watches,
    holding() { hold = true; },
    release() { hold = false; for (const go of pending.splice(0)) go(); },
    /** the client answered something else: a price read that worked */
    answered() { for (const l of answeredListeners) l(); },
  };
}

/** Timers the test fires by hand. */
function timers() {
  const set: { ms: number; fn: () => void; live: boolean }[] = [];
  return {
    set,
    wake: (ms: number, fn: () => void) => {
      const t = { ms, fn, live: true };
      set.push(t);
      return () => { t.live = false; };
    },
    /** fire every timer still set */
    fire() { for (const t of set.splice(0)) if (t.live) t.fn(); },
    live() { return set.filter((t) => t.live); },
  };
}

function book(s: AccountSource | null, over: { wanted?: string } = {}) {
  const clock = { now: NOW };
  const t = timers();
  const b = new AccountBook({
    source: s, wanted: over.wanted ?? "", now: () => clock.now, displayTz: "Asia/Singapore", wake: t.wake,
  });
  return { book: b, clock, timers: t };
}

const at = (ms: number) => new Date(NOW.getTime() + ms);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

let quiet: ReturnType<typeof vi.spyOn> | undefined;
afterEach(() => { quiet?.mockRestore(); quiet = undefined; });
const hush = () => { quiet = vi.spyOn(console, "error").mockImplementation(() => {}); return quiet; };

describe("the answer, from the watch's picture", () => {
  it("answers the account, stocks and options apart, P&L from the stream, and when it last spoke", async () => {
    const result = await book(source(LIVE).source).book.read();
    expect(result).toEqual({
      answer: {
        account: "masked-by-the-library", paper: false, base_currency: "USD", updated_at: "14:32",
        read_at: "2026-11-23 23:00:00+08:00",
        // the P&L stream's once it has spoken; net liquidation and cash the account updates'
        totals: {
          net_liquidation: 184523.17, total_cash: 61230.55, unrealized_pnl: 2104.6, realized_pnl: -398.15,
          daily_pnl: 318.25,
        },
        exchange_rates: { USD: 1, EUR: 1.075 },
        stocks: [STOCK],
        options: [OPTION],
        other: [
          { sec_type: "FUT", symbol: "ES", position: 1, market_value: 0, currency: "USD" },
          { sec_type: "CASH", symbol: "EUR.USD", position: 1200, market_value: 1290, currency: "USD" },
        ],
        live: { updated_at: "2026-11-23 22:59:56+08:00" },
      },
    });
  });

  it("takes the totals' P&L from the account updates until the stream has spoken, and says it has not", async () => {
    const result = await book(source(QUIET).source).book.read();
    expect(result).toMatchObject({
      answer: {
        totals: { unrealized_pnl: 2071.4, realized_pnl: -412.8, daily_pnl: null },
        live: null,
      },
    });
  });

  it("takes a total the stream sent unset from the account update, null only where neither has one", async () => {
    // the owner's decision on #480, as a holding's unset figure is the account update's (#476)
    const unset: IbkrLiveAccount = {
      ...LIVE,
      totals: { ...TOTALS, realized_pnl: null },
      pnl: { daily_pnl: null, unrealized_pnl: null, realized_pnl: null },
    };
    expect(await book(source(unset).source).book.read()).toMatchObject({
      // the account updates carry no daily figure: null
      answer: { totals: { daily_pnl: null, unrealized_pnl: 2071.4, realized_pnl: null } },
    });
  });

  it("answers the picture as it stands at each read", async () => {
    const s = source(LIVE);
    const { book: b, clock } = book(s.source);
    await b.read();
    s.watches[0]!.account = { ...LIVE, pnl: { ...PNL, daily_pnl: 400 }, pnl_at: at(2000).getTime() };
    clock.now = at(3000);
    expect(await b.read()).toMatchObject({
      answer: {
        read_at: "2026-11-23 23:00:03+08:00", totals: { daily_pnl: 400 },
        live: { updated_at: "2026-11-23 23:00:02+08:00" },
      },
    });
  });
});

describe("what a start comes to", () => {
  it("asks for the login's only account where IBKR_ACCOUNT is blank or spaces", async () => {
    const s = source();
    await book(s.source, { wanted: "  " }).book.read();
    expect(s.asked).toEqual([null]);
  });

  it("asks for the account IBKR_ACCOUNT names, trimmed", async () => {
    const s = source();
    await book(s.source, { wanted: " U0000001 " }).book.read();
    expect(s.asked).toEqual(["U0000001"]);
  });

  it("trims IBKR_ACCOUNT as JavaScript does, so a control character is asked for", async () => {
    const s = source();
    await book(s.source, { wanted: "\x1f" }).book.read();
    expect(s.asked).toEqual(["\x1f"]);
  });

  it("is a 503 where IB Gateway is not configured, and starts nothing", async () => {
    expect(await book(null).book.read()).toEqual({ fault: { status: 503, message: NOT_CONFIGURED } });
    expect(NOT_CONFIGURED).toBe("IB Gateway is not configured");
  });

  it("is a 502 in the issue's words where the gateway does not answer, the connect's words logged", async () => {
    const log = hush();
    const words = "could not reach IB Gateway at 127.0.0.1:4001: connect ECONNREFUSED 127.0.0.1:4001";
    expect(await book(source({ unreachable: words }).source).book.read())
      .toEqual({ fault: { status: 502, message: NOT_ANSWERING } });
    expect(NOT_ANSWERING).toBe("IB Gateway did not answer — is it running and logged in?");
    expect(log).toHaveBeenCalledWith(`IBKR account: ${words}`);
  });

  it("is a 502 in the gateway's own words where it refused the session", async () => {
    hush();
    const words = "IB Gateway refused the session: 326 Unable to connect as the client id is already in use. "
      + "Retry with a unique client id.";
    expect(await book(source({ unreachable: words }).source).book.read())
      .toEqual({ fault: { status: 502, message: words } });
  });

  it("is a 502 in the library's words where the first picture did not come", async () => {
    const words = "IB Gateway did not finish sending the account within 8000ms";
    expect(await book(source({ failed: words }).source).book.read())
      .toEqual({ fault: { status: 502, message: words } });
  });

  it("is a 422 in the library's words where it would not choose an account", async () => {
    const words = "several accounts on this login; set IBKR_ACCOUNT to one of <the masked ids>";
    expect(await book(source({ refused: words }).source).book.read())
      .toEqual({ fault: { status: 422, message: words } });
  });

  it("holds nothing after a start that failed: the first read 5 s on starts afresh", async () => {
    hush();
    const s = source({ failed: "did not finish" }, LIVE);
    const { book: b, clock, timers: t } = book(s.source);
    await b.read();
    expect(t.live()).toEqual([]);
    clock.now = at(FAILED_MS);
    expect(await b.read()).toHaveProperty("answer");
    expect(s.asked).toHaveLength(2);
  });

  it("remembers a failed start for 5 s: every read inside them is told the same, nothing started", async () => {
    hush();
    const s = source({ unreachable: "connect ECONNREFUSED" }, LIVE);
    const { book: b, clock } = book(s.source);
    const first = await b.read();
    expect(first).toEqual({ fault: { status: 502, message: NOT_ANSWERING } });
    clock.now = at(FAILED_MS - 1);
    expect(await b.read()).toEqual(first);
    expect(s.asked).toHaveLength(1);
    expect(ACCOUNT_FAILED_FOR_MS).toBe(FAILED_MS);
  });

  it("counts the 5 s from when the failed start came back, not from when it was asked", async () => {
    hush();
    const s = source({ failed: "did not finish" }, LIVE);
    s.holding();
    const { book: b, clock } = book(s.source);
    const first = b.read();
    clock.now = at(3000);
    s.release();
    await first;
    clock.now = at(3000 + FAILED_MS - 1);
    await b.read();
    expect(s.asked).toHaveLength(1);
    clock.now = at(3000 + FAILED_MS);
    expect(await b.read()).toHaveProperty("answer");
    expect(s.asked).toHaveLength(2);
  });

  it("remembers a refusal the same way, in its words", async () => {
    hush();
    const words = "several accounts on this login; set IBKR_ACCOUNT to one of <the masked ids>";
    const s = source({ refused: words });
    const { book: b, clock } = book(s.source);
    await b.read();
    clock.now = at(1000);
    expect(await b.read()).toEqual({ fault: { status: 422, message: words } });
    expect(s.asked).toHaveLength(1);
  });

  it("trusts no failure it remembers when the clock has gone back", async () => {
    hush();
    const s = source({ failed: "did not finish" }, LIVE);
    const { book: b, clock } = book(s.source);
    await b.read();
    clock.now = at(-1);
    expect(await b.read()).toHaveProperty("answer");
    expect(s.asked).toHaveLength(2);
  });

  it("starts afresh after a source that threw, rather than holding a rejection for ever", async () => {
    let calls = 0;
    const s: AccountSource = {
      watch: () => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error("a bug")) : Promise.resolve({ watch: new FakeWatch(LIVE) });
      },
      onAnswered: () => {},
    };
    const { book: b } = book(s);
    await expect(b.read()).rejects.toThrow("a bug");
    expect(await b.read()).toHaveProperty("answer");
  });
});

describe("the hold", () => {
  it("answers every read inside the hold from the one watch, with no start", async () => {
    const s = source(LIVE);
    const { book: b, clock } = book(s.source);
    await b.read();
    clock.now = at(HELD_MS - 1);
    expect(await b.read()).toHaveProperty("answer");
    expect(s.asked).toHaveLength(1);
    expect(ACCOUNT_HELD_FOR_MS).toBe(HELD_MS);
  });

  it("is renewed by every read: 90 s after the LAST read, not the first", async () => {
    const s = source(LIVE);
    const { book: b, clock } = book(s.source);
    await b.read();
    clock.now = at(60_000);
    await b.read();
    clock.now = at(60_000 + HELD_MS - 1);
    await b.read();
    expect(s.asked).toHaveLength(1);
    expect(s.watches[0]!.stopped).toBe(0);
  });

  it("joins a start in flight rather than starting twice", async () => {
    const s = source(LIVE);
    s.holding();
    const { book: b } = book(s.source);
    const both = Promise.all([b.read(), b.read()]);
    s.release();
    const [one, two] = await both;
    expect(one).toEqual(two);
    expect(one).toHaveProperty("answer");
    expect(s.asked).toHaveLength(1);
  });

  it("joins a failed start too, logging its words once", async () => {
    const log = hush();
    const s = source({ unreachable: "connect ECONNREFUSED" });
    s.holding();
    const { book: b } = book(s.source);
    const both = Promise.all([b.read(), b.read()]);
    s.release();
    expect(await both).toEqual([
      { fault: { status: 502, message: NOT_ANSWERING } }, { fault: { status: 502, message: NOT_ANSWERING } },
    ]);
    expect(s.asked).toHaveLength(1);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("is released 90 s after the last read: the watch is stopped and nothing is kept", async () => {
    const s = source(LIVE);
    const { book: b, clock, timers: t } = book(s.source);
    await b.read();
    expect(t.live().map((x) => x.ms)).toEqual([HELD_MS]);
    clock.now = at(HELD_MS);
    t.fire();
    expect(s.watches[0]!.stopped).toBe(1);
    expect(t.live()).toEqual([]);
    // a read after the release starts afresh
    await b.read();
    expect(s.asked).toHaveLength(2);
  });

  it("when its timer wakes before the 90 s are up — a read renewed it — it sleeps the rest", async () => {
    const s = source(LIVE);
    const { book: b, clock, timers: t } = book(s.source);
    await b.read();
    clock.now = at(30_000);
    await b.read();
    clock.now = at(HELD_MS);
    t.fire();
    expect(s.watches[0]!.stopped).toBe(0);
    expect(t.live().map((x) => x.ms)).toEqual([30_000]);
    clock.now = at(30_000 + HELD_MS);
    t.fire();
    expect(s.watches[0]!.stopped).toBe(1);
  });

  it("releases at a read that finds the 90 s passed, should the timer not have woken", async () => {
    const s = source(LIVE);
    const { book: b, clock } = book(s.source);
    await b.read();
    clock.now = at(HELD_MS);
    await b.read();
    expect(s.watches[0]!.stopped).toBe(1);
    expect(s.asked).toHaveLength(2);
    expect(s.watches[1]!.stopped).toBe(0);
  });

  it("takes a clock that went back as a read now, not as a hold expired", async () => {
    const s = source(LIVE);
    const { book: b, clock } = book(s.source);
    await b.read();
    clock.now = at(-5000);
    await b.read();
    expect(s.asked).toHaveLength(1);
  });

  it("stops a watch whose start ends after the hold was released", async () => {
    const s = source(LIVE);
    s.holding();
    const { book: b, clock, timers: t } = book(s.source);
    const first = b.read();
    clock.now = at(HELD_MS);
    t.fire();
    s.release();
    await first;
    expect(s.watches[0]!.stopped).toBe(1);
  });
});

describe("a lost connection", () => {
  it("answers 502 in words while the watch is lost, and watches again at that read", async () => {
    const log = hush();
    const s = source(LIVE);
    const { book: b } = book(s.source);
    await b.read();
    s.watches[0]!.lose("IB Gateway closed the connection");
    expect(log).toHaveBeenCalledWith("IBKR account: the watch was lost: IB Gateway closed the connection");
    s.holding();
    expect(await b.read()).toEqual({ fault: { status: 502, message: LOST } });
    expect(LOST).toBe("The connection to IB Gateway was lost");
    expect(s.asked).toHaveLength(2);
    // a read while that start is in flight is the same 502, and starts nothing more
    expect(await b.read()).toEqual({ fault: { status: 502, message: LOST } });
    expect(s.asked).toHaveLength(2);
    s.release();
    await settle();
    expect(await b.read()).toMatchObject({ answer: { account: "masked-by-the-library" } });
    expect(s.asked).toHaveLength(2);
  });

  it("never stops a lost watch: the loss has already ended it, so a stop would send nothing", async () => {
    hush();
    const s = source(LIVE);
    const { book: b, clock, timers: t } = book(s.source);
    await b.read();
    s.watches[0]!.lose();
    await b.read();
    await settle();
    expect(s.watches[0]!.stopped).toBe(0);
    s.watches[1]!.lose();
    clock.now = at(HELD_MS + 10);
    t.fire();
    expect(s.watches[1]!.stopped).toBe(0);
  });

  it("is the same 502 after a watch again that failed, and the next read tries again", async () => {
    const log = hush();
    const s = source(LIVE, { unreachable: "connect ECONNREFUSED" }, { unreachable: "connect ECONNREFUSED" }, LIVE);
    const { book: b, clock } = book(s.source);
    await b.read();
    s.watches[0]!.lose();
    expect(await b.read()).toEqual({ fault: { status: 502, message: LOST } });
    await settle();
    expect(log).toHaveBeenCalledWith("IBKR account: watching again failed: connect ECONNREFUSED");
    // not again inside the 5 s, at a read or when the client answers
    clock.now = at(FAILED_MS - 1);
    expect(await b.read()).toEqual({ fault: { status: 502, message: LOST } });
    s.answered();
    expect(s.asked).toHaveLength(2);
    clock.now = at(FAILED_MS);
    expect(await b.read()).toEqual({ fault: { status: 502, message: LOST } });
    await settle();
    expect(s.asked).toHaveLength(3);
    clock.now = at(2 * FAILED_MS);
    expect(await b.read()).toEqual({ fault: { status: 502, message: LOST } });
    await settle();
    expect(await b.read()).toHaveProperty("answer");
    expect(s.asked).toHaveLength(4);
  });

  it("watches again when the client answers something else while the hold is up", async () => {
    hush();
    const s = source(LIVE);
    const { book: b } = book(s.source);
    await b.read();
    s.watches[0]!.lose();
    s.answered();
    expect(s.asked).toHaveLength(2);
    await settle();
    expect(await b.read()).toHaveProperty("answer");
    expect(s.asked).toHaveLength(2);
  });

  it("starts nothing when the client answers while the watch is well, or nothing is held", async () => {
    const s = source(LIVE);
    const { book: b, clock } = book(s.source);
    s.answered();
    await b.read();
    s.answered();
    expect(s.asked).toHaveLength(1);
    // held no more: the client answering is not a read
    hush();
    s.watches[0]!.lose();
    clock.now = at(HELD_MS);
    s.answered();
    expect(s.asked).toHaveLength(1);
  });

  it("stops a watch that came back after the hold was released", async () => {
    hush();
    const s = source(LIVE);
    const { book: b, clock, timers: t } = book(s.source);
    await b.read();
    s.watches[0]!.lose();
    s.holding();
    await b.read();
    clock.now = at(HELD_MS);
    t.fire();
    s.release();
    await settle();
    expect(s.watches[1]!.stopped).toBe(1);
  });
});
