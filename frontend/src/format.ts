import type { Leg } from "./api";

/** Display rules mirrored from the server so both dashboards read identically. */

// %.4g served money and greeks alike, which rendered prices as a bare "1" and gamma as
// "-9.351e-05". Per-column precision keeps decimal points lined up under tabular-nums.
const PLACES: Record<string, number> = {
  delta: 4, gamma: 6, theta: 4, vega: 4, iv: 2, mid: 2, bid: 2, ask: 2,
};

export const DASH = "—";

export function fmt(value: number | null | undefined, column: string): string {
  if (value === null || value === undefined) return DASH;
  return value.toFixed(PLACES[column] ?? 4);
}

export function fmtText(value: string | null | undefined): string {
  return value ?? DASH;
}

/** +C8100 -C8150: the signs are what the signed-sum engine keys off, so a leg entered
 *  backwards is visible at a glance. */
export function legSummary(legs: readonly Leg[]): string {
  return legs
    .map((l) => `${l.sign > 0 ? "+" : "-"}${l.option_type[0]}${l.strike}`)
    .join(" ");
}

const FIELD_LABEL: Record<string, string> = {
  option_delta: "delta",
  option_gamma: "gamma",
  option_theta: "theta",
  option_vega: "vega",
  option_implied_volatility: "IV",
  mid_price: "mid",
};

export function alarmText(field: string, direction: string, threshold: number, compare: string): string {
  const sign = direction === "below" ? "≤" : "≥";
  const mode = compare === "signed" ? " signed" : "";
  return `${FIELD_LABEL[field] ?? field} ${sign} ${threshold}${mode}`;
}

/** Column key whose cell carries the bar. Mirrors the server's fallback chain. */
export const FIELD_COLUMN: Record<string, string> = {
  option_delta: "delta",
  option_gamma: "gamma",
  option_theta: "theta",
  option_vega: "vega",
  option_implied_volatility: "iv",
  mid_price: "mid",
};
