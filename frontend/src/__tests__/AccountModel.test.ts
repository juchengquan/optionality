/** The account page's arithmetic and order (#471), on the made-up accounts in `testing/account.ts`:
 *  stocks by value in the base currency, options by underlying and then expiry, a stock's weight by
 *  IBKR's exchange rates (the owner, 2026-11-23), and how a figure in another currency is written. */
import { describe, expect, it } from "vitest";

import {
  contractLeg, currencyNote, holdsNothing, moneyText, optionGroups, pnlShare, quantityText, shareText,
  stocksByValue, valueInBase, weight,
} from "../account/model";
import { ACCOUNT, EMPTY, NO_RATE, ODD_OPTIONS, TWO_CURRENCIES } from "../testing/account";

const stock = (symbol: string) => TWO_CURRENCIES.stocks.find((s) => s.symbol === symbol)!;

describe("the stocks", () => {
  it("are sorted by market value, largest first", () => {
    expect(stocksByValue(ACCOUNT.stocks, ACCOUNT).map((s) => s.symbol)).toEqual(["MSFT", "AAPL", "KO"]);
  });

  it("are sorted by the size of their value, whatever its sign: a large short above a small long", () => {
    // an invented short of 25,000 against AAPL's long of 18,000 and KO's short of 1,240
    const short = { ...ACCOUNT.stocks[0]!, symbol: "SHRT", position: -100, market_price: 250, market_value: -25_000 };
    expect(stocksByValue([...ACCOUNT.stocks, short], ACCOUNT).map((s) => s.symbol))
      .toEqual(["SHRT", "MSFT", "AAPL", "KO"]);
  });

  it("put a holding with no value last, and never lose one", () => {
    const unvalued = { ...ACCOUNT.stocks[0]!, symbol: "ZZ", market_value: null };
    const sorted = stocksByValue([unvalued, ...ACCOUNT.stocks], ACCOUNT);
    expect(sorted.map((s) => s.symbol)).toEqual(["MSFT", "AAPL", "KO", "ZZ"]);
  });

  it("do not reorder what they were given", () => {
    const given = [...ACCOUNT.stocks];
    stocksByValue(given, ACCOUNT);
    expect(given.map((s) => s.symbol)).toEqual(["KO", "AAPL", "MSFT"]);
  });

  it("sort a holding in another currency by its value in the base, at IBKR's rate", () => {
    // 16,800 EUR at 1.0841 is 18,212.88 USD: above AAPL's 18,000, though 16,800 is the smaller number
    expect(valueInBase(stock("SAP"), TWO_CURRENCIES)).toBeCloseTo(18_212.88, 6);
    expect(stocksByValue(TWO_CURRENCIES.stocks, TWO_CURRENCIES).map((s) => s.symbol))
      .toEqual(["MSFT", "SAP", "AAPL", "KO"]);
  });

  it("list a holding whose currency has no rate after every one that converts", () => {
    // 78,000 SEK is the largest number here, and still last: it has no value in the base
    const sorted = stocksByValue(NO_RATE.stocks, NO_RATE).map((s) => s.symbol);
    expect(sorted).toEqual(["MSFT", "SAP", "AAPL", "KO", "VOLV.B"]);
    expect(valueInBase(NO_RATE.stocks.find((s) => s.symbol === "VOLV.B")!, NO_RATE)).toBeNull();
  });

  it("list the holdings with no rate by currency, then by the size of their own value whatever its sign, then by symbol", () => {
    // invented holdings in two currencies the answer gives no rate for
    const held = (symbol: string, currency: string, value: number) =>
      ({ ...ACCOUNT.stocks[0]!, symbol, currency, market_value: value });
    const unrated = [
      held("NLONG", "NOK", 5_000),
      held("NTIEB", "NOK", 8_000),
      held("DONE", "DKK", 1_000),
      held("NSHORT", "NOK", -30_000),
      held("NTIEA", "NOK", -8_000),
    ];
    expect(stocksByValue([...unrated, ...ACCOUNT.stocks], ACCOUNT).map((s) => s.symbol))
      .toEqual(["MSFT", "AAPL", "KO", "DONE", "NSHORT", "NTIEA", "NTIEB", "NLONG"]);
  });

  it("weigh each holding in the base currency against net liquidation", () => {
    expect(weight(stock("AAPL"), TWO_CURRENCIES)).toBeCloseTo(18_000 / 250_000, 10);
    // a short weighs against the account too
    expect(weight(stock("KO"), TWO_CURRENCIES)).toBeCloseTo(-1_240 / 250_000, 10);
  });

  it("weigh a holding in another currency by its value in the base, at IBKR's rate", () => {
    expect(weight(stock("SAP"), TWO_CURRENCIES)).toBeCloseTo(16_800 * 1.0841 / 250_000, 10);
  });

  it("weigh nothing in a currency IBKR sent no rate for", () => {
    expect(weight(NO_RATE.stocks.find((s) => s.symbol === "VOLV.B")!, NO_RATE)).toBeNull();
    expect(weight(stock("SAP"), { ...TWO_CURRENCIES, exchange_rates: { USD: 1 } })).toBeNull();
  });

  it("weigh nothing where the base or net liquidation is unknown, or nothing", () => {
    expect(weight(stock("AAPL"), { ...TWO_CURRENCIES, base_currency: null })).toBeNull();
    expect(weight(stock("AAPL"), { ...TWO_CURRENCIES, totals: { ...TWO_CURRENCIES.totals, net_liquidation: null } })).toBeNull();
    expect(weight(stock("AAPL"), { ...TWO_CURRENCIES, totals: { ...TWO_CURRENCIES.totals, net_liquidation: 0 } })).toBeNull();
  });

  it("say their P&L as a share of what they cost", () => {
    // 100 at 150, marked at 180: +3,000 on 15,000
    expect(pnlShare(stock("AAPL"))).toBeCloseTo(0.2, 10);
    // 50 at 400, marked at 380: −1,000 on 20,000
    expect(pnlShare(stock("MSFT"))).toBeCloseTo(-0.05, 10);
    // a short: −20 at 60, marked at 62, −40 on 1,200
    expect(pnlShare(stock("KO"))).toBeCloseTo(-40 / 1_200, 10);
  });

  it("say no share where the cost or the P&L is unknown", () => {
    expect(pnlShare({ ...stock("AAPL"), average_cost: null })).toBeNull();
    expect(pnlShare({ ...stock("AAPL"), unrealized_pnl: null })).toBeNull();
    expect(pnlShare({ ...stock("AAPL"), average_cost: 0 })).toBeNull();
    expect(pnlShare({ ...stock("AAPL"), position: 0 })).toBeNull();
  });
});

describe("the options", () => {
  it("are grouped by underlying, then by expiry, nearest first", () => {
    const groups = optionGroups(ACCOUNT.options);
    expect(groups.map((g) => g.underlying)).toEqual(["QQQ", "SPX"]);
    const spx = groups.find((g) => g.underlying === "SPX")!;
    expect(spx.expiries.map((e) => e.expiry)).toEqual(["20261204", "20261218"]);
  });

  it("list an expiry's contracts by strike, as a ladder", () => {
    const spx = optionGroups(ACCOUNT.options).find((g) => g.underlying === "SPX")!;
    expect(spx.expiries[1]!.rows.map((r) => `${r.right}${r.strike}`)).toEqual(["P6750", "P6800", "C7300"]);
  });

  it("list a put before a call at one strike, whichever came first", () => {
    const spx = optionGroups(ODD_OPTIONS.options).find((g) => g.underlying === "SPX")!;
    const dec18 = spx.expiries.find((e) => e.expiry === "20261218")!;
    expect(dec18.rows.map((r) => `${r.right}${r.strike}`)).toEqual(["P6750", "P6800", "P7000", "C7000", "C7300"]);
  });

  it("list an option with no expiry after every expiry, whichever came first", () => {
    const spx = optionGroups(ODD_OPTIONS.options).find((g) => g.underlying === "SPX")!;
    expect(spx.expiries.map((e) => e.expiry)).toEqual(["20261204", "20261218", null]);
    expect(spx.expiries.at(-1)!.rows.map((r) => `${r.right}${r.strike}`)).toEqual(["P7000"]);
  });

  it("write a contract as a leg: its type, its strike, short where the position is", () => {
    const short = ACCOUNT.options.find((o) => o.strike === 6800)!;
    expect(contractLeg(short)).toEqual({ short: true, option_type: "PUT", strike: 6800 });
    const long = ACCOUNT.options.find((o) => o.strike === 7500)!;
    expect(contractLeg(long)).toEqual({ short: false, option_type: "CALL", strike: 7500 });
  });
});

describe("currencies", () => {
  it("name a currency only where it is not the base", () => {
    expect(currencyNote("USD", "USD")).toBeNull();
    expect(currencyNote("EUR", "USD")).toBe("EUR");
    // a base the gateway did not say: every currency is named
    expect(currencyNote("USD", null)).toBe("USD");
  });

  it("write dollars as the book does, and any other currency as a plain amount", () => {
    expect(moneyText(18_000, "USD")).toBe("$18,000");
    expect(moneyText(-1_240, "USD")).toBe("−$1,240");
    expect(moneyText(3_000, "USD", true)).toBe("+$3,000");
    expect(moneyText(16_800, "EUR")).toBe("16,800");
    expect(moneyText(-1_250, "EUR", true)).toBe("−1,250");
    expect(moneyText(1_400, "EUR", true)).toBe("+1,400");
    expect(moneyText(null, "USD")).toBe("—");
  });
});

describe("privacy, as the book keeps it (ui_privacy)", () => {
  it("hides every amount of money as the book does, and keeps the dash for none", () => {
    expect(moneyText(18_000, "USD", false, true)).toBe("$•••");
    expect(moneyText(-1_240, "USD", true, true)).toBe("$•••");
    expect(moneyText(16_800, "EUR", false, true)).toBe("•••");
    expect(moneyText(null, "USD", false, true)).toBe("—");
  });

  it("hides a count and keeps its sign, as the book hides a holding's contracts", () => {
    expect(quantityText(100, true)).toBe("+•••");
    expect(quantityText(-2, true)).toBe("−•••");
    expect(quantityText(null, true)).toBe("—");
  });
});

describe("the words beside the figures", () => {
  it("write a signed quantity with the true minus", () => {
    expect(quantityText(3)).toBe("+3");
    expect(quantityText(-2)).toBe("−2");
    expect(quantityText(0)).toBe("0");
    expect(quantityText(200_000)).toBe("+200,000");
    expect(quantityText(-0.5)).toBe("−0.5");
    expect(quantityText(null)).toBe("—");
  });

  it("write a share to a tenth of a percent, signed where asked", () => {
    expect(shareText(0.072)).toBe("7.2%");
    expect(shareText(0.2, true)).toBe("+20.0%");
    expect(shareText(-0.05, true)).toBe("−5.0%");
    expect(shareText(null)).toBe("—");
  });

  it("know an account that holds nothing", () => {
    expect(holdsNothing(EMPTY)).toBe(true);
    expect(holdsNothing(ACCOUNT)).toBe(false);
    expect(holdsNothing({ ...EMPTY, other: ACCOUNT.other })).toBe(false);
  });
});
