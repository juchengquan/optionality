/** The account page's order and arithmetic (#471): pure, over `GET /account`'s answer (#470).
 *
 *  Every figure is IBKR's own and is SHOWN in the holding's own currency, a code beside it where that
 *  is not the base. Two things are worked out in the base currency instead, by IBKR's own rates
 *  (`exchange_rates`: base units per one unit of each currency; the owner, 2026-11-23): a stock's
 *  weight — its share of net liquidation, which is in the base — and the order the stocks are listed
 *  in. A holding in a currency with no rate has no weight (a dash) and is listed after every holding
 *  that converts. */
import type { Account, AccountHolding } from "../shared/api";
import { DASH, type WrittenLeg } from "../shared/format";
import { MINUS, trueMinus } from "../shared/numbers";

/** A holding's market value in the base currency: as served where it is in the base, converted by
 *  IBKR's rate where its currency has one, and null where it has none — or where the base itself is
 *  unknown, which every rate is relative to. */
export function valueInBase(h: Pick<AccountHolding, "market_value" | "currency">, account: Account): number | null {
  if (h.market_value === null || account.base_currency === null) return null;
  if (h.currency === account.base_currency) return h.market_value;
  const rate = account.exchange_rates[h.currency];
  return typeof rate === "number" && Number.isFinite(rate) ? h.market_value * rate : null;
}

/** The stocks by the SIZE of their market value in the base currency, largest first, whatever its
 *  sign: a large short sits near the top (the owner, 2026-11-23). Those with no value in the base — a
 *  currency with no rate, or no value at all — after every one that has, by currency and then by the
 *  size of their own value; ties by symbol. A new list: the answer is left as it came. */
export function stocksByValue(stocks: readonly AccountHolding[], account: Account): AccountHolding[] {
  const size = (n: number | null) => (n === null ? 0 : Math.abs(n));
  const keyed = stocks.map((h) => ({ h, base: valueInBase(h, account) }));
  return keyed.sort((a, b) =>
    (a.base === null ? 1 : 0) - (b.base === null ? 1 : 0)
    || (a.base !== null && b.base !== null ? size(b.base) - size(a.base) : 0)
    || (a.base === null ? a.h.currency.localeCompare(b.h.currency) : 0)
    || (a.h.market_value === null ? 1 : 0) - (b.h.market_value === null ? 1 : 0)
    || size(b.h.market_value) - size(a.h.market_value)
    || a.h.symbol.localeCompare(b.h.symbol)).map((k) => k.h);
}

/** The options under one underlying, each expiry's apart. */
export interface OptionGroup {
  underlying: string;
  /** nearest first; an option IBKR sent with no expiry last */
  expiries: { expiry: string | null; rows: AccountHolding[] }[];
}

/** The options grouped by underlying (IBKR's symbol for an option is its underlying's), then by
 *  expiry, nearest first — IBKR's `20261218` sorts as a date does. Each expiry's contracts by strike,
 *  a put before a call at one strike, so they read as a ladder: `P6750 P6800 C7300`. */
export function optionGroups(options: readonly AccountHolding[]): OptionGroup[] {
  const byUnderlying = new Map<string, Map<string | null, AccountHolding[]>>();
  for (const o of options) {
    const expiries = byUnderlying.get(o.symbol) ?? new Map<string | null, AccountHolding[]>();
    byUnderlying.set(o.symbol, expiries);
    expiries.set(o.expiry, [...(expiries.get(o.expiry) ?? []), o]);
  }
  const rank = (r: AccountHolding["right"]) => (r === "P" ? 0 : r === "C" ? 1 : 2);
  return [...byUnderlying.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([underlying, expiries]) => ({
      underlying,
      expiries: [...expiries.entries()]
        .sort(([a], [b]) => (a === null ? 1 : 0) - (b === null ? 1 : 0) || (a ?? "").localeCompare(b ?? ""))
        .map(([expiry, rows]) => ({
          expiry,
          rows: [...rows].sort((a, b) => (a.strike ?? Infinity) - (b.strike ?? Infinity) || rank(a.right) - rank(b.right)),
        })),
    }));
}

/** A stock's share of net liquidation, by its value in the base currency (`valueInBase`), which net
 *  liquidation is in: none where that value is unknown, or net liquidation is unknown or zero.
 *  Signed: a short weighs negative. */
export function weight(h: AccountHolding, account: Account): number | null {
  const nlv = account.totals.net_liquidation;
  const value = valueInBase(h, account);
  if (value === null || nlv === null || nlv === 0) return null;
  return value / nlv;
}

/** A holding's unrealised P&L as a share of what it cost: IBKR's average cost per share times the
 *  shares (times the multiplier, for an option), whichever side it is on. */
export function pnlShare(h: AccountHolding): number | null {
  if (h.unrealized_pnl === null || h.average_cost === null || h.position === null) return null;
  const cost = Math.abs(h.average_cost * h.position * (h.multiplier ?? 1));
  return cost === 0 ? null : h.unrealized_pnl / cost;
}

/** An option as a written leg (`shared/Legs.tsx`): its type, its strike, short where the position
 *  is. No quantity: the row says that in a column of its own, signed. */
export function contractLeg(h: AccountHolding): WrittenLeg {
  return {
    short: (h.position ?? 0) < 0,
    option_type: h.right === "C" ? "CALL" : h.right === "P" ? "PUT" : (h.sec_type || "?"),
    strike: h.strike ?? Number.NaN,
  };
}

/** The code written beside a figure in `currency`: none in the base currency, and every currency's
 *  where the gateway did not say which the base is. */
export function currencyNote(currency: string, base: string | null): string | null {
  return currency === base ? null : currency;
}

const DOLLARS = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const AMOUNT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** An amount of money, to the whole unit as the book writes money: in dollars as the book does,
 *  `$18,000`; in any other currency as a plain amount, `16,800`, which its code beside it names
 *  (`currencyNote`). `signed` writes a gain's `+`, as a P&L is written. Under `privacy` (the book's
 *  setting, `ui_privacy`) the amount is hidden as the book hides it: `$•••`, or `•••` beside a code. */
export function moneyText(n: number | null, currency: string, signed = false, privacy = false): string {
  if (n === null || !Number.isFinite(n)) return DASH;
  if (privacy) return currency === "USD" ? "$•••" : "•••";
  const whole = Math.round(n);
  const text = currency === "USD" ? DOLLARS.format(Math.abs(whole)) : AMOUNT.format(Math.abs(whole));
  return whole < 0 ? `${MINUS}${text}` : signed && whole > 0 ? `+${text}` : text;
}

const COUNT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });

/** A position as a signed count, grouped as money is: `+3`, `−2`, `+200,000`, and a fractional
 *  share as IBKR holds one, `+0.5`. Under `privacy` the count goes and its sign stays, `−•••`, as the
 *  book hides a holding's contracts: a count times the mark beside it is the money hidden. */
export function quantityText(n: number | null, privacy = false): string {
  if (n === null || !Number.isFinite(n)) return DASH;
  const sign = n > 0 ? "+" : n < 0 ? MINUS : "";
  return `${sign}${privacy ? "•••" : COUNT.format(Math.abs(n))}`;
}

/** A share as a percentage to a tenth: `7.2%`, and `+20.0%` where `signed`. */
export function shareText(n: number | null, signed = false): string {
  if (n === null || !Number.isFinite(n)) return DASH;
  const text = trueMinus(`${(n * 100).toFixed(1)}%`);
  return signed && n > 0 ? `+${text}` : text;
}

/** An account with nothing in it but cash. */
export function holdsNothing(account: Account): boolean {
  return account.stocks.length === 0 && account.options.length === 0 && account.other.length === 0;
}
