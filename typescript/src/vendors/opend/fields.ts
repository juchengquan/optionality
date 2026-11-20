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
 *  so `vendors/fields.ts` can open it without the SDK behind it. The quote grade below is the same
 *  kind of thing: pure, and recorded with the record.
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

/** GetUserInfo's `flag` for the quote rights alone (`UserInfoField_QotRight`, #464): what the client
 *  asks OpenD for, and nothing else of the account's — no nickname, no user id. Stated here rather
 *  than beside the request so `testdata/vendors/` records it and the Python is held to the same
 *  number, as `MARKET_DATA_DELAYED_FROZEN` is for IB Gateway: a fake answers whatever it is asked,
 *  so no test of either client could see which fields it asked for. */
export const USER_INFO_QOT_RIGHT = 4;

/** moomoo's quote grades (`Qot_Common.QotRight`), by the number OpenD sends, under the names the
 *  Python SDK gives them (its `QotRight` enum). The TypeScript reads the number off the websocket's
 *  protobuf and the Python reads the SDK's name, so this table is what makes the two backends name a
 *  grade the same way — and `python/tests/test_opend.py` holds it to the SDK's own. */
export const QOT_RIGHTS: Readonly<Record<number, string>> = {
  0: "N/A", 1: "BMP", 2: "LV1", 3: "LV2", 4: "SF", 5: "NO", 6: "LV3",
};

/** A grade OpenD sent, as the SDK names it: `QotRight.to_string2`, whose answer is "N/A" — moomoo's
 *  Unknow — for anything that is not one of the listed numbers, an absent field included. */
export function gradeName(right: unknown): string {
  return typeof right === "number" && Object.hasOwn(QOT_RIGHTS, right) ? QOT_RIGHTS[right]! : "N/A";
}

/** Whether a grade means the option prices are real-time (#464, the owner's decision): Level 1, 2
 *  or 3, or SF, are; BMP (a snapshot that cannot be subscribed) and NO are not; and "N/A", or any
 *  name moomoo has not used, says nothing either way.
 *
 *  A level, never a delay: moomoo states no minutes, so "not real-time" is all that can be said —
 *  unlike Yahoo's `exchangeDataDelayedBy`, which a Reference carries as `delayed_by_minutes`. */
export function isRealtime(grade: string): boolean | null {
  if (grade === "LV1" || grade === "LV2" || grade === "LV3" || grade === "SF") return true;
  if (grade === "BMP" || grade === "NO") return false;
  return null;
}
