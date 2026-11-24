/** `/account` — the IBKR account, as IBKR marks it (ADR 0030, #470): its totals and every holding,
 *  stocks and options apart. Read-only and stored nowhere; one read is shared by every caller for
 *  `ACCOUNT_SHARED_FOR_MS`. What it decides is `account.ts`'s.
 */
import { Hono } from "hono";
import { z } from "zod";

import { AccountBook } from "../../../account.ts";
import type { Deps } from "../deps.ts";
import { httpError } from "../errors.ts";
import { documented } from "../openapi.ts";

const figure = z.number().nullable();

/** A stock or an option as the library maps IBKR's PORTFOLIO_VALUE row, in its own currency. */
const HoldingOut = z.object({
  /** IB's security type as sent: `STK` or `OPT` here */
  sec_type: z.string(),
  symbol: z.string(),
  currency: z.string(),
  /** an option's expiry as IB sends it (`20261218`); null for a stock */
  expiry: z.string().nullable(),
  /** an option's strike; null for a stock */
  strike: figure,
  /** an option's side; null for a stock */
  right: z.enum(["C", "P"]).nullable(),
  /** null where IB sends none, as for a stock */
  multiplier: figure,
  /** signed: a short position is negative */
  position: figure,
  /** IBKR's own mark, per share */
  market_price: figure,
  /** the position's value at that mark, in `currency` */
  market_value: figure,
  /** per share: IB's average cost divided by the multiplier */
  average_cost: figure,
  unrealized_pnl: figure,
  realized_pnl: figure,
});

/** A holding that is neither a stock nor an option — a future, a bond, a forex balance. */
const OtherOut = z.object({
  sec_type: z.string(),
  symbol: z.string(),
  position: figure,
  market_value: figure,
  currency: z.string(),
});

const AccountOut = z.object({
  /** the account id, masked */
  account: z.string(),
  /** an IBKR paper account */
  paper: z.boolean(),
  /** the currency the totals are in; null where the gateway did not say */
  base_currency: z.string().nullable(),
  /** the gateway's account update time as it sent it: a time of day, no date; null where none came */
  updated_at: z.string().nullable(),
  /** when the service read it, in the display zone */
  read_at: z.string(),
  /** in the base currency; each null where the gateway sent none */
  totals: z.object({
    net_liquidation: figure, total_cash: figure, unrealized_pnl: figure, realized_pnl: figure,
  }),
  /** IBKR's exchange rates, by currency code: units of the base currency per ONE unit of it, the
   *  base currency itself 1 */
  exchange_rates: z.record(z.string(), z.number()),
  /** security type STK */
  stocks: z.array(HoldingOut),
  /** security type OPT */
  options: z.array(HoldingOut),
  /** anything else */
  other: z.array(OtherOut),
});

const read = documented(
  "The IBKR account as IBKR marks it: totals, stocks, options and anything else; one read shared for 10s",
  { 200: AccountOut }, [422, 502, 503],
);

export function accountRoutes(deps: Deps) {
  // one per app, so every caller shares its read
  const book = new AccountBook({
    read: deps.account, wanted: deps.settings.ibkrAccount, now: deps.now,
    displayTz: deps.settings.displayTz,
  });
  return new Hono().get("/", read, async (c) => {
    const result = await book.read();
    if ("fault" in result) throw httpError(result.fault.status, result.fault.message);
    return read.reply(c, 200, result.answer);
  });
}
