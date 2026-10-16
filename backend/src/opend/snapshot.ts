/** Turning a moomoo WebSocket snapshot into the record the service reads (ADR 0009, phase 6).
 *
 *  The Python SDK hands back a flat frame of 143 snake_case columns, nearly all of them absent for an
 *  option. The WebSocket hands back nested protobuf. This is the mapping between them, and it is the
 *  one place in the rewrite where a wrong name is silent: a missing `option_delta` does not throw, it
 *  makes a monitor stop alarming.
 *
 *  So it covers exactly the fields the service consumes — the dashboard's columns, the bot's tables,
 *  and the domain's maths — and every one is checked against the Python at the same instant by
 *  `make diff-opend`. Fields nothing reads are left out: transcribing a column we never look at would
 *  be unverified either way.
 */
import type { Long, Snapshot } from "./types.ts";
import type { Quote } from "../domain/quote.ts";

/** protobufjs decodes int64 to {low, high, unsigned}; the Python SDK gives a float. */
function fromLong(value: Long | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") return value;
  // high is the upper 32 bits. A volume cannot realistically need them, but reconstructing is one
  // multiply and guessing is a wrong number.
  return value.high * 2 ** 32 + (value.low >>> 0);
}

/** Market 11 is the US, which is the only market this service deals in. The prefix is not
 *  decoration: the Python's `code` carries it, every monitor's code carries it, and
 *  `build_spx_code` produces it. */
const MARKETS: Record<number, string> = { 11: "US" };

function qualify(market: number, code: string): string {
  return `${MARKETS[market] ?? String(market)}.${code}`;
}

/** The option type as the Python spells it. */
const OPTION_TYPE: Record<number, string> = { 1: "CALL", 2: "PUT" };
/** Where it may be exercised. */
const AREA_TYPE: Record<number, string> = { 1: "AMERICAN", 2: "EUROPEAN" };

/** Absent in the protobuf means absent in the record, not zero: a greek that did not arrive must read
 *  as unknown, and the domain already treats null as "no complete value — do not alarm". */
function put(into: Quote, key: string, value: unknown): void {
  if (value !== undefined && value !== null) into[key] = value;
}

/** One snapshot, in the shape fetch_snapshot returns. */
export function toRecord(snapshot: Snapshot): Quote {
  const { basic, optionExData: ex } = snapshot;
  const record: Quote = { code: qualify(basic.security.market, basic.security.code) };

  put(record, "name", basic.name);
  put(record, "update_time", basic.updateTime);
  put(record, "lot_size", basic.lotSize);
  put(record, "suspension", basic.isSuspend);
  put(record, "last_price", basic.curPrice);
  put(record, "open_price", basic.openPrice);
  put(record, "high_price", basic.highPrice);
  put(record, "low_price", basic.lowPrice);
  put(record, "prev_close_price", basic.lastClosePrice);
  put(record, "ask_price", basic.askPrice);
  put(record, "bid_price", basic.bidPrice);
  put(record, "ask_vol", fromLong(basic.askVol));
  put(record, "bid_vol", fromLong(basic.bidVol));
  put(record, "volume", fromLong(basic.volume));
  put(record, "turnover", basic.turnover);
  put(record, "turnover_rate", basic.turnoverRate);
  put(record, "amplitude", basic.amplitude);
  put(record, "avg_price", basic.avgPrice);
  put(record, "bid_ask_ratio", basic.bidAskRatio);

  if (ex) {
    put(record, "option_type", ex.type === undefined ? undefined : OPTION_TYPE[ex.type]);
    put(record, "stock_owner", ex.owner ? qualify(ex.owner.market, ex.owner.code) : undefined);
    put(record, "option_strike_time", ex.strikeTime);
    put(record, "option_strike_price", ex.strikePrice);
    // the Python reports the float one; they agree for SPX and the float is the authority
    put(record, "option_contract_size", ex.contractSizeFloat ?? ex.contractSize);
    put(record, "option_contract_multiplier", ex.contractMultiplier);
    put(record, "option_open_interest", ex.openInterest);
    put(record, "option_implied_volatility", ex.impliedVolatility);
    put(record, "option_premium", ex.premium);
    put(record, "option_delta", ex.delta);
    put(record, "option_gamma", ex.gamma);
    put(record, "option_vega", ex.vega);
    put(record, "option_theta", ex.theta);
    put(record, "option_rho", ex.rho);
    put(record, "option_expiry_date_distance", ex.expiryDateDistance);
    put(record, "option_area_type",
      ex.optionAreaType === undefined ? undefined : AREA_TYPE[ex.optionAreaType]);
  }

  // the mid is derived, not reported — and only when BOTH sides are there. A mid from one side is
  // a number that looks like a price and is not one.
  const bid = record.bid_price;
  const ask = record.ask_price;
  if (typeof bid === "number" && typeof ask === "number") {
    record.mid_price = (bid + ask) / 2;
  }
  return record;
}

export function toRecords(snapshots: Snapshot[]): Quote[] {
  return snapshots.map(toRecord);
}
