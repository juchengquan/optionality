import { describe, expect, it } from "vitest";

import { contractFor } from "./contract.ts";

/** A service code, as the contract IB Gateway wants.
 *
 *  The code is the discriminator: `parseSpxCode` reads an option and cannot read an index, so
 *  nothing has to be stored about which kind a Reference is — and a stored kind could disagree
 *  with the code it sits beside.
 */

describe("an option, which the code parser can read", () => {
  it("becomes an OPT contract with its expiry, strike and side", () => {
    expect(contractFor("US.SPXW261218C8100000")?.contract).toEqual({
      symbol: "SPX",
      secType: "OPT",
      lastTradeDateOrContractMonth: "20261218",
      strike: 8100,
      right: "C",
      tradingClass: "SPXW",
      exchange: "SMART",
      currency: "USD",
      multiplier: "100",
    });
  });

  it("reads a put's side", () => {
    expect(contractFor("US.SPXW261218P6800000")?.contract.right).toBe("P");
  });

  it("carries the strike as a number, not a thousandth of one", () => {
    // the code spells 8100 as 8100000; a contract asking about strike 8100000 resolves to nothing
    expect(contractFor("US.SPXW261204C8100000")?.contract.strike).toBe(8100);
  });
});

describe("an index, which it cannot", () => {
  it("becomes an IND contract on the exchange that calculates it", () => {
    expect(contractFor("SPX")?.contract).toEqual({
      symbol: "SPX",
      secType: "IND",
      lastTradeDateOrContractMonth: "",
      strike: 0,
      right: "",
      tradingClass: "",
      exchange: "CBOE",
      currency: "USD",
      multiplier: "",
    });
  });

  it("knows which exchange, because guessing cost four failed lookups", () => {
    // measured 2026-11-08: SMART routing returns "no security definition" for an index, and
    // INDU resolved only on CME after NYSE, CBOE and SMART had all refused it
    expect(contractFor("VIX")?.contract.exchange).toBe("CBOE");
    expect(contractFor("NDX")?.contract.exchange).toBe("NASDAQ");
    expect(contractFor("COMP")?.contract.exchange).toBe("NASDAQ");
    expect(contractFor("INDU")?.contract.exchange).toBe("CME");
  });

  it("carries the whole VIX term structure, which no other vendor will quote", () => {
    for (const symbol of ["VIX9D", "VIX3M", "VIX6M", "VVIX"]) {
      expect(contractFor(symbol)?.contract.exchange, symbol).toBe("CBOE");
    }
  });

  it("strips the market prefix, which IBKR does not use", () => {
    // the service writes `US.` on moomoo's codes; a gateway names no market in a symbol
    expect(contractFor("US.SPX")?.contract.symbol).toBe("SPX");
    expect(contractFor("US..SPX")?.contract.symbol).toBe("SPX");
  });
});

describe("a code this client cannot name", () => {
  it("is null for a symbol no exchange is known for", () => {
    // null means "I cannot ask", which the caller reports as an unknown code. Sending it with a
    // guessed exchange would make a wrong guess and an unknown symbol the same error — and the
    // first is ours to prevent.
    expect(contractFor("TSLA")).toBe(null);
    expect(contractFor("IXIC")).toBe(null);
  });

  it("is null for an index name IBKR does not use", () => {
    // Yahoo calls the Nasdaq Composite ^IXIC and the Dow ^DJI; IBKR calls them COMP and INDU.
    // Three vendors, three vocabularies for one index.
    expect(contractFor("DJI")).toBe(null);
    expect(contractFor("DJIA")).toBe(null);
  });

  it("is null for an option code that parses to a date nothing expires on", () => {
    // `parseSpxCode` returns null for 2026-02-30, so this falls through to the index table and
    // finds no exchange — one null rather than a contract about a day that does not exist
    expect(contractFor("US.SPXW260230C8100000")).toBe(null);
  });
});
