/** The computational half of service/monitor.py: what a monitor is watching, how far that value
 *  has travelled toward its threshold, and whether it has breached. Ported for ADR 0009, phase 3.
 *
 *  Nothing here touches a database, a clock or OpenD. The sweeper that does arrives in phase 6,
 *  and the breach rule below is lifted out of the middle of its loop so it can be checked on its
 *  own — in the Python it is four lines inside sweep(), reachable only through a session.
 */
import { buildSpxCode } from "./contract.ts";

export interface MonitorLeg {
  sign: 1 | -1;
  option_type: "CALL" | "PUT";
  strike: number;
}

export interface Monitor {
  id?: string;
  code: string;
  strike_date: string;
  option_type: string;
  strike: number;
  field: string;
  threshold: number;
  direction: string; // "above" | "below"
  compare: string; // "abs" | "signed"
  /** combo monitors carry legs; null or absent means single-leg */
  legs?: MonitorLeg[] | null;
}

export type Quote = Record<string, number | string | null | undefined>;
export type ByCode = Record<string, Quote>;

/** greeks are linear, so signed sums are the greeks OF the combo's value; IV is not additive */
export const COMBO_GREEK_FIELDS = [
  "option_delta", "option_gamma", "option_theta", "option_vega",
] as const;

/** IV is intensive, not extensive: two legs at 20% are not a 40% combo, so a signed sum of them
 *  is a number with no meaning. Combos may not watch these fields, and a row predating that rule
 *  must still never produce a sum. */
export const NON_ADDITIVE_FIELDS: ReadonlySet<string> = new Set(["option_implied_volatility"]);

export function monitorLegCodes(monitor: Monitor): string[] {
  if (!monitor.legs || monitor.legs.length === 0) return [monitor.code];
  return monitor.legs.map((l) => buildSpxCode(monitor.strike_date, l.option_type, l.strike));
}

/** Reason this field cannot be a combo's monitored field, or null if it can. */
export function comboFieldError(field: string): string | null {
  if (NON_ADDITIVE_FIELDS.has(field)) {
    return `combos cannot watch ${field}: it is not additive across legs`;
  }
  return null;
}

/** Signed sum of one field over a combo's legs; null if ANY leg is missing — no partial sums. */
export function comboFieldSum(monitor: Monitor, byCode: ByCode, field: string): number | null {
  if (comboFieldError(field)) return null; // guard for legacy rows: never fabricate a summed IV
  const legs = monitor.legs ?? [];
  const codes = monitorLegCodes(monitor);
  if (legs.length !== codes.length) throw new Error("a code per leg");
  let total = 0;
  for (const [i, leg] of legs.entries()) {
    const value = byCode[codes[i]!]?.[field];
    if (value === null || value === undefined) return null;
    total += leg.sign * Number(value);
  }
  return total;
}

export function monitorValue(monitor: Monitor, byCode: ByCode): number | null {
  if (!monitor.legs || monitor.legs.length === 0) {
    const value = byCode[monitor.code]?.[monitor.field];
    return value === null || value === undefined ? null : Number(value);
  }
  return comboFieldSum(monitor, byCode, monitor.field);
}

/** Python's round() to a whole number: half to even, decided on the stored double. */
function pyRoundToInt(value: number): number {
  const floor = Math.floor(value);
  // exact for anything under 2^52, which a percentage is; and a non-tie needs no even rule
  if (value - floor !== 0.5) return Math.round(value);
  return floor % 2 === 0 ? floor : floor + 1;
}

/** How far a value has travelled toward its threshold, 0-100.
 *
 *  Null where the journey has no honest baseline to fill from — a signed negative threshold the
 *  value must cross from the other side. A figure that sometimes lies is worse than none, the
 *  same reasoning that makes a partly priced combo report nothing rather than a part sum.
 */
export function thresholdFill(
  value: number | null | undefined, threshold: number | null | undefined,
  direction: string, compare: string,
): number | null {
  // `not threshold` in the Python, so a threshold of 0 is excluded as well as a missing one —
  // nothing can be a fraction of zero
  if (value === null || value === undefined || !threshold) return null;
  const metric = compare === "abs" ? Math.abs(value) : value;
  if (metric < 0 || threshold < 0) return null;
  let ratio: number;
  if (direction === "above") ratio = metric / threshold;
  else if (metric > 0) ratio = threshold / metric;
  else return null;
  return Math.max(0, Math.min(100, pyRoundToInt(ratio * 100)));
}

/** Whether a value has breached its threshold.
 *
 *  abs mode compares magnitude; signed compares the raw value (negative thresholds legal). The
 *  flag flips truthfully AT the exact threshold — message flapping is prevented by the
 *  per-monitor alarm cooldown, never by a value band.
 */
export function isBreached(
  value: number, threshold: number, direction: string, compare: string,
): boolean {
  const metric = compare === "signed" ? value : Math.abs(value);
  // anything that is not "below" is above, matching the Python's `direction != "below"`
  return direction === "below" ? metric <= threshold : metric >= threshold;
}
