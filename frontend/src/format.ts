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

/** "SPXW 261016 8050.00C" → "261016 8050C".
 *
 *  Every contract this service can create goes through build_spx_code, which hardcodes the
 *  SPXW symbol and builds the strike with int() — so the prefix and the decimals are
 *  identical on every row and carry no information at all. Eight of twenty characters, in
 *  the widest column on the page.
 *
 *  It matches strictly and returns anything else untouched: a name from a symbol this does
 *  not know about must not be quietly shortened into a different-looking contract. If SPX
 *  monthlies or fractional strikes ever appear, this stops applying rather than lying.
 */
const SPXW_NAME = /^SPXW (\d{6}) (\d+)\.00([CP])$/;

export function shortContract(name: string): string {
  const m = SPXW_NAME.exec(name);
  return m ? `${m[1]} ${m[2]}${m[3]}` : name;
}

/** "2026-10-16" → "261016", the form contract names use since they lost their SPXW. */
export function shortDate(iso: string): string {
  const m = /^(\d{2})(\d{2})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[2]}${m[3]}${m[4]}` : iso;
}
