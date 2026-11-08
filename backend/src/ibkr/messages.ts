/** The five messages this client sends, and the eight it reads.
 *
 *  Read-only by construction: there is no order message here, and none is importable, so "this
 *  service cannot trade" is true by absence rather than by discipline. IB Gateway's own Read-Only
 *  API switch is the second, independent lock.
 *
 *  `secType` is a field rather than a constant since ADR 0019: an index is `IND` and resolves on
 *  the exchange that calculates it, which is how SPX and VIX are reached at all — moomoo refuses
 *  every index as a class.
 *
 *  ## Why the layouts are the official Python client's, field for field
 *
 *  Every encoding below mirrors `ibapi` 9.81's, and that choice is EMPIRICAL rather than
 *  deferential: on 2026-11-08 that client resolved a real contract and read real greeks from the
 *  gateway on this machine, which speaks protocol 157. So its encoding is known-accepted by the
 *  gateway we have, where my reading of IBKR's documentation would only be known-plausible.
 *
 *  Above `MIN_SERVER_VERSION` every optional field in these messages is included — each one is
 *  gated at protocol 114 or below, and `handshake.ts` refuses anything under 156. That is what
 *  buys the absence of version branches here, and it is the whole reason for the floor.
 */
import { notComputed, readFields, toFields } from "./wire.ts";

/** Outgoing message ids. */
const OUT = {
  REQ_MKT_DATA: 1, CANCEL_MKT_DATA: 2, REQ_CONTRACT_DATA: 9, REQ_MARKET_DATA_TYPE: 59,
} as const;

/** Incoming message ids — only the ones a read-only quote fetch can receive. */
const IN = {
  TICK_PRICE: 1, ERROR: 4, NEXT_VALID_ID: 9, CONTRACT_DATA: 10,
  TICK_OPTION_COMPUTATION: 21, CONTRACT_DATA_END: 52, TICK_SNAPSHOT_END: 57,
  MARKET_DATA_TYPE: 58,
} as const;

/** How the market data a request gets is graded, and which grade this service asks for.
 *
 *  DELAYED_FROZEN, not FROZEN, and the difference is not subtle: for an instrument the account is
 *  not subscribed to, asking for FROZEN delivers NOTHING. Measured twice on 2026-11-08, same
 *  index, same session:
 *
 *      reqMarketDataType(2)  SPX → `354 not subscribed`, no figures at all
 *      reqMarketDataType(4)  SPX → last 7374.85
 *
 *  Found by adding a real Reference and watching it read a dash while Yahoo's read 7376.86 beside
 *  it. FROZEN was the obvious choice and the wrong one — it means "the last live-entitled figure",
 *  so it has nothing to serve where there is no entitlement.
 *
 *  Asking for the delayed grade does NOT give up live data where it is entitled: measured the same
 *  day, a request for grade 3 on a subscribed option was granted grade 1. The gateway falls back
 *  rather than downgrades, and it reports which grade it actually served — which is why the
 *  freshness marks on the strip come from its answer rather than from this constant.
 */
export const MARKET_DATA_DELAYED_FROZEN = 4;

/** One option, named the way IB Gateway names them rather than the way the service does.
 *  `contract.ts`'s `parseSpxCode` is what turns a service code into this. */
export interface TwsContract {
  symbol: string;
  /** `OPT` for an option, `IND` for an index. Nothing else: this client reads market data for the
   *  Securities the service watches and keeps on the page, and an ETF needs an entitlement this
   *  account does not have (measured 2026-11-08: SPY answers `10089`, requires a subscription). */
  secType: "OPT" | "IND";
  lastTradeDateOrContractMonth: string;
  strike: number;
  /** empty for an index, which has no side */
  right: "C" | "P" | "";
  /** empty for an index, which has no trading class */
  tradingClass: string;
  exchange: string;
  currency: string;
  multiplier: string;
}

/** The contract fields, in the order both requests below carry them. Shared because they must
 *  stay identical: a field added to one and not the other is a silent shift. */
/** A strike as the reference client writes it.
 *
 *  Python's `str(8100.0)` is "8100.0"; JavaScript's `String(8100)` is "8100". The gateway parses
 *  both as a double, so this is not known to matter — but the justification for every layout in
 *  this file is that ibapi 9.81's bytes are known-ACCEPTED by the gateway we have, and a field
 *  spelled differently is outside what was proved. Measured against the reference encoder on
 *  2026-11-08; `messages.test.ts` pins the whole field list it produced.
 */
function decimal(value: number): string {
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

function contractFields(c: TwsContract): (string | number)[] {
  return [
    0,                                  // conId: 0 means "I am describing it rather than naming it"
    c.symbol, c.secType, c.lastTradeDateOrContractMonth, decimal(c.strike), c.right, c.multiplier,
    c.exchange, "",                     // primaryExchange, which SMART routing does not need
    c.currency, "",                     // localSymbol, which is what we are asking the gateway FOR
    c.tradingClass,
  ];
}

/** Ask what contract this actually is. The answer carries the conId every later request uses. */
export function reqContractDetails(reqId: number, c: TwsContract): string {
  const VERSION = 8;
  return toFields([
    OUT.REQ_CONTRACT_DATA, VERSION, reqId, ...contractFields(c),
    false,                              // includeExpired: an expired contract is not a live quote
    "", "",                             // secIdType, secId — not how this service names anything
  ]);
}

/** Ask for one contract's figures. `snapshot` true is the one-shot form (ADR: one ask, one
 *  answer); the streaming form is deliberately unused, because a running board of prices would
 *  make a dead session look like a calm market. */
export function reqMktData(reqId: number, c: TwsContract, snapshot: boolean): string {
  const VERSION = 11;
  return toFields([
    OUT.REQ_MKT_DATA, VERSION, reqId, ...contractFields(c),
    false,                              // deltaNeutralContract: none
    "",                                 // genericTickList: the default ticks carry bid/ask/greeks
    snapshot,
    false,                              // regulatorySnapshot, which COSTS money per call
    "",                                 // mktDataOptions
  ]);
}

export function cancelMktData(reqId: number): string {
  const VERSION = 2;
  return toFields([OUT.CANCEL_MKT_DATA, VERSION, reqId]);
}

export function reqMarketDataType(type: number): string {
  const VERSION = 1;
  return toFields([OUT.REQ_MARKET_DATA_TYPE, VERSION, type]);
}

/** What the gateway said. Anything this client does not read becomes `{ kind: "other" }` rather
 *  than an error: the gateway volunteers plenty — account summaries, news, farm notices — and a
 *  reader that treats the unexpected as fatal would fall over on a message meant for nobody. */
export type Incoming =
  | { kind: "serverTime"; orderId: number }
  | { kind: "contract"; reqId: number; conId: number; localSymbol: string }
  | { kind: "contractEnd"; reqId: number }
  | { kind: "price"; reqId: number; tickType: number; price: number | null }
  | { kind: "greeks"; reqId: number; tickType: number; figures: Greeks }
  | { kind: "snapshotEnd"; reqId: number }
  | { kind: "dataType"; reqId: number; type: number }
  | { kind: "error"; reqId: number; code: number; message: string }
  | { kind: "other"; id: number };

export interface Greeks {
  impliedVol: number | null;
  delta: number | null;
  gamma: number | null;
  vega: number | null;
  theta: number | null;
  optPrice: number | null;
  undPrice: number | null;
}

function num(fields: string[], at: number): number {
  return Number(fields[at]);
}

/** A price, or null where the gateway means it has none.
 *
 *  -1 is the gateway's "no value" on a price tick, and this is a deliberate DIVERGENCE from the
 *  official Python client, which passes it through untouched. That client is general-purpose and
 *  serves combo contracts, where a negative price is a real credit; this one asks only about
 *  options and indices — `contractFields` hardcodes secType OPT — and neither can cost minus one.
 *
 *  Measured rather than read: SKEW is calculated only 15:00–19:00 Chicago and answered -1.0
 *  outside that window on 2026-11-08, and live mode on a shut market says the same for bid and
 *  ask. Typing it as a number would put `-1.00` on the dashboard beside figures that are real.
 *
 *  Zero is kept. An empty book quotes 0, and whether 0 may be shown is ADR 0018's positivity
 *  guard to decide for a Reference, not this decoder's to pre-empt.
 */
function price(fields: string[], at: number): number | null {
  const value = Number(fields[at]);
  if (!Number.isFinite(value) || value === -1) return null;
  return value;
}

/** A figure that may not have been computed. The sentinels are NUMBERS — -2 for a greek, -1 for
 *  a price — so this is the difference between a null delta and a delta of minus two. */
function figure(fields: string[], at: number, what: string): number | null {
  const value = Number(fields[at]);
  if (!Number.isFinite(value)) return null;
  return notComputed(what, value) ? null : value;
}

export function readMessage(payload: string): Incoming {
  const f = readFields(payload);
  const id = Number(f[0]);
  switch (id) {
    case IN.NEXT_VALID_ID:
      // the gateway sends this unasked once the session is up, and it is the only signal that
      // the handshake FINISHED rather than merely got a greeting
      return { kind: "serverTime", orderId: num(f, 2) };

    case IN.CONTRACT_DATA:
      // Counted out in full, because the first draft of this line had conId at 14 and the
      // compiler cannot catch an index that is merely wrong:
      //   0 id, 1 version, 2 reqId, 3 symbol, 4 secType, 5 expiry, 6 strike, 7 right,
      //   8 exchange, 9 currency, 10 localSymbol, 11 marketName, 12 tradingClass, 13 conId
      // The expiry is ONE field — the reference decoder's readLastTradeDate splits it on a space
      // AFTER reading a single field — and every index past it depends on that being true.
      return { kind: "contract", reqId: num(f, 2), conId: num(f, 13), localSymbol: f[10] ?? "" };

    case IN.CONTRACT_DATA_END:
      return { kind: "contractEnd", reqId: num(f, 2) };

    case IN.TICK_PRICE:
      return { kind: "price", reqId: num(f, 2), tickType: num(f, 3), price: price(f, 4) };

    case IN.TICK_OPTION_COMPUTATION:
      // no version field at or above protocol 156, and a tickAttrib where it used to be. That
      // single difference is why `handshake.ts` refuses older gateways rather than guessing.
      return {
        kind: "greeks", reqId: num(f, 1), tickType: num(f, 2),
        figures: {
          impliedVol: figure(f, 4, "impliedVol"), delta: figure(f, 5, "delta"),
          optPrice: figure(f, 6, "optPrice"), undPrice: figure(f, 11, "undPrice"),
          gamma: figure(f, 8, "gamma"), vega: figure(f, 9, "vega"), theta: figure(f, 10, "theta"),
        },
      };

    case IN.TICK_SNAPSHOT_END:
      return { kind: "snapshotEnd", reqId: num(f, 2) };

    case IN.MARKET_DATA_TYPE:
      return { kind: "dataType", reqId: num(f, 2), type: num(f, 3) };

    case IN.ERROR:
      return { kind: "error", reqId: num(f, 2), code: num(f, 3), message: f[4] ?? "" };

    default:
      return { kind: "other", id };
  }
}
