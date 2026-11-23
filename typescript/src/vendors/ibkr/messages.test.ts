import { describe, expect, it } from "vitest";

import {
  type TwsContract, cancelMktData, readMessage, reqAccountUpdates,
  reqContractDetails,
  reqMarketDataType, reqMktData,
} from "./messages.ts";
import { MARKET_DATA_DELAYED_FROZEN } from "./fields.ts";
import { readFields } from "./wire.ts";

const NUL = "\u0000";
const msg = (...fields: (string | number)[]) => fields.map((f) => `${f}${NUL}`).join("");

/** The contract the probes of 2026-11-08 asked about, which the gateway resolved to
 *  conId 902390015. Using the real one means a layout mistake shows up as a wrong number here
 *  rather than only against a live gateway. */
const SPXW: TwsContract = {
  symbol: "SPX", secType: "OPT" as const, lastTradeDateOrContractMonth: "20261218",
  strike: 8100, right: "C" as const,
  tradingClass: "SPXW", exchange: "SMART", currency: "USD", multiplier: "100",
};

describe("asking who a contract is", () => {
  it("sends the fields in the order the reference client sends them", () => {
    const f = readFields(reqContractDetails(1, SPXW));
    // Not my arithmetic: this is what the official Python client put on the wire for the same
    // contract at protocol 157, captured on 2026-11-08 with its sendMsg intercepted. The first
    // draft of our encoder wrote the strike as "8100" where the reference writes "8100.0".
    expect(f).toEqual([
      "9", "8", "1",                                       // message, version, request id
      "0", "SPX", "OPT", "20261218", "8100.0", "C", "100", // conId 0 = describing, not naming
      "SMART", "", "USD", "", "SPXW",
      "0", "", "",                                         // includeExpired, secIdType, secId
    ]);
  });

  it("never asks about an expired contract", () => {
    // an expired option has no live quote, and including them makes the gateway answer with
    // several contracts for one strike — which would make the conId ambiguous
    expect(readFields(reqContractDetails(1, SPXW))[15]).toBe("0");
  });
});

describe("asking for figures", () => {
  it("matches the reference client's field list exactly", () => {
    // the same capture as above, for the data request
    expect(readFields(reqMktData(7, SPXW, true))).toEqual([
      "1", "11", "7",
      "0", "SPX", "OPT", "20261218", "8100.0", "C", "100", "SMART", "", "USD", "", "SPXW",
      "0", "", "1", "0", "",
    ]);
  });

  it("asks one-shot, and never for the chargeable snapshot", () => {
    const f = readFields(reqMktData(7, SPXW, true));
    expect(f.slice(0, 3)).toEqual(["1", "11", "7"]);
    expect(f[f.length - 3]).toBe("1");   // snapshot
    expect(f[f.length - 2]).toBe("0");   // regulatorySnapshot, which costs money per call
  });

  it("carries the same contract fields as the lookup, in the same order", () => {
    // the two requests share one builder for exactly this reason: a field added to one and not
    // the other shifts everything after it, and the gateway would answer about a DIFFERENT option
    const lookup = readFields(reqContractDetails(1, SPXW)).slice(3, 15);
    const data = readFields(reqMktData(1, SPXW, true)).slice(3, 15);
    expect(data).toEqual(lookup);
  });

  it("asks for delayed-frozen, which is the only grade an unsubscribed index answers", () => {
    // FROZEN (2) was the obvious choice and delivered NOTHING for an index this account is not
    // subscribed to: measured 2026-11-08, grade 2 gave `354 not subscribed` and grade 4 gave
    // 7374.85 for the same index in the same session. It does not give up live data where there
    // IS an entitlement — a request for the delayed grade on a subscribed option was granted
    // grade 1 the same day.
    expect(readFields(reqMarketDataType(MARKET_DATA_DELAYED_FROZEN))).toEqual(["59", "1", "4"]);
  });

  it("cancels by request id", () => {
    expect(readFields(cancelMktData(7))).toEqual(["2", "2", "7"]);
  });
});

describe("reading the contract answer", () => {
  it("finds the conId where the reference decoder puts it", () => {
    // The real shape, counted out: the first draft read conId from index 14 and localSymbol from
    // 11 — both one too far — and nothing but this test distinguishes that from correct. It would
    // have returned minTick as the conId, which is a number, and the request would then have
    // asked the gateway about contract 0.05.
    const answer = msg(
      10, 8, 1,                                 // id, version, reqId
      "SPX", "OPT", "20261218", "8100", "C", "SMART", "USD",
      "SPXW  261218C08100000",                  // localSymbol
      "SPX", "SPXW",                            // marketName, tradingClass
      902390015,                                // conId — the one the gateway really returned
      "0.05",                                   // minTick, which the old indexes read instead
    );
    const got = readMessage(answer);
    expect(got).toEqual({
      kind: "contract", reqId: 1, conId: 902390015, localSymbol: "SPXW  261218C08100000",
    });
  });

  it("reads the end of the answer separately from the answer", () => {
    expect(readMessage(msg(52, 1, 1))).toEqual({ kind: "contractEnd", reqId: 1 });
  });
});

describe("reading the greeks", () => {
  // The figures the gateway really sent on 2026-11-08 at protocol 157 — ALL of them now. The
  // first draft of this fixture carried an invented optPrice (4.05) and undPrice (6702.5) under
  // a comment claiming they were measured; the probe that produced the greeks had never printed
  // those two fields. Running our own client against the gateway produced the real pair, and the
  // underlying price turns out to be absent entirely.
  const real = msg(21, 100, 13, 0, 0.13679778548286392, 0.02806614063578037,
    3.624407920679289, 0, 0.00018826189971762677, 1.8321828845155324, -0.28028107934963487, -1);

  it("reads delta and the rest off a real message", () => {
    const got = readMessage(real);
    expect(got.kind).toBe("greeks");
    if (got.kind !== "greeks") throw new Error("unreachable");
    expect(got.reqId).toBe(100);
    expect(got.tickType).toBe(13);
    expect(got.figures.delta).toBeCloseTo(0.0280661, 7);
    expect(got.figures.impliedVol).toBeCloseTo(0.1367978, 7);
    expect(got.figures.gamma).toBeCloseTo(0.000188262, 9);
    expect(got.figures.vega).toBeCloseTo(1.8321829, 7);
    expect(got.figures.theta).toBeCloseTo(-0.2802811, 7);
    expect(got.figures.optPrice).toBeCloseTo(3.6244079, 7);
    // the gateway prices the OPTION and declines the index, which is a real shape rather than a
    // degenerate one: greeks arrive computed while the underlying does not
    expect(got.figures.undPrice).toBe(null);
  });

  it("turns a not-computed sentinel into no figure, not into minus two", () => {
    // -2 is a finite double and would render as a delta of -2.00 on the dashboard, beside a
    // perfectly ordinary-looking price. This is the whole reason the sentinels are in `wire.ts`.
    const unset = msg(21, 100, 13, 0, -1, -2, -1, 0, -2, -2, -2, -1);
    const got = readMessage(unset);
    if (got.kind !== "greeks") throw new Error("unreachable");
    expect(got.figures).toEqual({
      impliedVol: null, delta: null, gamma: null, vega: null, theta: null,
      optPrice: null, undPrice: null,
    });
  });

  it("turns an EMPTY field into no figure, not into zero", () => {
    // the same pitfall as an empty price: `Number("")` is 0, and a delta or theta of exactly
    // zero is a plausible figure that no sentinel check would catch
    const empty = msg(21, 100, 13, 0, "", "", "", 0, "", "", "", "");
    const got = readMessage(empty);
    if (got.kind !== "greeks") throw new Error("unreachable");
    expect(got.figures).toEqual({
      impliedVol: null, delta: null, gamma: null, vega: null, theta: null,
      optPrice: null, undPrice: null,
    });
  });

  it("keeps a put's negative delta, which is a figure and not a sentinel", () => {
    const put = msg(21, 100, 13, 0, 0.21, -0.42, 3.1, 0, 0.0002, 1.4, -0.3, 6702.5);
    const got = readMessage(put);
    if (got.kind !== "greeks") throw new Error("unreachable");
    expect(got.figures.delta).toBeCloseTo(-0.42, 2);
  });
});

describe("reading everything else", () => {
  it("reads a price tick", () => {
    expect(readMessage(msg(1, 6, 100, 1, 3.5, 0, 0)))
      .toEqual({ kind: "price", reqId: 100, tickType: 1, price: 3.5 });
  });

  it("reads -1 as no price, because nothing here can cost minus one", () => {
    // Measured: SKEW is only calculated 15:00-19:00 Chicago, and outside that window the real
    // gateway answered the last-price tick with -1.0 on 2026-11-08. Live mode on a shut market
    // says the same for bid and ask. The official Python client passes -1 through untouched —
    // it serves combo contracts too, where a negative price is a real credit — and this client
    // never asks for a combo (`messages.ts` hardcodes secType OPT, and indices are the only
    // other thing it names), so for us -1 is unambiguously "no value" and typing it as a number
    // would put -1.00 on the dashboard beside figures that are real.
    expect(readMessage(msg(1, 6, 100, 4, -1, 0, 0)))
      .toEqual({ kind: "price", reqId: 100, tickType: 4, price: null });
  });

  it("keeps a price of zero, which is a figure and not a sentinel", () => {
    // an empty book quotes 0, and ADR 0018's positivity guard is what decides whether 0 may be
    // shown — that is the Reference's judgement to make, not this decoder's to pre-empt
    expect(readMessage(msg(1, 6, 100, 1, 0, 0, 0)))
      .toEqual({ kind: "price", reqId: 100, tickType: 1, price: 0 });
  });

  it("reads an EMPTY price as no price, not as a price of zero", () => {
    // Recorded on 2026-11-09 and again on 2026-11-10 (`index-in-the-session`'s notes): a
    // SNAPSHOT of SPX sends its previous close (tick 9) with the price field empty, before the
    // open and in the session alike. `Number("")` is 0 and passes a finiteness check, so that
    // close read as 0.00, a figure the gateway never sent.
    expect(readMessage(msg(1, 6, 100, 9, "", 0, 0)))
      .toEqual({ kind: "price", reqId: 100, tickType: 9, price: null });
  });

  it("reads an error with its code, which is how a refusal is told from an outage", () => {
    expect(readMessage(msg(4, 2, 100, 10090, "Part of requested market data is not subscribed")))
      .toEqual({
        kind: "error", reqId: 100, code: 10090,
        message: "Part of requested market data is not subscribed",
      });
  });

  it("reads which grade of data the gateway actually granted", () => {
    // asked for frozen and given something else is exactly the silent downgrade an alarm must
    // never run on, so the gateway's own answer is read rather than assumed
    expect(readMessage(msg(58, 1, 100, 2))).toEqual({ kind: "dataType", reqId: 100, type: 2 });
  });

  it("shrugs at a message it does not read, rather than failing the sweep", () => {
    // the gateway volunteers plenty nobody asked for — farm notices, account summaries — and
    // treating the unexpected as fatal would break a sweep over a message meant for no one
    expect(readMessage(msg(12, 1, 7, 0, 1, 0, 4.1, 3))).toEqual({ kind: "other", id: 12 });
  });
});

describe("the account (ADR 0030)", () => {
  // Every layout here is ibapi 9.81's at protocol 157: its reqAccountUpdates encoder, and its
  // decoder's reading of each message, run on 2026-11-23 over these exact fields. Every figure and
  // account id is invented.
  it("subscribes and unsubscribes as the reference client does, naming the account", () => {
    expect(readFields(reqAccountUpdates(true, "U0000000"))).toEqual(["6", "2", "1", "U0000000"]);
    expect(readFields(reqAccountUpdates(false, "U0000000"))).toEqual(["6", "2", "0", "U0000000"]);
  });

  it("reads the managed accounts, which come with the handshake", () => {
    expect(readMessage(msg(15, 1, "U0000000,U0000001")))
      .toEqual({ kind: "accounts", list: "U0000000,U0000001" });
  });

  it("reads an account value as its key, value and currency, and whose it is", () => {
    expect(readMessage(msg(6, 2, "NetLiquidation", "184523.17", "USD", "U0000000"))).toEqual({
      kind: "accountValue", account: "U0000000",
      row: { key: "NetLiquidation", value: "184523.17", currency: "USD" },
    });
  });

  it("reads a portfolio row at version 8's positions, every field as sent", () => {
    // 0 id, 1 version, 2 conId, 3 symbol, 4 secType, 5 expiry, 6 strike, 7 right, 8 multiplier,
    // 9 primaryExchange, 10 currency, 11 localSymbol, 12 tradingClass, 13 position,
    // 14 marketPrice, 15 marketValue, 16 averageCost, 17 unrealizedPNL, 18 realizedPNL, 19 account
    const row = msg(7, 8, 100000202, "ACME", "OPT", "20261218", "35.0", "P", "100", "", "USD",
      "ACME  261218P00035000", "ACME", "-6", "0.92", "-552.0", "141.8", "298.8", "-412.8",
      "U0000000");
    expect(readMessage(row)).toEqual({
      kind: "portfolio", account: "U0000000", conId: "100000202",
      row: {
        sec_type: "OPT", symbol: "ACME", expiry: "20261218", strike: "35.0", right: "P",
        multiplier: "100", currency: "USD", position: "-6", market_price: "0.92",
        market_value: "-552.0", average_cost: "141.8", unrealized_pnl: "298.8",
        realized_pnl: "-412.8",
      },
    });
  });

  it("reads the update time as the clock time it is, and the download's end", () => {
    expect(readMessage(msg(8, 1, "14:32"))).toEqual({ kind: "accountTime", time: "14:32" });
    expect(readMessage(msg(54, 1, "U0000000"))).toEqual({ kind: "accountEnd", account: "U0000000" });
  });
});
