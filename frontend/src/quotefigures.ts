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
import type { Entry } from "./shared/api";
import { DASH, shortStamp } from "./shared/format";
import { newYorkWhen } from "./session";
import { figureOf, iv, points } from "./shared/numbers";
import { fieldWords } from "./needs";
import { outOfHoursValue, priceOf } from "./lastknown";

interface RuleFigure {
  /** stable, for React and for a test that wants one figure */
  key: string;
  label: string;
  /** the figure, or a dash */
  text: string;
  /** why there is a dash, or null where there is a figure */
  why: string | null;
  /** a figure listed as detail, after the ones the row is read by: a contract's bid, ask, last and
   *  last trade, and a held spread's signed value under its cost to close (2026-11-16) */
  detail?: true;
}

/** A figure is a finite number. moomoo is a wire with no published schema, and a field can arrive
 *  as a string (domain/reference.ts guards the same way): one that is not a number is not served. */
const served = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** The Greeks, labelled in the rule's own words (`fieldWords`, #404): a figure and a rule on it read
 *  alike — Δ Γ Θ ν — each to its field's places (`shared/numbers.ts`). */
const GREEKS = (["option_delta", "option_gamma", "option_theta", "option_vega"] as const)
  .map((key) => [key, fieldWords(key)] as const);

const NOT_SERVED = "not served for this contract";
const NO_QUOTE = "no quote in this poll";
const PARTIAL = "a leg has no figure, and no sum is taken from part of them";
const NO_TRADE = "no trade reported";
/** IB Gateway sends no last-trade time at all (`ibkr/fields.ts` maps none); moomoo always sends
 *  one, and "N/A" in it for a contract that has not traded. */
const NO_STAMP = "not served by the provider";
const NOT_HELD_ONCE = "not every leg is held exactly once by one holding";
const NO_PRICE = "no rule on these contracts watches their value";

/** A last-trade time as the service renders it: a date and a clock, with or without its zone.
 *  Anything else — moomoo's "N/A" above all, which `marketTimeToDisplay` passes through as it
 *  passes through anything that is not a time — is no trade, never a figure. */
const STAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?/;

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

/** A rule's figures, in the order the owner's standard reads them (2026-11-16):
 *
 *  - a single contract: its value (the mid) first, then Δ Γ Θ ν and its IV, then the quote's detail —
 *    bid, ask, last and the last trade;
 *  - a spread on the watchlist: its value, signed as the service signs a combo, then Δ Γ Θ ν. No
 *    cost to close, even where it shares a contract with a holding: its note says what it shares;
 *  - a spread on something HELD: its cost to close first — what buying it back costs, positive, as
 *    the holding's own value is — then Δ Γ Θ ν, and the signed value after them as detail.
 *
 *  `held` is where the row is drawn: a rule under a holding, or one on held contracts no holding
 *  owns — never a spread drawn in the watchlist because it only partly overlaps one (#346). */
export function ruleFigures(entry: Entry, held = entry.held): RuleFigure[] {
  // out of the session a watchlist row's value is its last in-session price and when, as its table
  // row and its card say it (#400; review of #420): the detail says the same, quote or none
  const last = held ? undefined : outOfHoursValue(entry);
  const lastValue: RuleFigure | null = last === undefined ? null
    : { key: entry.legs ? "combo_value" : "mid_price", label: fieldWords("mid_price"), text: last, why: null };
  if (wholeMissing(entry) !== null) return lastValue ? [lastValue] : [];
  const figures = entry.legs ? comboFigures(entry, held) : contractFigures(entry);
  return lastValue ? figures.map((f) => (f.key === lastValue.key ? lastValue : f)) : figures;
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
  const detail = (f: RuleFigure): RuleFigure => ({ ...f, detail: true });
  return [
    // the contract's value is its mid, derived by the vendor's mapping only where BOTH sides
    // arrived: a mid from one is not a price, and none is worked out here from the two
    one("mid_price", fieldWords("mid_price"), points, "needs both a bid and an ask"),
    ...GREEKS.map(([key, label]) => one(key, label, (n) => figureOf(key, n))),
    // served in percent by every vendor's mapping (ibkr's is scaled to it)
    one("option_implied_volatility", "IV", (n) => iv(n)),
    detail(one("bid_price", "bid", points)),
    detail(one("ask_price", "ask", points)),
    detail(lastFigure),
    // the last TRADE, which is not the quote's freshness (`fetched_at`): a far strike can go days
    // without a print, so the date stays — on New York's clock, a trade being the market's (part F),
    // "Mon 20261116 00:22 ET"; a stamp with no zone, which names no instant, as written
    detail(stamp !== null ? { key: "update_time", label: "last trade", text: newYorkWhen(stamp) ?? shortStamp(stamp), why: null }
      : { key: "update_time", label: "last trade", text: DASH, why: untraded ? NO_TRADE : NO_STAMP }),
  ];
}

function comboFigures(entry: Entry, held: boolean): RuleFigure[] {
  const why = entry.error ?? PARTIAL;
  const greeks = GREEKS.map(([key, label]): RuleFigure => {
    const v = entry.combo_greeks?.[key];
    return served(v) ? { key, label, text: figureOf(key, v), why: null } : { key, label, text: DASH, why };
  });
  // `combo_value` is the rule's OWN field summed across the legs (`monitorValue`): a price only for
  // a rule on the price. A delta rule's spread says the price its value cell says (`priceOf`, #400):
  // that of a price rule on the very same contracts, or none
  const onPrice = entry.field === "mid_price";
  const price = onPrice ? entry.combo_value : priceOf(entry);
  const value: RuleFigure = served(price)
    ? { key: "combo_value", label: fieldWords("mid_price"), text: points(price), why: null }
    : { key: "combo_value", label: fieldWords("mid_price"), text: DASH, why: onPrice ? why : NO_PRICE };
  if (!held) return [value, ...greeks];
  // the holding's cost to buy back these legs (points, not $). Null when a leg has no mid OR a leg
  // is not held exactly once (`costToCloseOf`); on a price rule a served value says every leg has
  // its mid, so it was the holding
  const notHeld = entry.error ?? (onPrice
    ? (served(entry.combo_value) ? NOT_HELD_ONCE : PARTIAL)
    : "a leg has no mid, or not every leg is held exactly once by one holding");
  const cost: RuleFigure = served(entry.cost_to_close)
    ? { key: "cost_to_close", label: "cost to close", text: points(entry.cost_to_close), why: null }
    : { key: "cost_to_close", label: "cost to close", text: DASH, why: notHeld };
  return [cost, ...greeks, { ...value, detail: true }];
}
