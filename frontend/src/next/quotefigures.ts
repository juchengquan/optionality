/** Every figure of a rule's contract or combo, as the inspector and the sheet list them (#332).
 *
 *  Today's sheet at `/opt` lists a contract's bid, ask, last trade, IV and every greek, and a
 *  combo's greeks, whatever the table had room for (ADR 0008: "the sheet shows every figure").
 *  This is that list for `/opt/next`, ONE list for both arrangements so the desk and the phone
 *  cannot say different things about the same rule.
 *
 *  Pure, and nothing here is computed. Every figure is one `/quotes` already serves on the row:
 *  a contract's own quote, or a combo's `combo_value` and `combo_greeks`, which the SERVICE sums
 *  under the legs' signs (`buildEntries`). Where it summed nothing — a leg without the figure, as
 *  no partial sums are taken (CLAUDE.md) — that is a dash, and never a sum worked out here. IV is
 *  never summed at all, so a combo has none to list.
 *
 *  A figure not served is a dash WITH its reason, and never 0: a 0.00 bid reads as a price.
 *  Nothing here is a $ amount, so privacy hides none of it (ADR 0023: privacy hides $ and keeps
 *  Δ) — a quote is per contract, in points, and says nothing about how many are held.
 */
import type { Entry } from "../api";
import { DASH, shortStamp } from "../format";

export interface RuleFigure {
  /** stable, for React and for a test that wants one figure */
  key: string;
  label: string;
  /** the figure, or a dash */
  text: string;
  /** why there is a dash, or null where there is a figure */
  why: string | null;
}

/** A figure is a finite number. moomoo is a wire with no published schema, and a field can arrive
 *  as a string (domain/reference.ts guards the same way): one that is not a number is not served. */
const served = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** The decimals ADR 0023 fixes per field — needs.ts writes a rule's own figure the same way. */
const points = (n: number) => n.toFixed(2);
const PLACES = { option_delta: 3, option_gamma: 4, option_theta: 2, option_vega: 2 } as const;

const GREEKS = [
  ["option_delta", "Δ"], ["option_gamma", "γ"], ["option_theta", "θ"], ["option_vega", "vega"],
] as const;

const NOT_SERVED = "not served for this contract";
const NO_QUOTE = "no quote in this poll";
const PARTIAL = "a leg has no figure, and no sum is taken from part of them";

export function ruleFigures(entry: Entry): RuleFigure[] {
  return entry.legs ? comboFigures(entry) : contractFigures(entry);
}

function contractFigures(entry: Entry): RuleFigure[] {
  const quote = (entry.quote ?? null) as Record<string, unknown> | null;
  // the batch carried nothing for it: every figure has the same reason, and the service's own
  // word for it where it has one ("unknown contract")
  const whole = quote === null ? entry.error ?? NO_QUOTE : null;
  const one = (key: string, label: string, format: (n: number) => string, missing = NOT_SERVED): RuleFigure => {
    const v = quote?.[key];
    if (whole !== null) return { key, label, text: DASH, why: whole };
    return served(v) ? { key, label, text: format(v), why: null } : { key, label, text: DASH, why: missing };
  };
  const stamp = quote?.update_time;
  return [
    one("bid_price", "bid", points),
    one("ask_price", "ask", points),
    // derived by the vendor's mapping only where BOTH sides arrived: a mid from one is not a price
    one("mid_price", "mid", points, "needs both a bid and an ask"),
    one("last_price", "last", points),
    // the last TRADE, which is not the quote's freshness (`fetched_at`): a far strike can go days
    // without a print, so the date stays (format.shortStamp)
    whole !== null ? { key: "update_time", label: "last trade", text: DASH, why: whole }
      : typeof stamp === "string" && stamp !== ""
        ? { key: "update_time", label: "last trade", text: shortStamp(stamp), why: null }
        : { key: "update_time", label: "last trade", text: DASH, why: "no trade reported" },
    // served in percent by every vendor's mapping (ibkr's is scaled to it)
    one("option_implied_volatility", "IV", (n) => `${n.toFixed(2)}%`),
    ...GREEKS.map(([key, label]) => one(key, label, (n) => n.toFixed(PLACES[key]))),
  ];
}

function comboFigures(entry: Entry): RuleFigure[] {
  const why = entry.error ?? PARTIAL;
  const one = (key: string, label: string, v: unknown, places: number): RuleFigure =>
    served(v) ? { key, label, text: v.toFixed(places), why: null } : { key, label, text: DASH, why };
  const out = [one("combo_value", "spread value", entry.combo_value, 2)];
  // the holding's cost to buy back these legs, where the rule covers one (points, not $)
  if (entry.positions.length > 0) {
    out.push(served(entry.cost_to_close)
      ? { key: "cost_to_close", label: "cost to close", text: points(entry.cost_to_close), why: null }
      : { key: "cost_to_close", label: "cost to close", text: DASH, why });
  }
  for (const [key, label] of GREEKS) out.push(one(key, label, entry.combo_greeks?.[key], PLACES[key]));
  return out;
}
