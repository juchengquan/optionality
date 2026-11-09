/** Yahoo's quote, turned into the figures the rest of the service reads (ADR 0019, track D).
 *
 *  ## The bid and ask are deliberately dropped
 *
 *  Measured on 2026-11-08: `^GSPC` came back with `regularMarketPrice: 7376.86` — correct, and
 *  equal to Cboe's own published close — beside `bid: 7524.56` and `ask: 7624.67`. An index has no
 *  order book, so those are not a book; they are some other figure under a familiar name, and they
 *  are wrong by about 150 points with a 100-point spread.
 *
 *  Mapping them faithfully would be worse than ignoring them, because `domain/reference.ts`
 *  PREFERS the mid: the strip would have shown 7,574 instead of 7,376 and looked entirely
 *  plausible. So this mapping carries no bid, no ask and therefore no mid, and the domain falls
 *  back to the last price — which is the figure Yahoo actually means.
 *
 *  `^VIX` returned `bid: 0, ask: 0`, which ADR 0018's positivity guard would have rejected anyway.
 *  `^GSPC`'s are positive and wrong, which is the case a guard cannot catch.
 *
 *  ## Freshness comes from Yahoo's own fields
 *
 *  `exchangeDataDelayedBy` is a number of MINUTES that Yahoo states itself — 0 for `^GSPC`, 15
 *  for `^VIX`, on the same request. IBKR reports a tier and no duration, so only this source can
 *  say how late a figure is, and only this source does (ADR 0019).
 */
import type { Quote } from "../../domain/quote.ts";

/** One row of Yahoo's answer, narrowed to the fields this mapping reads. */
export interface YahooQuote {
  symbol?: string;
  shortName?: string;
  regularMarketPrice?: number;
  regularMarketPreviousClose?: number;
  exchangeDataDelayedBy?: number;
  marketState?: string;
}

/** The sessions in which an index is actually being calculated. Anything else — closed, pre- and
 *  post-market — means the figure is the last one Yahoo holds. */
const UPDATING = new Set(["REGULAR"]);

export function toRecord(code: string, row: YahooQuote): Quote {
  const record: Quote = { code };
  if (typeof row.shortName === "string") record.name = row.shortName;
  if (typeof row.regularMarketPrice === "number") record.last_price = row.regularMarketPrice;
  if (typeof row.regularMarketPreviousClose === "number") {
    record.prev_close_price = row.regularMarketPreviousClose;
  }

  // the two flags ADR 0019 settled, from what Yahoo said rather than from configuration
  const minutes = row.exchangeDataDelayedBy;
  if (typeof minutes === "number") {
    record.delayed = minutes > 0;
    // only where the source STATES a duration. IBKR reports a tier and no number, so the strip
    // says "delayed" for one vendor and "15m late" for the other — each what its vendor said.
    if (minutes > 0) record.delayed_by_minutes = minutes;
  }
  if (typeof row.marketState === "string") {
    record.last_known = !UPDATING.has(row.marketState);
  }
  return record;
}
