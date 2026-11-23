/** The IBKR account behind `GET /account` (ADR 0030, #470): what each read comes to, and one read
 *  shared by every caller for `ACCOUNT_SHARED_FOR_MS` (10 s), a read in flight joined, a failure too. */
import { describe, expect, it } from "vitest";
import type { ibkrFields } from "optionality/vendors/fields";

import { AccountBook, NOT_ANSWERING, NOT_CONFIGURED } from "./account.ts";
import type { AccountReading, ReadAccount } from "./ports.ts";

/** The window, stated rather than imported, so the number itself is held: 10 s, the owner's
 *  decision on #470 — under the page's 15 s refresh, so each refresh reads afresh. */
const WINDOW_MS = 10_000;

type IbkrHolding = ibkrFields.IbkrHolding;

const NOW = new Date("2026-11-23T15:00:00.000Z");

const holding = (over: Partial<IbkrHolding>): IbkrHolding => ({
  sec_type: "STK", symbol: "ACME", currency: "USD", expiry: null, strike: null, right: null,
  multiplier: null, position: 100, market_price: 41.25, market_value: 4125, average_cost: 38.5,
  unrealized_pnl: 275, realized_pnl: 0, ...over,
});

const STOCK = holding({});
const OPTION = holding({
  sec_type: "OPT", expiry: "20261218", strike: 45, right: "C", multiplier: 100, position: -2,
  market_price: 1.5, market_value: -300, average_cost: 2.25,
});
const FUTURE = holding({
  sec_type: "FUT", symbol: "ES", expiry: "20261218", multiplier: 50, position: 1, market_value: 0,
});
const CASH = holding({ sec_type: "CASH", symbol: "EUR.USD", currency: "USD", position: 1200, market_value: 1290 });

const ACCOUNT: ibkrFields.IbkrAccount = {
  account: "masked-by-the-library", paper: false, base_currency: "USD", updated_at: "14:32",
  totals: { net_liquidation: 184523.17, total_cash: 61230.55, unrealized_pnl: 2071.4, realized_pnl: -412.8 },
  exchange_rates: { USD: 1, EUR: 1.075 },
  holdings: [STOCK, FUTURE, OPTION, CASH],
};

/** A reader that answers `reading` and counts what it was asked, settling when told to. */
function reader(reading: AccountReading = { account: ACCOUNT }) {
  const asked: (string | null)[] = [];
  const pending: (() => void)[] = [];
  let hold = false;
  const read: ReadAccount = (wanted) => {
    asked.push(wanted);
    if (!hold) return Promise.resolve(reading);
    return new Promise((resolve) => pending.push(() => resolve(reading)));
  };
  return {
    read, asked,
    holding() { hold = true; },
    release() { for (const go of pending.splice(0)) go(); },
  };
}

function book(read: ReadAccount | null, over: { wanted?: string } = {}) {
  const clock = { now: NOW };
  const b = new AccountBook({
    read, wanted: over.wanted ?? "", now: () => clock.now, displayTz: "Asia/Singapore",
  });
  return { book: b, clock };
}

describe("what a read comes to", () => {
  it("answers the account, stocks and options apart and everything else under other", async () => {
    const r = reader();
    const result = await book(r.read).book.read();
    expect(result).toEqual({
      answer: {
        account: "masked-by-the-library", paper: false, base_currency: "USD", updated_at: "14:32",
        read_at: "2026-11-23 23:00:00+08:00",
        totals: ACCOUNT.totals,
        // IBKR's own, passed through: base units per one unit of each currency
        exchange_rates: { USD: 1, EUR: 1.075 },
        stocks: [STOCK],
        options: [OPTION],
        // with only what the page lists of them, in the order IBKR sent them
        other: [
          { sec_type: "FUT", symbol: "ES", position: 1, market_value: 0, currency: "USD" },
          { sec_type: "CASH", symbol: "EUR.USD", position: 1200, market_value: 1290, currency: "USD" },
        ],
      },
    });
  });

  it("asks for the login's only account where IBKR_ACCOUNT is blank or spaces", async () => {
    const r = reader();
    await book(r.read, { wanted: "  " }).book.read();
    expect(r.asked).toEqual([null]);
  });

  it("asks for the account IBKR_ACCOUNT names, trimmed", async () => {
    const r = reader();
    await book(r.read, { wanted: " U0000001 " }).book.read();
    expect(r.asked).toEqual(["U0000001"]);
  });

  it("trims IBKR_ACCOUNT as JavaScript does, so a control character is asked for", async () => {
    const r = reader();
    await book(r.read, { wanted: "\x1f" }).book.read();
    expect(r.asked).toEqual(["\x1f"]);
  });

  it("is a 503 where IB Gateway is not configured, and reads nothing", async () => {
    expect(await book(null).book.read()).toEqual({ fault: { status: 503, message: NOT_CONFIGURED } });
    expect(NOT_CONFIGURED).toBe("IB Gateway is not configured");
  });

  it("is a 502 in the issue's words where the gateway does not answer", async () => {
    // the library's words for a gateway that is down, or at its login screen with its API port shut
    const r = reader({ unreachable: "could not reach IB Gateway at 127.0.0.1:4001: connect ECONNREFUSED 127.0.0.1:4001" });
    expect(await book(r.read).book.read())
      .toEqual({ fault: { status: 502, message: NOT_ANSWERING } });
    expect(NOT_ANSWERING).toBe("IB Gateway did not answer — is it running and logged in?");
  });

  it("is a 502 in the gateway's own words where it refused the session", async () => {
    // the library's words for `client-id-in-use`: not a gateway that is down, and not told as one
    const words = "IB Gateway refused the session: 326 Unable to connect as the client id is already in use. "
      + "Retry with a unique client id.";
    expect(await book(reader({ unreachable: words }).read).book.read())
      .toEqual({ fault: { status: 502, message: words } });
  });

  it("is a 502 in the library's words where the read did not finish", async () => {
    const words = "IB Gateway did not finish sending the account within 8000ms";
    const r = reader({ failed: words });
    expect(await book(r.read).book.read()).toEqual({ fault: { status: 502, message: words } });
  });

  it("is a 422 in the library's words where it would not choose an account", async () => {
    const words = "several accounts on this login; set IBKR_ACCOUNT to one of <the masked ids>";
    const r = reader({ refused: words });
    expect(await book(r.read).book.read()).toEqual({ fault: { status: 422, message: words } });
  });
});

describe("one read, shared", () => {
  it("serves every caller inside the window from the first read, read_at and all", async () => {
    const r = reader();
    const { book: b, clock } = book(r.read);
    const first = await b.read();
    clock.now = new Date(NOW.getTime() + WINDOW_MS - 1);
    expect(await b.read()).toEqual(first);
    expect(r.asked).toHaveLength(1);
  });

  it("reads afresh once the window has passed", async () => {
    const r = reader();
    const { book: b, clock } = book(r.read);
    await b.read();
    clock.now = new Date(NOW.getTime() + WINDOW_MS);
    const again = await b.read();
    expect(r.asked).toHaveLength(2);
    expect("answer" in again && again.answer.read_at).toBe("2026-11-23 23:00:10+08:00");
  });

  it("counts the window from when the read came back, not from when it was asked", async () => {
    const r = reader();
    r.holding();
    const { book: b, clock } = book(r.read);
    const first = b.read();
    clock.now = new Date(NOW.getTime() + 8000);
    r.release();
    expect(await first).toMatchObject({ answer: { read_at: "2026-11-23 23:00:08+08:00" } });
    clock.now = new Date(NOW.getTime() + 8000 + WINDOW_MS - 1);
    await b.read();
    expect(r.asked).toHaveLength(1);
  });

  it("joins a read in flight rather than asking twice", async () => {
    const r = reader();
    r.holding();
    const { book: b } = book(r.read);
    const both = Promise.all([b.read(), b.read()]);
    r.release();
    const [one, two] = await both;
    expect(one).toEqual(two);
    expect(r.asked).toHaveLength(1);
  });

  it("shares a failure for the same window", async () => {
    const r = reader({ unreachable: "could not reach IB Gateway at 127.0.0.1:4001: connect ECONNREFUSED 127.0.0.1:4001" });
    const { book: b, clock } = book(r.read);
    await b.read();
    clock.now = new Date(NOW.getTime() + WINDOW_MS - 1);
    expect(await b.read()).toEqual({ fault: { status: 502, message: NOT_ANSWERING } });
    expect(r.asked).toHaveLength(1);
  });

  it("trusts nothing it read when the clock has gone back", async () => {
    const r = reader();
    const { book: b, clock } = book(r.read);
    await b.read();
    clock.now = new Date(NOW.getTime() - 1);
    await b.read();
    expect(r.asked).toHaveLength(2);
  });

  it("reads afresh after a reader that threw, rather than sharing a rejection for ever", async () => {
    let calls = 0;
    const read: ReadAccount = () => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error("a bug")) : Promise.resolve({ account: ACCOUNT });
    };
    const { book: b } = book(read);
    await expect(b.read()).rejects.toThrow("a bug");
    expect(await b.read()).toHaveProperty("answer");
  });
});
