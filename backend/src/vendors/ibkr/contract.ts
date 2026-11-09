/** A service code, as the contract IB Gateway wants (ADR 0019, track C).
 *
 *  Two kinds of Security reach this, and the code itself says which:
 *
 *  - **An option**, which `parseSpxCode` can read — `US.SPXW261218C8100000` is an expiry, a type
 *    and a strike, and IBKR wants `secType OPT` with a trading class.
 *  - **An index**, which it cannot — `SPX`, `VIX`, `NDX` are bare symbols, and IBKR wants
 *    `secType IND` on the exchange that calculates them.
 *
 *  The parse is the discriminator rather than a flag on the row, because the code already carries
 *  the answer and a stored kind could disagree with it. A code that is neither parses as an index
 *  symbol and the gateway refuses it with "no security definition", which is the honest answer:
 *  this module cannot tell a typo from an index it has never heard of, and the vendor can.
 *
 *  ## Why the exchange is a table
 *
 *  An index is calculated by one exchange and IBKR will not route to it generically — measured on
 *  2026-11-08, where guessing cost four failed lookups before `INDU@CME` resolved. SMART routing,
 *  which works for options, returns "no security definition" for an index. So the exchange is
 *  looked up and anything unlisted is refused HERE rather than sent to be guessed at: a wrong
 *  exchange and an unknown symbol come back as the same error, and the first is ours to prevent.
 */
import { parseSpxCode } from "../../domain/contract.ts";
import type { TwsContract } from "./messages.ts";

/** Which exchange calculates each index, measured against the gateway on 2026-11-08.
 *
 *  `DJX` and `INDU` are both the Dow — `DJX` is it divided by 100, on CBOE — and both resolve
 *  while neither serves a figure without a subscription. They are listed because resolving is
 *  what this module does; whether a figure arrives is the account's business.
 */
const INDEX_EXCHANGE: Record<string, string> = {
  SPX: "CBOE", VIX: "CBOE", VIX9D: "CBOE", VIX3M: "CBOE", VIX6M: "CBOE", VVIX: "CBOE",
  SKEW: "CBOE", SPOTVOL: "CBOE", LTV: "CBOE", OEX: "CBOE", PUT: "CBOE", BXM: "CBOE",
  DJX: "CBOE",
  NDX: "NASDAQ", COMP: "NASDAQ",
  INDU: "CME",
};

/** The market prefix the service puts on moomoo's codes. IBKR names no market in a symbol, so it
 *  comes off — `US.SPY` is `SPY` to a gateway. */
function bareSymbol(code: string): string {
  return code.replace(/^US\.+/, "");
}

export interface Named {
  contract: TwsContract;
  /** what the gateway will call it back, for matching an answer to a request */
  symbol: string;
}

/** The contract for a code, or null where this client cannot name one.
 *
 *  Null is "I cannot ask about this", which the caller reports as an unknown code — the same
 *  answer a vendor gives for a symbol it does not carry, and a different one from a request that
 *  was made and answered with nothing.
 */
export function contractFor(code: string): Named | null {
  const option = parseSpxCode(code);
  if (option) {
    const [y, m, d] = option.strike_date.split("-") as [string, string, string];
    return {
      symbol: "SPX",
      contract: {
        symbol: "SPX",
        secType: "OPT",
        lastTradeDateOrContractMonth: `${y}${m}${d}`,
        strike: option.strike,
        right: option.option_type === "CALL" ? "C" : "P",
        // SPXW is the weekly class every code this service builds names; `buildSpxCode` writes no
        // other, and a monthly SPX option would need its own class rather than a guess
        tradingClass: "SPXW",
        exchange: "SMART",
        currency: "USD",
        multiplier: "100",
      },
    };
  }

  const symbol = bareSymbol(code);
  const exchange = INDEX_EXCHANGE[symbol];
  if (!exchange) return null;
  return {
    symbol,
    contract: {
      symbol,
      secType: "IND",
      // an index has no expiry, no strike and no side; the gateway wants the fields present and
      // empty rather than absent, which `messages.ts` writes from these
      lastTradeDateOrContractMonth: "",
      strike: 0,
      right: "",
      tradingClass: "",
      exchange,
      currency: "USD",
      multiplier: "",
    },
  };
}
