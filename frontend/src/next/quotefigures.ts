/** Every figure of a rule's contract or combo, as the inspector and the sheet list them (#332).
 *
 *  The old page's sheet listed a contract's bid, ask, last trade, IV and every greek, and a
 *  combo's greeks, whatever the table had room for (ADR 0008: "the sheet shows every figure").
 *  This is that list for the page, ONE list for both arrangements so the desk and the phone
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
import type { Entry } from "../shared/api";
import { DASH, shortStamp } from "../shared/format";

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
const NO_TRADE = "no trade reported";
/** IB Gateway sends no last-trade time at all (`ibkr/fields.ts` maps none); moomoo always sends
 *  one, and "N/A" in it for a contract that has not traded. */
const NO_STAMP = "not served by the provider";
const NOT_HELD_ONCE = "not every leg is held exactly once by one holding";

/** A last-trade time as the service renders it: a date and a clock, with or without its zone.
 *  Anything else — moomoo's "N/A" above all, which `marketTimeToDisplay` passes through as it
 *  passes through anything that is not a time — is no trade, never a figure. */
const STAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?/;

/** Fixed places, but never a served non-zero printed as zero: a γ of -0.00004 at four places is
 *  "-0.0000", which reads as none. Said as a bound instead. */
function fixed(n: number, places: number): string {
  const text = n.toFixed(places);
  if (n === 0 || Number(text) !== 0) return text;
  const unit = (1 / 10 ** places).toFixed(places);
  return n > 0 ? `<${unit}` : `>-${unit}`;
}

/** Why a rule has no figures at all, said once rather than as a dash per figure: its contract
 *  came back with no quote, or the service's own fault for it ("unknown contract"). Null where
 *  there are figures to list. */
export function wholeMissing(entry: Entry): string | null {
  if (entry.legs) {
    // a combo the service faults, with nothing it could sum
    const any = [entry.combo_value, ...GREEKS.map(([k]) => entry.combo_greeks?.[k])].some(served);
    return entry.error && !any ? entry.error : null;
  }
  return entry.quote ? null : entry.error ?? NO_QUOTE;
}

export function ruleFigures(entry: Entry): RuleFigure[] {
  if (wholeMissing(entry) !== null) return [];
  return entry.legs ? comboFigures(entry) : contractFigures(entry);
}

function contractFigures(entry: Entry): RuleFigure[] {
  const quote = entry.quote as Record<string, unknown>;
  const one = (key: string, label: string, format: (n: number) => string, missing = NOT_SERVED): RuleFigure => {
    const v = quote[key];
    return served(v) ? { key, label, text: format(v), why: null } : { key, label, text: DASH, why: missing };
  };
  const raw = quote.update_time;
  const stamp = typeof raw === "string" && STAMP.test(raw) ? raw : null;
  // present but not a time: moomoo saying the contract has not traded
  const untraded = raw !== undefined && raw !== null && stamp === null;
  const last = one("last_price", "last", points);
  // the price of no trade: moomoo's curPrice is a plain double with nothing to say it is unset,
  // so a contract that never traded arrives as 0 beside its "N/A" — no price at all
  const lastFigure = untraded && served(quote.last_price) && quote.last_price <= 0
    ? { ...last, text: DASH, why: NO_TRADE } : last;
  return [
    one("bid_price", "bid", points),
    one("ask_price", "ask", points),
    // derived by the vendor's mapping only where BOTH sides arrived: a mid from one is not a price,
    // and none is worked out here from the two
    one("mid_price", "mid", points, "needs both a bid and an ask"),
    lastFigure,
    // the last TRADE, which is not the quote's freshness (`fetched_at`): a far strike can go days
    // without a print, so the date stays (format.shortStamp)
    stamp !== null ? { key: "update_time", label: "last trade", text: shortStamp(stamp), why: null }
      : { key: "update_time", label: "last trade", text: DASH, why: untraded ? NO_TRADE : NO_STAMP },
    // served in percent by every vendor's mapping (ibkr's is scaled to it)
    one("option_implied_volatility", "IV", (n) => `${fixed(n, 2)}%`),
    ...GREEKS.map(([key, label]) => one(key, label, (n) => fixed(n, PLACES[key]))),
  ];
}

function comboFigures(entry: Entry): RuleFigure[] {
  const why = entry.error ?? PARTIAL;
  const one = (key: string, label: string, v: unknown, places: number): RuleFigure =>
    served(v) ? { key, label, text: fixed(v, places), why: null } : { key, label, text: DASH, why };
  // `combo_value` is the rule's OWN field summed across the legs (`monitorValue`): a price only for
  // a rule on the price. A delta rule's is its summed delta, which the Δ row already says.
  const onPrice = entry.field === "mid_price";
  const out = onPrice ? [one("combo_value", "spread value", entry.combo_value, 2)] : [];
  // the holding's cost to buy back these legs, where the rule covers one (points, not $). Null
  // when a leg has no mid OR a leg is not held exactly once (`costToCloseOf`); on a price rule a
  // served value says every leg has its mid, so it was the holding
  if (entry.positions.length > 0) {
    const notHeld = entry.error ?? (onPrice
      ? (served(entry.combo_value) ? NOT_HELD_ONCE : PARTIAL)
      : "a leg has no mid, or not every leg is held exactly once by one holding");
    out.push(served(entry.cost_to_close)
      ? { key: "cost_to_close", label: "cost to close", text: points(entry.cost_to_close), why: null }
      : { key: "cost_to_close", label: "cost to close", text: DASH, why: notHeld });
  }
  for (const [key, label] of GREEKS) out.push(one(key, label, entry.combo_greeks?.[key], PLACES[key]));
  return out;
}
