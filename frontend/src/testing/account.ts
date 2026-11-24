/** Made-up IBKR accounts for the account page's suites (#471), as `GET /account` answers them
 *  (#470): every holding, figure and id here is invented, the id masked as the service masks one.
 *
 *  - `ACCOUNT`: a USD account holding stocks, SPX and QQQ options over three expiries, and a future;
 *  - `PAPER`: the same, as a paper account;
 *  - `EMPTY`: cash and nothing held;
 *  - `TWO_CURRENCIES`: a USD account that also holds a stock and a future in EUR, at a made-up rate;
 *  - `NO_RATE`: the same, and a stock in SEK, a currency IBKR sent no rate for;
 *  - `ODD_OPTIONS`: a put and a call at one strike, and an option with no expiry.
 *
 *  And `serveAccount`, a fake of the one route the page reads, which counts every read and answers
 *  what the test sets — an account, or a refusal in the service's words with its status. */
import type { Account, AccountHolding } from "../shared/api";

const stock = (symbol: string, position: number, averageCost: number, mark: number, currency = "USD",
): AccountHolding => ({
  sec_type: "STK", symbol, currency, expiry: null, strike: null, right: null, multiplier: null,
  position, market_price: mark, market_value: position * mark, average_cost: averageCost,
  unrealized_pnl: position * (mark - averageCost), realized_pnl: 0, daily_pnl: null,
});

const option = (symbol: string, expiry: string, right: "C" | "P", strike: number, position: number,
  averageCost: number, mark: number): AccountHolding => ({
  sec_type: "OPT", symbol, currency: "USD", expiry, strike, right, multiplier: 100,
  position, market_price: mark, market_value: position * mark * 100, average_cost: averageCost,
  unrealized_pnl: position * (mark - averageCost) * 100, realized_pnl: 0, daily_pnl: null,
});

export const ACCOUNT: Account = {
  account: "U•••••567",
  paper: false,
  base_currency: "USD",
  updated_at: "14:32",
  read_at: "2026-11-23 21:04:37+08:00",
  totals: {
    net_liquidation: 250_000, total_cash: 40_000.5, unrealized_pnl: 12_500.25, realized_pnl: -1_200, daily_pnl: null,
  },
  exchange_rates: { USD: 1 },
  // NOT in the page's order: the page sorts them by value
  stocks: [
    stock("KO", -20, 60, 62),
    stock("AAPL", 100, 150, 180),
    stock("MSFT", 50, 400, 380),
  ],
  // NOT in the page's order either: the page groups them by underlying, then expiry
  options: [
    option("SPX", "20261218", "C", 7300, -1, 12.4, 8.1),
    option("QQQ", "20261218", "P", 500, 3, 4.2, 3.95),
    option("SPX", "20261218", "P", 6750, 2, 9.05, 6.2),
    option("SPX", "20261204", "C", 7500, 1, 2.35, 1.1),
    option("SPX", "20261218", "P", 6800, -2, 11.3, 8.45),
  ],
  other: [{ sec_type: "FUT", symbol: "MES", position: 1, market_value: 3_000, currency: "USD" }],
  // the P&L stream's figures (#477) are not drawn yet: the page that draws them is its own issue
  live: null,
};

export const PAPER: Account = { ...ACCOUNT, account: "DU•••••890", paper: true };

export const EMPTY: Account = {
  ...ACCOUNT,
  totals: { net_liquidation: 40_000.5, total_cash: 40_000.5, unrealized_pnl: 0, realized_pnl: 0, daily_pnl: null },
  stocks: [], options: [], other: [],
};

export const TWO_CURRENCIES: Account = {
  ...ACCOUNT,
  // base units per one EUR: an invented SAP on IBIS, 16,800 EUR, is 18,212.88 USD — above AAPL's
  // 18,000, though 16,800 is the smaller number
  exchange_rates: { USD: 1, EUR: 1.0841 },
  stocks: [...ACCOUNT.stocks, stock("SAP", 70, 220, 240, "EUR")],
  other: [...ACCOUNT.other, { sec_type: "FUT", symbol: "FESX", position: -1, market_value: -1_250, currency: "EUR" }],
};

export const NO_RATE: Account = {
  ...TWO_CURRENCIES,
  stocks: [...TWO_CURRENCIES.stocks, stock("VOLV.B", 300, 250, 260, "SEK")],
};

/** SPX options that test the order within the options: an invented call and put at one strike,
 *  given call first, and an invented option IBKR sent with no expiry, given first of all. */
export const ODD_OPTIONS: Account = {
  ...ACCOUNT,
  options: [
    { ...option("SPX", "20261218", "P", 7000, 1, 5, 4), expiry: null },
    option("SPX", "20261218", "C", 7000, -1, 6.1, 5.2),
    option("SPX", "20261218", "P", 7000, 1, 7.4, 6.6),
    ...ACCOUNT.options,
  ],
};

/** The refusals `GET /account` gives (#470), word for word: the route's own (`backend/src/account.ts`:
 *  `NOT_CONFIGURED`, `NOT_ANSWERING`), the library's choice of account (`ibkr/fields.ts`'
 *  `chooseAccount`), and the gateway's or the client's words passed through. The ids are made up. */
export const REFUSALS = {
  notConfigured: { status: 503, detail: "IB Gateway is not configured" },
  notAnswering: { status: 502, detail: "IB Gateway did not answer — is it running and logged in?" },
  deadline: {
    status: 502,
    detail: "IB Gateway did not finish sending the account within 8000ms — its link to IBKR may be down "
      + "while its own socket is still open",
  },
  refusedSession: {
    status: 502,
    detail: "IB Gateway refused the session: 326 Unable to connect as the client id is already in use. Retry with a unique client id.",
  },
  severalAccounts: {
    status: 422, detail: "several accounts on this login; set IBKR_ACCOUNT to one of U•••••567, U•••••890",
  },
} as const;

export interface AccountService {
  /** how many times the page has read `/account` */
  reads: () => number;
  /** every request the page sent, as `METHOD path` */
  requests: string[];
  /** what the next reads answer: an account, or a refusal */
  answer: Account | { status: number; detail: string };
  /** holds every later read until the returned function is called */
  hold: () => () => void;
}

/** `/account` and nothing else: any other request the page makes is recorded and answered 404, so
 *  a page that reaches for the book's routes is seen to. */
export function serveAccount(answer: AccountService["answer"] = ACCOUNT): AccountService {
  let gate: Promise<void> | null = null;
  const svc: AccountService = {
    requests: [], answer,
    reads: () => svc.requests.filter((r) => r === "GET /account").length,
    hold: () => {
      let release!: () => void;
      gate = new Promise<void>((r) => { release = r; });
      return () => { gate = null; release(); };
    },
  };
  const reply = (status: number, body: unknown) =>
    ({ ok: status < 400, status, json: () => Promise.resolve(body) }) as Response;
  window.fetch = (async (url: string, init?: RequestInit) => {
    const path = String(url).replace(/^.*\/api/, "");
    const method = init?.method ?? "GET";
    svc.requests.push(`${method} ${path}`);
    if (method !== "GET" || path !== "/account") return reply(404, { detail: `not served: ${method} ${path}` });
    if (gate) await gate;
    const a = svc.answer;
    return "detail" in a ? reply(a.status, { detail: a.detail }) : reply(200, structuredClone(a));
  }) as typeof window.fetch;
  return svc;
}
