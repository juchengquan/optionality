import { describe, expect, it } from "vitest";

import {
  type AccountValueRow, GREEK_TICKS, type PortfolioRow, PRICE_TICKS, accountAnswer, chooseAccount,
  grade, greekFields, hasFigures, holdingFrom, isPaper, managedAccounts, maskAccount, perShareCost,
  withMid,
} from "./fields.ts";

/** The translation from IB Gateway's numbers to the service's names.
 *
 *  Two of these are not renames and both were measured on 2026-11-08 against the live gateway:
 *  implied volatility changes units, and the four data grades are two independent facts.
 */

describe("implied volatility, which changes units", () => {
  it("multiplies IBKR's fraction into the service's percent", () => {
    // measured, same contract, same minute: moomoo said 14.007 and IBKR said 0.1368. A rule set
    // at 14 would never fire on IBKR; one set at 0.14 would fire constantly on moomoo.
    const got = greekFields({
      impliedVol: 0.13679778548286392, delta: null, gamma: null, vega: null, theta: null,
    });
    // closeTo rather than toEqual: `0.13679778548286392 * 100` is not the decimal literal, and
    // the claim is the MAGNITUDE — a percent rather than a fraction — not the last bit of it
    expect(got.option_implied_volatility).toBeCloseTo(13.6797785, 7);
    expect(got.option_implied_volatility).toBeGreaterThan(1);
  });

  it("leaves the greeks themselves alone, which are already dimensionless", () => {
    const got = greekFields({
      impliedVol: null, delta: 0.02806614063578037, gamma: 0.00018826189971762677,
      vega: 1.8321828845155324, theta: -0.28028107934963487,
    });
    expect(got).toEqual({
      option_delta: 0.02806614063578037,
      option_gamma: 0.00018826189971762677,
      option_vega: 1.8321828845155324,
      option_theta: -0.28028107934963487,
    });
  });

  it("omits a greek that was not computed rather than writing null", () => {
    // a null delta and an absent one are the same thing to the dashboard, but a WRITTEN null
    // would satisfy `hasFigures` and claim the contract answered
    expect(greekFields({ impliedVol: null, delta: null, gamma: null, vega: null, theta: null }))
      .toEqual({});
  });
});

describe("the four grades, as two facts", () => {
  it("reads each one", () => {
    expect(grade(1)).toEqual({ delayed: false, last_known: false });
    expect(grade(2)).toEqual({ delayed: false, last_known: true });
    expect(grade(3)).toEqual({ delayed: true, last_known: false });
    expect(grade(4)).toEqual({ delayed: true, last_known: true });
  });

  it("keeps grade 4 as BOTH, rather than collapsing it", () => {
    // the gateway drew this distinction per contract in one response on 2026-11-08 — SPX granted
    // DELAYED while VIX granted DELAYED_FROZEN — so throwing one away is deciding we know better
    expect(grade(4)).not.toEqual(grade(3));
    expect(grade(4)).not.toEqual(grade(2));
  });

  it("says nothing about a grade nobody documented", () => {
    // null renders as nothing, which is what the strip shows for a source that did not say. False
    // would read as "live and updating", which is a claim.
    expect(grade(0)).toBe(null);
    expect(grade(7)).toBe(null);
  });
});

describe("the mid, which is derived rather than sent", () => {
  it("is the midpoint where both sides arrived", () => {
    expect(withMid({ bid_price: 3.5, ask_price: 4.1 }).mid_price).toBe(3.8);
  });

  it("is absent where only one side did", () => {
    // a mid from one side is a number with no meaning, and `domain/reference.ts` PREFERS the mid
    expect(withMid({ bid_price: 3.5 }).mid_price).toBe(undefined);
    expect(withMid({ ask_price: 4.1 }).mid_price).toBe(undefined);
  });

  it("is absent for an empty book, whose sides are kept (#380)", () => {
    // This was a mid of 0, "left for the domain to judge" — and every domain path but a
    // Reference's took the 0 as a price: moomoo's 0/0 out of hours valued the book at 0.00. No ask
    // above zero is no price, by the one rule every vendor shares (`domain/quote.ts` `midPrice`).
    const record = withMid({ bid_price: 0, ask_price: 0 });
    expect(record.mid_price).toBe(undefined);
    expect(record).toEqual({ bid_price: 0, ask_price: 0 });
  });
});

describe("whether anything arrived", () => {
  it("is false for a record carrying only its identity", () => {
    // "subscribed, nothing yet" — a figure that did not arrive, NOT a contract that does not
    // exist. The service keeps those apart (ADR 0015)
    expect(hasFigures({ code: "SPX", name: "S&P 500" })).toBe(false);
  });

  it("is false for identity plus a grade, which is not a figure", () => {
    // the gateway answers the grade for every request, including ones that then price nothing —
    // counting it as a figure would make every silent contract look answered
    expect(hasFigures({ code: "SPX", delayed: true, last_known: true })).toBe(false);
  });

  it("is true for one figure, however little", () => {
    expect(hasFigures({ code: "SPX", prev_close_price: 7353.73 })).toBe(true);
  });
});

describe("the tick ids", () => {
  it("maps the delayed ids to the same fields as the live ones", () => {
    // which TIER answered is reported once per request by the gateway, not inferred from the
    // ids — it contradicted a request once, granting live when asked for delayed
    expect(PRICE_TICKS[66]).toBe(PRICE_TICKS[1]);
    expect(PRICE_TICKS[67]).toBe(PRICE_TICKS[2]);
    expect(PRICE_TICKS[68]).toBe(PRICE_TICKS[4]);
    expect(PRICE_TICKS[75]).toBe(PRICE_TICKS[9]);
  });

  it("reads the model computation, live and delayed, and nothing else", () => {
    // a bid- or ask-implied computation is a different claim from the model's, and so is the
    // CUSTOM computation (53), which this table once named as the delayed model's; the service
    // has one field per greek. The Python's suite checks these against ib_async's own map.
    expect([...GREEK_TICKS].sort((a, b) => a - b)).toEqual([13, 83]);
  });
});

// --- the account (ADR 0030) ---------------------------------------------------------------------

/** A PORTFOLIO_VALUE row as ibapi 9.81 lays it out; every figure invented. */
const OPTION_ROW: PortfolioRow = {
  sec_type: "OPT", symbol: "ACME", expiry: "20261218", strike: "45.0", right: "C",
  multiplier: "100", currency: "USD", position: "4", market_price: "3.85",
  market_value: "1540.0", average_cost: "262.5", unrealized_pnl: "490.0", realized_pnl: "0.0",
};
const STOCK_ROW: PortfolioRow = {
  sec_type: "STK", symbol: "ACME", expiry: "", strike: "0.0", right: "0", multiplier: "",
  currency: "USD", position: "300", market_price: "41.27", market_value: "12381.0",
  average_cost: "38.115", unrealized_pnl: "946.5", realized_pnl: "0.0",
};

describe("the account id, which leaves the client only masked", () => {
  it("keeps the leading letters, then FIVE bullets, then the last three", () => {
    // the owner's decisions on #469: the prefix says which kind of account, the last three which
    // one, and the bullets are always five, so the mask does not say how long the id is either
    expect(maskAccount("U1234567")).toBe("U•••••567");
    expect(maskAccount("DU1234567")).toBe("DU•••••567");
    expect(maskAccount("U12345678")).toBe("U•••••678");
    expect(maskAccount("U12345")).toBe("U•••••345");
    expect(maskAccount("F1234A567")).toBe("F•••••567");
  });

  it("always hides at least one character after the letters, however short the id", () => {
    // review round 2: "U001" came out whole
    expect(maskAccount("U001")).toBe("U•••••01");
    expect(maskAccount("U12")).toBe("U•••••2");
    expect(maskAccount("U1")).toBe("U•••••");
    expect(maskAccount("")).toBe("•••••");
  });

  it("never shows an id that is ALL letters whole: no prefix kept, only its last three", () => {
    expect(maskAccount("ABCDEFG")).toBe("•••••EFG");
  });

  it("calls an account paper where IB does: an id that starts DU", () => {
    expect(isPaper("DU0000000")).toBe(true);
    expect(isPaper("U0000000")).toBe(false);
    expect(isPaper("DF0000000")).toBe(false);
  });
});

describe("the managed accounts", () => {
  it("reads MANAGED_ACCTS' one field as a list, dropping a trailing comma's empty id", () => {
    expect(managedAccounts("U0000000,U0000001,")).toEqual(["U0000000", "U0000001"]);
    expect(managedAccounts("")).toEqual([]);
  });
});

describe("which account is read", () => {
  it("is the login's only one, unasked", () => {
    expect(chooseAccount(["U0000000"], null)).toEqual({ account: "U0000000" });
  });

  it("is the one named, of several", () => {
    expect(chooseAccount(["U0000000", "U0000001"], "U0000001")).toEqual({ account: "U0000001" });
  });

  it("is refused, never guessed, where several are managed and none is named", () => {
    expect(chooseAccount(["U0000000", "U0000001"], null)).toEqual({
      refused: "several accounts on this login; set IBKR_ACCOUNT to one of U•••••000, U•••••001",
    });
  });

  it("is refused where the one named is not on the login, that one masked too", () => {
    const got = chooseAccount(["U0000000"], "U7654321");
    expect(got).toEqual({
      refused: "IBKR_ACCOUNT (U•••••321) names no account on this login, which has U•••••000",
    });
    expect(JSON.stringify(got)).not.toContain("7654321");
  });

  it("is refused where the gateway named none", () => {
    expect(chooseAccount([], null)).toEqual({ refused: "IB Gateway named no account on this login" });
  });

  it("reads a blank name as none", () => {
    expect(chooseAccount(["U0000000"], "  ")).toEqual({ account: "U0000000" });
  });
});

describe("a holding", () => {
  it("states an option's average cost PER SHARE, where IB's includes the multiplier", () => {
    // IB sends 262.5 for an option bought at 2.625: its averageCost is per contract
    expect(holdingFrom(OPTION_ROW).average_cost).toBe(2.625);
    expect(perShareCost(250, 100)).toBe(2.5);
  });

  it("leaves a stock's alone, which has no multiplier", () => {
    expect(holdingFrom(STOCK_ROW).average_cost).toBe(38.115);
    expect(perShareCost(38.115, null)).toBe(38.115);
    expect(perShareCost(38.115, 0)).toBe(38.115);
    expect(perShareCost(null, 100)).toBeNull();
  });

  it("reads an option's row into the answer's names", () => {
    expect(holdingFrom(OPTION_ROW)).toEqual({
      sec_type: "OPT", symbol: "ACME", currency: "USD", expiry: "20261218", strike: 45, right: "C",
      multiplier: 100, position: 4, market_price: 3.85, market_value: 1540, average_cost: 2.625,
      unrealized_pnl: 490, realized_pnl: 0,
    });
  });

  it("gives a stock no strike, no side and no expiry, rather than a strike of 0", () => {
    expect(holdingFrom(STOCK_ROW)).toMatchObject({
      expiry: null, strike: null, right: null, multiplier: null, position: 300,
    });
  });

  it("keeps a short position's sign", () => {
    expect(holdingFrom({ ...OPTION_ROW, position: "-6" }).position).toBe(-6);
  });

  it("reads an empty figure as none, never as 0", () => {
    expect(holdingFrom({ ...OPTION_ROW, market_price: "", market_value: " " }))
      .toMatchObject({ market_price: null, market_value: null });
  });
});

describe("the account's answer", () => {
  const row = (key: string, value: string, currency: string): AccountValueRow =>
    ({ key, value, currency });

  it("takes the base currency from NetLiquidation, and each total from its BASE row first", () => {
    const got = accountAnswer("U0000000", [
      row("NetLiquidation", "184523.17", "USD"),
      row("TotalCashValue", "61230.55", "USD"),
      row("UnrealizedPnL", "2565.40", "USD"),        // the USD holdings' alone
      row("UnrealizedPnL", "2875.40", "BASE"),       // every currency's, in the base
      row("RealizedPnL", "-412.80", "BASE"),
      row("AccountCode", "U0000000", ""),
    ], [], "14:32");
    expect(got).toEqual({
      account: "U•••••000", paper: false, base_currency: "USD", updated_at: "14:32",
      totals: {
        net_liquidation: 184523.17, total_cash: 61230.55, unrealized_pnl: 2875.4,
        realized_pnl: -412.8,
      },
      exchange_rates: { USD: 1 }, holdings: [],
    });
  });

  it("reads the P&L from $LEDGER's BASE row, which is all the live gateway sends", () => {
    // measured on 2026-11-23: no plain UnrealizedPnL or RealizedPnL at all, only $LEDGER-…, in
    // BASE and each currency; and NetLiquidation and TotalCashValue plain, in USD only, beside
    // their `-S` segment rows, which are not the account's total
    const got = accountAnswer("U0000000", [
      row("NetLiquidation", "184523.17", "USD"),
      row("NetLiquidation-S", "184000.00", "USD"),
      row("TotalCashValue", "61230.55", "USD"),
      row("TotalCashValue-S", "61000.00", "USD"),
      row("$LEDGER-UnrealizedPnL", "2071.40", "BASE"),
      row("$LEDGER-UnrealizedPnL", "1735.30", "USD"),
      row("$LEDGER-UnrealizedPnL", "2635.10", "HKD"),
      row("$LEDGER-RealizedPnL", "-412.80", "BASE"),
      row("$LEDGER-RealizedPnL", "-412.80", "USD"),
    ], [], "18:07");
    expect(got.totals).toEqual({
      net_liquidation: 184523.17, total_cash: 61230.55, unrealized_pnl: 2071.4,
      realized_pnl: -412.8,
    });
  });

  it("prefers a plain BASE row to $LEDGER's, should a gateway send one", () => {
    const got = accountAnswer("U0000000", [
      row("UnrealizedPnL", "1.00", "BASE"), row("$LEDGER-UnrealizedPnL", "2.00", "BASE"),
    ], [], null);
    expect(got.totals.unrealized_pnl).toBe(1);
  });

  it("carries IBKR's exchange rates, base units per unit of each currency", () => {
    // the owner's decision on #469: so a holding in HKD can be weighed in the base
    const got = accountAnswer("U0000000", [
      row("NetLiquidation", "184523.17", "USD"),
      row("$LEDGER-ExchangeRate", "1.00", "BASE"),
      row("$LEDGER-ExchangeRate", "1.00", "USD"),
      row("$LEDGER-ExchangeRate", "0.1284", "HKD"),
      row("$LEDGER-ExchangeRate", "0.7712", "SGD"),
      row("$LEDGER-ExchangeRate", "0", "EUR"),          // not a rate
      row("$LEDGER-ExchangeRate", "", "JPY"),           // nor is nothing
      row("$LEDGER-ExchangeRate", "-1", "CHF"),
    ], [], null);
    expect(got.exchange_rates).toEqual({ USD: 1, HKD: 0.1284, SGD: 0.7712 });
  });

  it("gives the base currency a rate of 1 though no row says so", () => {
    const got = accountAnswer("U0000000", [row("NetLiquidation", "1.00", "USD")], [], null);
    expect(got.exchange_rates).toEqual({ USD: 1 });
    expect(accountAnswer("U0000000", [], [], null).exchange_rates).toEqual({});
  });

  it("says nothing of a total, or of the base, the gateway did not send", () => {
    const got = accountAnswer("DU0000000", [row("RealizedPnL", "0.00", "BASE")], [], null);
    expect(got).toMatchObject({
      paper: true, base_currency: null, updated_at: null,
      totals: { net_liquidation: null, total_cash: null, unrealized_pnl: null, realized_pnl: 0 },
    });
  });

  it("never carries the account id in full", () => {
    const got = accountAnswer("U1234567", [row("AccountCode", "U1234567", "")], [], null);
    expect(JSON.stringify(got)).not.toContain("1234567");
  });
});
