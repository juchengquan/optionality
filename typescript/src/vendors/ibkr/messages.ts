/** The ten messages this client sends, and the fifteen it reads.
 *
 *  Read-only by construction: there is no order message here, and none is importable, so "this
 *  service cannot trade" is true by absence rather than by discipline. IB Gateway's own Read-Only
 *  API switch is the second, independent lock.
 *
 *  Five are a quote fetch's. Since ADR 0030 the sixth, reqAccountUpdates, reads the account: its
 *  values, its portfolio as IBKR marks it, the time of the last update and the download's end,
 *  each carrying the account's NAME rather than a request id — and the managed accounts, which
 *  the gateway sends with every handshake and this client used to ignore. Since ADR 0031 four more
 *  hold the account while asked: reqPnL and reqPnLSingle subscribe to the account's P&L and to one
 *  holding's, each by a request id, and their two cancels stop them; PNL and PNL_SINGLE answer.
 *  Reading an account is not trading it: nothing here can place, change or cancel an order.
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
import type { AccountValueRow, PnlRow, PnlSingleRow, PortfolioRow } from "./fields.ts";
import { notComputed, readFields, toFields } from "./wire.ts";

/** Outgoing message ids. */
const OUT = {
  REQ_MKT_DATA: 1, CANCEL_MKT_DATA: 2, REQ_ACCT_DATA: 6, REQ_CONTRACT_DATA: 9,
  REQ_MARKET_DATA_TYPE: 59, REQ_PNL: 92, CANCEL_PNL: 93, REQ_PNL_SINGLE: 94, CANCEL_PNL_SINGLE: 95,
} as const;

/** Incoming message ids — only the ones a read-only quote fetch or account read can receive. */
const IN = {
  TICK_PRICE: 1, ERROR: 4, ACCT_VALUE: 6, PORTFOLIO_VALUE: 7, ACCT_UPDATE_TIME: 8,
  NEXT_VALID_ID: 9, CONTRACT_DATA: 10, MANAGED_ACCTS: 15, TICK_OPTION_COMPUTATION: 21,
  CONTRACT_DATA_END: 52, ACCT_DOWNLOAD_END: 54, TICK_SNAPSHOT_END: 57, MARKET_DATA_TYPE: 58,
  PNL: 94, PNL_SINGLE: 95,
} as const;

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

/** Ask for one contract's figures, as a snapshot (`snapshot` true) or a stream.
 *
 *  `client.ts` asks an option for a snapshot and an INDEX for a stream, because a snapshot of an
 *  index carries no figure at any hour: the account has no snapshot permission for one (#257,
 *  `index-in-the-session`). It is still one ask and one answer: the stream is cancelled when the
 *  ask finishes, so no running board of prices outlives it to make a dead session look like a
 *  calm market. */
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

/** Subscribe to an account's values and portfolio (`subscribe` true), or stop (`false`): ibapi
 *  9.81's reqAccountUpdates, version 2, field for field. The account code is sent whatever the
 *  login manages, because the messages that answer carry the account's name and no request id:
 *  naming it is the only way to know which answer is the one asked for. */
export function reqAccountUpdates(subscribe: boolean, account: string): string {
  const VERSION = 2;
  return toFields([OUT.REQ_ACCT_DATA, VERSION, subscribe, account]);
}

/** Subscribe to an account's P&L (ADR 0031): its daily, unrealised and realised P&L in the base
 *  currency, pushed about once a second while it stands. No version field, as in ibapi 9.81 and
 *  `ib_async`; the model code is blank, which is the whole account. */
export function reqPnL(reqId: number, account: string): string {
  return toFields([OUT.REQ_PNL, reqId, account, ""]);
}

export function cancelPnL(reqId: number): string {
  return toFields([OUT.CANCEL_PNL, reqId]);
}

/** Subscribe to one holding's P&L and value, in its own currency, pushed when they change. The
 *  conId is the portfolio row's, sent as the text the gateway wrote it in. */
export function reqPnLSingle(reqId: number, account: string, conId: string): string {
  return toFields([OUT.REQ_PNL_SINGLE, reqId, account, "", conId]);
}

export function cancelPnLSingle(reqId: number): string {
  return toFields([OUT.CANCEL_PNL_SINGLE, reqId]);
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
  /** MANAGED_ACCTS' one field as sent: the login's account ids, comma-separated */
  | { kind: "accounts"; list: string }
  | { kind: "accountValue"; account: string; row: AccountValueRow }
  /** the contract id is the row's identity: a later row for it replaces the earlier one */
  | { kind: "portfolio"; account: string; conId: string; row: PortfolioRow }
  /** ACCT_UPDATE_TIME: a time of day as the gateway wrote it, with no date */
  | { kind: "accountTime"; time: string }
  | { kind: "accountEnd"; account: string }
  /** PNL: the account's P&L stream, its figures as sent (`fields.ts`' `pnlFrom` reads them) */
  | { kind: "pnl"; reqId: number; row: PnlRow }
  /** PNL_SINGLE: one holding's, as sent (`pnlSingleFrom`) */
  | { kind: "pnlSingle"; reqId: number; row: PnlSingleRow }
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

/** An id, a tick type, a grade or an error code: a field that names something rather than
 *  measures it. Read with a bare `Number`, so an empty one becomes 0 — which is harmless for
 *  these and only these: no request is ever sent with id 0 (`client.ts` counts from 1), so a reply
 *  routed to 0 reaches nobody; tick type 0 is a size, which `PRICE_TICKS` does not map; grade 0
 *  is not a grade; message id 0 is no message this decoder reads; and an error is acted on by its
 *  kind and its request id, never by whether its code is 0. Figures go through `reading` below. */
function num(fields: string[], at: number): number {
  return Number(fields[at]);
}

/** A FIGURE, or null where the field carries none.
 *
 *  Not `Number` alone, because `Number("")` is 0, and 0 passes every finiteness check. An empty
 *  field is the gateway declining to answer that one (`readFields` keeps it so nothing after it
 *  shifts), and read as a number it becomes a figure nobody sent. Recorded on 2026-11-09: SPX
 *  before the cash session sent its previous close with an empty price, and the strip would have
 *  read a close of 0.00. The sentinels are a separate matter, decided by each reader below.
 */
function reading(fields: string[], at: number): number | null {
  const text = fields[at];
  if (text === undefined || text.trim() === "") return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
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
 *  Zero is kept. An empty book quotes 0, and whether a 0 makes a mid is the domain's `midPrice`
 *  to decide (#380: an ask of zero is no offer, so it does not), not this decoder's to pre-empt —
 *  the side itself is still what the gateway said. But a zero the gateway SENT is "0"; an empty
 *  field is no price at all, and `reading` keeps the two apart.
 */
function price(fields: string[], at: number): number | null {
  const value = reading(fields, at);
  if (value === null || value === -1) return null;
  return value;
}

/** A figure that may not have been computed. The sentinels are NUMBERS — -2 for a greek, -1 for
 *  a price — so this is the difference between a null delta and a delta of minus two. */
function figure(fields: string[], at: number, what: string): number | null {
  const value = reading(fields, at);
  if (value === null) return null;
  return notComputed(what, value) ? null : value;
}

/** A field as the text it came as, empty where the message ended before it. */
function text(fields: string[], at: number): string {
  return fields[at] ?? "";
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

    // The account's messages, every field kept as the text it came as: what a field MEANS is
    // `fields.ts`' (`holdingFrom`, `accountAnswer`), which the Python port reads the same text
    // through. Each has a version field after its id, and none of them a request id.
    case IN.MANAGED_ACCTS:
      return { kind: "accounts", list: text(f, 2) };

    case IN.ACCT_VALUE:
      // 0 id, 1 version, 2 key, 3 value, 4 currency, 5 account
      return {
        kind: "accountValue", account: text(f, 5),
        row: { key: text(f, 2), value: text(f, 3), currency: text(f, 4) },
      };

    case IN.PORTFOLIO_VALUE:
      // version 8's layout, which ibapi 9.81 reads at every protocol above 101, counted out:
      //   0 id, 1 version, 2 conId, 3 symbol, 4 secType, 5 expiry, 6 strike, 7 right,
      //   8 multiplier, 9 primaryExchange, 10 currency, 11 localSymbol, 12 tradingClass,
      //   13 position, 14 marketPrice, 15 marketValue, 16 averageCost, 17 unrealizedPNL,
      //   18 realizedPNL, 19 account
      return {
        kind: "portfolio", account: text(f, 19), conId: text(f, 2),
        row: {
          sec_type: text(f, 4), symbol: text(f, 3), expiry: text(f, 5), strike: text(f, 6),
          right: text(f, 7), multiplier: text(f, 8), currency: text(f, 10),
          position: text(f, 13), market_price: text(f, 14), market_value: text(f, 15),
          average_cost: text(f, 16), unrealized_pnl: text(f, 17), realized_pnl: text(f, 18),
        },
      };

    case IN.ACCT_UPDATE_TIME:
      return { kind: "accountTime", time: text(f, 2) };

    case IN.ACCT_DOWNLOAD_END:
      return { kind: "accountEnd", account: text(f, 2) };

    // The P&L streams' (ADR 0031), with no version field, every figure kept as the text it came
    // as: what an unset or empty one MEANS is `fields.ts`', which the Python port reads alike.
    case IN.PNL:
      // 0 id, 1 reqId, 2 dailyPnL, 3 unrealizedPnL, 4 realizedPnL
      return {
        kind: "pnl", reqId: num(f, 1),
        row: { daily_pnl: text(f, 2), unrealized_pnl: text(f, 3), realized_pnl: text(f, 4) },
      };

    case IN.PNL_SINGLE:
      // 0 id, 1 reqId, 2 pos, 3 dailyPnL, 4 unrealizedPnL, 5 realizedPnL, 6 value
      return {
        kind: "pnlSingle", reqId: num(f, 1),
        row: {
          position: text(f, 2), daily_pnl: text(f, 3), unrealized_pnl: text(f, 4),
          realized_pnl: text(f, 5), value: text(f, 6),
        },
      };

    default:
      return { kind: "other", id };
  }
}
