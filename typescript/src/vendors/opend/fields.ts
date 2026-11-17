/** The fields of a moomoo quote record, as `snapshot.ts`'s `toRecord` builds them.
 *
 *  A list rather than logic, because the logic cannot be shared: `toRecord` reads the websocket's
 *  protobuf and the Python's `optionality.opend` reads the SDK's 143-column frame, so the same
 *  quote reaches the two backends in two shapes. What CAN be held is what comes out — and until
 *  2026-11-17 nothing held it: a side-by-side run of both backends on the live database found the
 *  Python serving 107 `/quotes` keys the TypeScript does not, and missing `option_strike_time`.
 *
 *  `snapshot.test.ts` holds `toRecord` to this list, `make cases` records it in
 *  `testdata/vendors/opend-fields.json`, and `python/tests/test_opend.py` holds the Python to that.
 *  A field the service starts to read is added in all three, in one change. Pure, imports nothing,
 *  so `vendors/fields.ts` can open it without the SDK behind it.
 */
export const RECORD_FIELDS = [
  "code", "name", "update_time", "lot_size", "suspension",
  "last_price", "open_price", "high_price", "low_price", "prev_close_price",
  "ask_price", "bid_price", "ask_vol", "bid_vol", "volume",
  "turnover", "turnover_rate", "amplitude", "avg_price", "bid_ask_ratio",
  "option_type", "stock_owner", "option_strike_time", "option_strike_price",
  "option_contract_size", "option_contract_multiplier", "option_open_interest",
  "option_implied_volatility", "option_premium",
  "option_delta", "option_gamma", "option_vega", "option_theta", "option_rho",
  "option_expiry_date_distance", "option_area_type",
  "mid_price",
] as const;
