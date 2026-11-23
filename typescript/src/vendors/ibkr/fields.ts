/** IB Gateway's ticks, turned into the figures the rest of the service reads (ADR 0019, track C),
 *  and since ADR 0030 the account's messages into the account's answer (the end of the file).
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
 *  **The mid is DERIVED**, not sent, and only where there is a two-sided quote with an offer above
 *  zero — the same rule `opend/snapshot.ts` applies, because it is the domain's (`midPrice`, #380):
 *  a mid from one side, or the 0 of an empty book, would be a number with no meaning.
 */
import { midPrice, type Quote } from "../../domain/quote.ts";

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

/** How the market data a request gets is graded, and which grade this service asks for.
 *
 *  DELAYED_FROZEN, not FROZEN, and the difference is not subtle: for an instrument the account is
 *  not subscribed to, asking for FROZEN delivers NOTHING. Measured twice on 2026-11-08, same
 *  index, same session:
 *
 *      reqMarketDataType(2)  SPX → `354 not subscribed`, no figures at all
 *      reqMarketDataType(4)  SPX → last 7374.85
 *
 *  Found by adding a real Reference and watching it read a dash while Yahoo's read 7376.86 beside
 *  it. FROZEN was the obvious choice and the wrong one — it means "the last live-entitled figure",
 *  so it has nothing to serve where there is no entitlement.
 *
 *  Asking for the delayed grade does NOT give up live data where it is entitled: measured the same
 *  day, a request for grade 3 on a subscribed option was granted grade 1. The gateway falls back
 *  rather than downgrades, and it reports which grade it actually served — which is why the
 *  freshness marks on the strip come from its answer rather than from this constant.
 *
 *  It lives HERE, beside the `grade` that reads the gateway's answer, rather than beside the
 *  message that carries it — because this file is what `testdata/vendors/` records. The fake
 *  gateway answers `reqMarketDataType` with nothing, as the real one does, so no replay can see
 *  which grade a client asked for: before the move, changing the Python port's copy of this
 *  number left all 688 of its tests passing, and the two clients could ask for different data in
 *  silence. `make cases` now writes it into `ibkr-fields.json`'s constants and the Python's
 *  `test_ibkr.py` compares it, which is how every other shared number here is held. The Python
 *  already keeps the ask and the reading in one module, so this is also the closer mirror.
 */
export const MARKET_DATA_DELAYED_FROZEN = 4;

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

/** The mid, where there is a two-sided quote.
 *
 *  Mutates the record it is given, as `opend/snapshot.ts` does, by the one rule every vendor
 *  shares (`domain/quote.ts` `midPrice`): both sides, and an ask above zero. A mid from one side
 *  is a number with no meaning, and so is the 0 of an empty book (#380) — `domain/reference.ts`
 *  prefers the mid over the last trade, and the sweep and the holdings read it as a price. The
 *  sides are kept as they came.
 */
export function withMid(record: Quote): Quote {
  const mid = midPrice(record.bid_price, record.ask_price);
  if (mid !== null) record.mid_price = mid;
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

// --- the account (ADR 0030) ---------------------------------------------------------------------

/** What the account read answers: the account's totals and every position in it, as IBKR marks
 *  them. Read once, never stored, and the account id only ever MASKED (`maskAccount`).
 *
 *  Everything below is pure and canonical, and held as the tick mapping is: `make cases` records
 *  it in `testdata/vendors/ibkr-fields.json` and the Python port (`ibkr.py`) is compared to it.
 *  The messages hand it their fields as TEXT (`messages.ts`), so the two clients read the same
 *  strings through the same rules: an empty field is no figure, never 0. */
export interface IbkrAccount {
  /** the account id, masked: every character but the last three replaced by `•` */
  account: string;
  /** IB's paper accounts, whose ids start `DU` */
  paper: boolean;
  /** the account's base currency, which the totals are in; null where the gateway did not say */
  base_currency: string | null;
  /** The gateway's ACCT_UPDATE_TIME exactly as it sent it: a time of day ("13:45") with NO DATE
   *  and no zone, which is all the message carries. Null where none arrived before the end. */
  updated_at: string | null;
  totals: IbkrTotals;
  holdings: IbkrHolding[];
}

/** The account's totals from ACCT_VALUE, in the base currency; null where the gateway sent none. */
export interface IbkrTotals {
  /** NetLiquidation */
  net_liquidation: number | null;
  /** TotalCashValue */
  total_cash: number | null;
  /** UnrealizedPnL */
  unrealized_pnl: number | null;
  /** RealizedPnL */
  realized_pnl: number | null;
}

/** One PORTFOLIO_VALUE row: a position as IBKR marks it, in its own currency. */
export interface IbkrHolding {
  /** IB's security type: `STK`, `OPT`, `FUT`, … as sent */
  sec_type: string;
  symbol: string;
  currency: string;
  /** lastTradeDateOrContractMonth as sent (`20261218`); null where empty, as for a stock */
  expiry: string | null;
  /** null for anything that is not an option */
  strike: number | null;
  /** "C" or "P"; null for anything that is not an option */
  right: "C" | "P" | null;
  /** null where the gateway sent none, as for a stock */
  multiplier: number | null;
  /** signed: a short position is negative; null only where the field came empty */
  position: number | null;
  /** IBKR's own mark, per share */
  market_price: number | null;
  /** the position's value at that mark, in `currency` */
  market_value: number | null;
  /** PER SHARE: IB's `averageCost` divided by the multiplier, which IB's includes (an option's
   *  2.50 arrives as 250) — `perShareCost` */
  average_cost: number | null;
  unrealized_pnl: number | null;
  realized_pnl: number | null;
}

/** ACCT_VALUE's keys the answer's totals are read from, and the name each takes. Nothing else the
 *  gateway sends about the account is read: an AccountCode carries the id in full, and the rest
 *  answers questions nobody asked. */
export const ACCOUNT_TOTALS: Record<string, keyof IbkrTotals> = {
  NetLiquidation: "net_liquidation", TotalCashValue: "total_cash",
  UnrealizedPnL: "unrealized_pnl", RealizedPnL: "realized_pnl",
};

/** The tag ACCT_VALUE gives a figure summed over every currency and expressed in the base one. */
export const BASE = "BASE";

/** One ACCT_VALUE, its fields as the wire carried them (`messages.ts` reads them). */
export interface AccountValueRow {
  key: string;
  value: string;
  currency: string;
}

/** One PORTFOLIO_VALUE's fields as the wire carried them, the account aside. */
export interface PortfolioRow {
  sec_type: string;
  symbol: string;
  /** lastTradeDateOrContractMonth */
  expiry: string;
  strike: string;
  right: string;
  multiplier: string;
  currency: string;
  position: string;
  market_price: string;
  market_value: string;
  average_cost: string;
  unrealized_pnl: string;
  realized_pnl: string;
}

/** The accounts MANAGED_ACCTS names: one field, the ids separated by commas, the empty ones (a
 *  trailing comma) dropped. */
export function managedAccounts(list: string): string[] {
  return list.split(",").map((id) => id.trim()).filter((id) => id.length > 0);
}

/** An account id as it may leave the client: every character but the last three replaced by `•`,
 *  so the owner can tell two accounts apart and nobody else learns either. */
export function maskAccount(id: string): string {
  const shown = id.slice(-3);
  return "•".repeat(id.length - shown.length) + shown;
}

/** IB's paper accounts are the ids that start `DU`. */
export function isPaper(id: string): boolean {
  return id.startsWith("DU");
}

/** Which of the login's accounts to read, or why none: the one there is; where there are several,
 *  the one `wanted` names; never a guess. Every id in a refusal is masked, `wanted`'s too. */
export function chooseAccount(
  managed: string[], wanted: string | null,
): { account: string } | { refused: string } {
  const named = wanted?.trim() || null;
  const masked = managed.map(maskAccount).join(", ");
  if (managed.length === 0) return { refused: "IB Gateway named no account on this login" };
  if (named !== null) {
    return managed.includes(named) ? { account: named } : {
      refused: `IBKR_ACCOUNT (${maskAccount(named)}) names no account on this login, which has `
        + masked,
    };
  }
  if (managed.length > 1) {
    return { refused: `several accounts on this login; set IBKR_ACCOUNT to one of ${masked}` };
  }
  return { account: managed[0]! };
}

/** The average cost PER SHARE: IB's `averageCost` for anything with a multiplier includes it — an
 *  option bought at 2.50 arrives as 250 — while its market price is per share, so the two could
 *  not be compared as sent. A multiplier that is absent, zero or not a number divides by nothing. */
export function perShareCost(averageCost: number | null, multiplier: number | null): number | null {
  if (averageCost === null) return null;
  return multiplier !== null && multiplier > 0 ? averageCost / multiplier : averageCost;
}

/** A figure out of a text field, or null where it carries none: `messages.ts`' `reading`. An empty
 *  field is not 0. */
function figureOf(text: string): number | null {
  if (text.trim() === "") return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** An option's side as IB writes it, "C" or "P" ("CALL" and "PUT" taken too), or null for
 *  anything that has none — a stock's row carries "0" or nothing there. */
function sideOf(right: string): "C" | "P" | null {
  const r = right.trim().toUpperCase();
  if (r === "C" || r === "CALL") return "C";
  if (r === "P" || r === "PUT") return "P";
  return null;
}

/** One PORTFOLIO_VALUE row as the answer's holding. */
export function holdingFrom(row: PortfolioRow): IbkrHolding {
  const right = sideOf(row.right);
  const multiplier = figureOf(row.multiplier);
  return {
    sec_type: row.sec_type, symbol: row.symbol, currency: row.currency,
    expiry: row.expiry.trim() === "" ? null : row.expiry,
    // a stock's row carries a strike of 0: no strike, rather than one at zero
    strike: right === null ? null : figureOf(row.strike),
    right, multiplier,
    position: figureOf(row.position),
    market_price: figureOf(row.market_price),
    market_value: figureOf(row.market_value),
    average_cost: perShareCost(figureOf(row.average_cost), multiplier),
    unrealized_pnl: figureOf(row.unrealized_pnl),
    realized_pnl: figureOf(row.realized_pnl),
  };
}

/** The account's answer from what its read collected: the latest ACCT_VALUE for each key and
 *  currency, its holdings in the order they first came, and the update time.
 *
 *  The base currency is the one NetLiquidation is sent in, which IB always states in the base. A
 *  total is read from its `BASE` row where the gateway sends one — summed over every currency,
 *  in the base — and otherwise from its row in the base currency: UnrealizedPnL in a USD row
 *  alone would leave out a EUR holding's. */
export function accountAnswer(
  id: string, values: AccountValueRow[], holdings: IbkrHolding[], updatedAt: string | null,
): IbkrAccount {
  const net = values.find((v) => v.key === "NetLiquidation" && v.currency !== BASE);
  const base = net && net.currency.trim() !== "" ? net.currency : null;
  const totals: IbkrTotals = {
    net_liquidation: null, total_cash: null, unrealized_pnl: null, realized_pnl: null,
  };
  for (const [key, name] of Object.entries(ACCOUNT_TOTALS)) {
    const row = values.find((v) => v.key === key && v.currency === BASE)
      ?? (base === null ? undefined : values.find((v) => v.key === key && v.currency === base));
    totals[name] = row ? figureOf(row.value) : null;
  }
  return {
    account: maskAccount(id), paper: isPaper(id), base_currency: base, updated_at: updatedAt,
    totals, holdings,
  };
}
