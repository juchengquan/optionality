/** The recorded truth for each vendor's field mapping, so one corpus serves two languages.
 *
 *  Each vendor's `fields.ts` is PURE — it imports a domain type and nothing else — and canonical:
 *  `yahooFields.toRecord` decides which Yahoo number becomes the figure a Reference shows, and
 *  `ibkrFields.greekFields` decides that IBKR's implied volatility changes units. Nothing cased any
 *  of it. `cases.test.ts` holds its module list to the `domain/` DIRECTORY, deliberately, so a new
 *  domain file cannot escape — and these are not in that directory, so they escaped by category.
 *
 *  ## Why a second corpus rather than widening the first
 *
 *  Two reasons, and the first is about a released tag.
 *
 *  `goldenHash` covers `buildCases()`, and `GOLDEN_CASES` answers one question: does this port
 *  reproduce the service's DOMAIN. The Python package has no vendor ports yet. Folding these cases
 *  into that hash would make every released package — `py-2026.11.9`, installed and answering
 *  "agrees" today — report disagreement over code it does not contain. `api.agrees()` would be
 *  wrong rather than informative, which is worse than silent.
 *
 *  And widening `cases.test.ts`'s module list from "the directory" to "the directory plus a list"
 *  reintroduces the list that can go stale. That guard exists because adding `domain/greeks.ts`
 *  and nothing else once left every check green.
 *
 *  So: `testdata/vendors/`, its own staleness check, outside the fingerprint. When the Python
 *  ports land, whether vendor parity belongs in the fingerprint is a decision to take then.
 *
 *  ## The inputs are measurements
 *
 *  Every row here was recorded from a live vendor on 2026-11-08 and carried across from the two
 *  suites that asserted them by hand. #204 exists because two fixture values were once invented
 *  under a comment claiming measurement, so the provenance of each is stated.
 */
import { ibkrFields, yahooFields } from "../vendors/fields.ts";

export const VENDOR_MODULES: Record<string, Record<string, unknown>> = {
  "yahoo-fields": yahooFields as unknown as Record<string, unknown>,
  "ibkr-fields": ibkrFields as unknown as Record<string, unknown>,
};

/** `^GSPC` exactly as Yahoo returned it on 2026-11-08 — including the bogus book: a bid 148 points
 *  ABOVE a price that closed at 7376.86, and a 100-point spread. Not a book, but some other figure
 *  under a familiar name, which is why `toRecord` carries neither it nor a mid derived from it. */
const GSPC = {
  symbol: "^GSPC", shortName: "S&P 500",
  regularMarketPrice: 7376.86, regularMarketPreviousClose: 7353.73,
  bid: 7524.56, ask: 7624.67,
  exchangeDataDelayedBy: 0, marketState: "CLOSED",
};

/** `^VIX` the same day: the only vendor that states a DURATION rather than a tier. */
const VIX = {
  symbol: "^VIX", shortName: "CBOE Volatility Index",
  regularMarketPrice: 25.64, regularMarketPreviousClose: 28.18,
  bid: 0, ask: 0, exchangeDataDelayedBy: 15, marketState: "CLOSED",
};

export const VENDOR_INPUTS: Record<
  string, readonly { fn: string; name: string; args: unknown[] }[]
> = {
  "yahoo-fields": [
    // the book is dropped on purpose: `domain/reference.ts` PREFERS the mid, so a mid derived from
    // that bogus book would have put 7,574 on the strip instead of 7,376 — entirely plausibly
    { fn: "toRecord", name: "an index carries no book and no mid, only the price Yahoo means",
      args: ["^GSPC", GSPC] },
    // checked against Cboe's own delayed-quote endpoint for the same session: 7376.86
    { fn: "toRecord", name: "the regular-market price and the previous close",
      args: ["^VIX", VIX] },
    { fn: "toRecord", name: "not delayed where Yahoo says zero minutes",
      args: ["^GSPC", { ...GSPC, exchangeDataDelayedBy: 0 }] },
    { fn: "toRecord", name: "states the minutes where Yahoo does — the only source that can",
      args: ["^VIX", { ...VIX, exchangeDataDelayedBy: 15 }] },
    { fn: "toRecord", name: "a regular session is not last known",
      args: ["^GSPC", { ...GSPC, marketState: "REGULAR" }] },
    { fn: "toRecord", name: "pre-market is last known, because an index is not calculated then",
      args: ["^GSPC", { ...GSPC, marketState: "PRE" }] },
    { fn: "toRecord", name: "post-market is too",
      args: ["^GSPC", { ...GSPC, marketState: "POST" }] },
    // null and false are different claims: false means "it told us it is live"
    { fn: "toRecord", name: "says nothing where Yahoo said nothing, rather than claiming live",
      args: ["^GSPC", { symbol: "^GSPC", regularMarketPrice: 1 }] },
  ],
  "ibkr-fields": [
    // measured, same contract, same minute: moomoo said 14.007 and IBKR said 0.1368. A rule set at
    // 14 would never fire on IBKR; one set at 0.14 would fire constantly on moomoo.
    { fn: "greekFields", name: "implied volatility changes units, fraction into percent",
      args: [{ impliedVol: 0.13679778548286392, delta: null, gamma: null, vega: null, theta: null }] },
    { fn: "greekFields", name: "the greeks themselves are already dimensionless",
      args: [{ impliedVol: null, delta: 0.02806614063578037, gamma: 0.00018826189971762677,
        vega: 1.8321828845155324, theta: -0.28028107934963487 }] },
    // a WRITTEN null would satisfy `hasFigures` and claim the contract answered
    { fn: "greekFields", name: "omits a greek that was not computed rather than writing null",
      args: [{ impliedVol: null, delta: null, gamma: null, vega: null, theta: null }] },

    // the gateway drew this distinction per contract in one response on 2026-11-08 — SPX granted
    // DELAYED while VIX granted DELAYED_FROZEN — so collapsing 4 into 3 decides we know better
    { fn: "grade", name: "grade 1 is live and not frozen", args: [1] },
    { fn: "grade", name: "grade 2 is live and last known", args: [2] },
    { fn: "grade", name: "grade 3 is delayed", args: [3] },
    { fn: "grade", name: "grade 4 is delayed AND last known, kept as both", args: [4] },
    // null renders as nothing; false would read as "live and updating", which is a claim
    { fn: "grade", name: "says nothing about a grade nobody documented", args: [0] },
    { fn: "grade", name: "and nothing about one out of range", args: [7] },

    { fn: "withMid", name: "the midpoint where both sides arrived",
      args: [{ bid_price: 3.5, ask_price: 4.1 }] },
    // a mid from one side is a number with no meaning
    { fn: "withMid", name: "absent where only the bid did", args: [{ bid_price: 3.5 }] },
    { fn: "withMid", name: "absent where only the ask did", args: [{ ask_price: 4.1 }] },
    // 0/0 is an empty book, and whether 0 may be SHOWN is ADR 0018's guard to decide
    { fn: "withMid", name: "zero for an empty book, left for the domain to judge",
      args: [{ bid_price: 0, ask_price: 0 }] },

    // "subscribed, nothing yet" — a figure that did not arrive, NOT a contract that does not exist
    { fn: "hasFigures", name: "false for a record carrying only its identity",
      args: [{ code: "SPX", name: "S&P 500" }] },
    // the gateway answers the grade for every request, including ones that price nothing
    { fn: "hasFigures", name: "false for identity plus a grade, which is not a figure",
      args: [{ code: "SPX", delayed: true, last_known: true }] },
    { fn: "hasFigures", name: "true for one figure, however little",
      args: [{ code: "SPX", prev_close_price: 7353.73 }] },
  ],
};
