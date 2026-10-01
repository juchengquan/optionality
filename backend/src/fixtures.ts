/** The config bodies the tests use. Carried over from tests/conftest.py (ADR 0009, phase 5).
 *
 *  Kept as source rather than inside a test file because the route suites, and the worker's in
 *  phase 6, all need the same two: a config the API accepts is the starting point of almost every
 *  other assertion.
 */
export const HOLDINGS_BODY = {
  notification: { file: { file_path: "./out.html" } },
  code_information: { type: "index", name: "SPX", market: "US" },
  option_holdings: [
    {
      strategy: "iron_condor",
      strike_date: "2026-12-18",
      volume: 1,
      entry_price: 1.25,
      warning_threshold: { delta: 0.3 },
      options: [{ type: "CALL", direction: "short", strike_price: 6500.0 }],
    },
  ],
} as const;

export const STRATEGY_BODY = {
  notification: { file: { file_path: "./out.html" } },
  code_information: { type: "index", name: "SPX", market: "US" },
  option_strategy: {
    strategy: "iron_condor",
    expiry_date_distance: { min: 5, max: 20 },
    options: [
      { option_type: "PUT", filter: { delta_min: -0.15, delta_max: -0.05 }, stride: 25 },
      { option_type: "CALL", filter: { delta_min: 0.05, delta_max: 0.15 }, stride: 25 },
    ],
  },
} as const;
