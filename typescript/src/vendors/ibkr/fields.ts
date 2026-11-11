/** IB Gateway's ticks, turned into the figures the rest of the service reads (ADR 0019, track C).
 *
 *  Every name on the right of this mapping is the service's own — `mid_price`, `option_delta` —
 *  and every number on the left is IBKR's. That translation is the whole job, and two parts of it
 *  are not renames:
 *
 *  **Implied volatility changes units.** moomoo reports `14.007`; IBKR reports `0.1368`. Measured
 *  on 2026-11-08, same contract, same minute. The service's vocabulary is moomoo's, so IBKR's
 *  fraction is multiplied by 100 here. Without it a rule set at 14 would never fire on IBKR and
 *  one set at 0.14 would fire constantly on moomoo — a silent 100× error in the one figure a
 *  volatility rule reads.
 *
 *  **The mid is DERIVED**, not sent, and only when both sides are numbers — the same rule
 *  `opend/snapshot.ts` applies, because `domain/reference.ts` prefers the mid and a mid derived
 *  from one side would be a number with no meaning.
 */
import type { Quote } from "../../domain/quote.ts";

/** Price ticks, live and delayed, to the service's field names.
 *
 *  The delayed ids carry the same figures from the delayed feed, so they map to the same names:
 *  WHICH tier answered is reported once per request by the gateway (see `grade`) rather than
 *  inferred from the tick ids, because the gateway contradicted a request once — asked for
 *  delayed, it granted live.
 */
export const PRICE_TICKS: Record<number, string> = {
  1: "bid_price", 2: "ask_price", 4: "last_price", 9: "prev_close_price",
  66: "bid_price", 67: "ask_price", 68: "last_price", 75: "prev_close_price",
};

/** The greeks message's ids: the model computation, live (13) and delayed (83). Nothing else is
 *  read — a bid- or ask-implied computation is a different claim from the model's, and the service
 *  has one field for each greek.
 *
 *  This said 13 and 53 until #257's review, and 53 is the CUSTOM computation, not the delayed
 *  model: IBKR's tick-type list and `ib_async`'s own map (`GREEKS_TICK_MAP`: 13 and 83 are
 *  `modelGreeks`, 53 is `custGreeks`) agree. It mattered once `client.ts` began waiting for an
 *  option's model greeks — a delayed option would have waited out the timeout for a 53 that never
 *  comes. 83 is named from those two sources, not recorded: the paper login here is served LIVE
 *  for SPXW, so no capture holds a delayed option's greeks. */
export const GREEK_TICKS = new Set([13, 83]);

/** The grades IB Gateway reports, as the two independent facts they really are.
 *
 *  Four grades are two questions, not one scale: whether the figure came from the delayed TIER,
 *  and whether the vendor is serving the last value it holds because nothing is updating. Grade 4
 *  is both, which is why collapsing it into either neighbour loses something the gateway bothered
 *  to distinguish — it drew that distinction per contract in a single response on 2026-11-08.
 *
 *  Translated here rather than passed through: `frozen` means "last known because the market is
 *  shut", which is normal and not a fault, and vendor jargon stays out of the API the way
 *  moomoo's "snapshot" does.
 */
export interface Grade {
  /** the delayed tier answered — a fact about the subscription, not about today */
  delayed: boolean;
  /** the vendor is serving the most recent value it holds rather than an updating one */
  last_known: boolean;
}

export function grade(type: number): Grade | null {
  switch (type) {
    case 1: return { delayed: false, last_known: false };
    case 2: return { delayed: false, last_known: true };
    case 3: return { delayed: true, last_known: false };
    case 4: return { delayed: true, last_known: true };
    // a grade nobody has documented is not a claim about freshness: null renders as nothing, and
    // nothing is what the strip shows for a source that did not say (ADR 0019)
    default: return null;
  }
}

export interface Greeks {
  impliedVol: number | null;
  delta: number | null;
  gamma: number | null;
  vega: number | null;
  theta: number | null;
}

/** The greeks, under the service's names and in the service's units. */
export function greekFields(figures: Greeks): Quote {
  const out: Quote = {};
  if (figures.delta !== null) out.option_delta = figures.delta;
  if (figures.gamma !== null) out.option_gamma = figures.gamma;
  if (figures.vega !== null) out.option_vega = figures.vega;
  if (figures.theta !== null) out.option_theta = figures.theta;
  // the 100× that is not a rename: IBKR's 0.1368 is moomoo's 14.007, and a rule's threshold is
  // written in the service's units
  if (figures.impliedVol !== null) out.option_implied_volatility = figures.impliedVol * 100;
  return out;
}

/** The mid, where both sides arrived.
 *
 *  Mutates the record it is given, as `opend/snapshot.ts` does, and only when both sides are
 *  numbers: a mid from one side is a number with no meaning, and `domain/reference.ts` prefers
 *  the mid over the last trade.
 */
export function withMid(record: Quote): Quote {
  const bid = record.bid_price;
  const ask = record.ask_price;
  if (typeof bid === "number" && typeof ask === "number") {
    record.mid_price = (bid + ask) / 2;
  }
  return record;
}

/** Whether a record carries any of the figures that were asked for.
 *
 *  The completion rule for a bounded ask, and the distinction it keeps is the one ADR 0015 named:
 *  a record with a code and nothing else is the gateway saying "subscribed, nothing yet", which is
 *  a figure that did not arrive — counted by the sweep and quarantined after N of them — and NOT
 *  a contract that does not exist. Those are different answers and the service keeps them apart.
 */
export function hasFigures(record: Quote): boolean {
  return Object.keys(record).some((key) => key !== "code" && key !== "name"
    && key !== "delayed" && key !== "last_known" && record[key] !== undefined);
}
