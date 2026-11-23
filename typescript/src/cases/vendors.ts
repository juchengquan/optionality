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
import { ibkrFields, opendFields, yahooFields } from "../vendors/fields.ts";

export const VENDOR_MODULES: Record<string, Record<string, unknown>> = {
  "yahoo-fields": yahooFields as unknown as Record<string, unknown>,
  "ibkr-fields": ibkrFields as unknown as Record<string, unknown>,
  "opend-fields": opendFields as unknown as Record<string, unknown>,
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
    // 0/0 is an empty book and no price (#380): it was a mid of 0, "left for the domain to judge",
    // and valued the book at 0.00 out of hours. The sides are kept.
    { fn: "withMid", name: "absent for an empty book, whose sides are kept",
      args: [{ bid_price: 0, ask_price: 0 }] },
    { fn: "withMid", name: "absent where the ask is zero, whatever the bid",
      args: [{ bid_price: 4.4, ask_price: 0 }] },
    // a worthless wing offered at 0.05 is a quote
    { fn: "withMid", name: "a bid of zero against a real offer", args: [{ bid_price: 0, ask_price: 0.05 }] },

    // "subscribed, nothing yet" — a figure that did not arrive, NOT a contract that does not exist
    { fn: "hasFigures", name: "false for a record carrying only its identity",
      args: [{ code: "SPX", name: "S&P 500" }] },
    // the gateway answers the grade for every request, including ones that price nothing
    { fn: "hasFigures", name: "false for identity plus a grade, which is not a figure",
      args: [{ code: "SPX", delayed: true, last_known: true }] },
    { fn: "hasFigures", name: "true for one figure, however little",
      args: [{ code: "SPX", prev_close_price: 7353.73 }] },

    // --- the account (ADR 0030). Laid out as ibapi 9.81 reads PORTFOLIO_VALUE and ACCT_VALUE at
    // protocol 157; every symbol, figure and account id is INVENTED, the ids placeholders — the
    // owner's account is never committed (the repository is public)
    { fn: "managedAccounts", name: "one account", args: ["U0000000"] },
    { fn: "managedAccounts", name: "several, comma-separated", args: ["U0000000,U0000001"] },
    { fn: "managedAccounts", name: "a trailing comma names no account", args: ["DU0000000,"] },
    { fn: "managedAccounts", name: "an empty field names none", args: [""] },
    // the owner's decision on #469: the letters say what kind of account, the last three which
    { fn: "maskAccount", name: "the prefix, five bullets, the last three",
      args: ["U0000001"] },
    // five whatever the length: the mask does not say how long the id is
    { fn: "maskAccount", name: "five bullets for a longer id too", args: ["U00000001"] },
    { fn: "maskAccount", name: "a paper id keeps its DU", args: ["DU0000000"] },
    { fn: "maskAccount", name: "a digit after the prefix's last letter is masked like the rest",
      args: ["DU00A0001"] },
    // review round 2: an id of three digits or fewer still hides at least one of them
    { fn: "maskAccount", name: "a short id shows all but one of its digits, never all",
      args: ["U001"] },
    { fn: "maskAccount", name: "a one-digit id shows no digit", args: ["U1"] },
    { fn: "maskAccount", name: "an id of letters alone keeps only its last three", args: ["ABCDEFG"] },
    { fn: "maskAccount", name: "an empty id is empty", args: [""] },
    { fn: "isPaper", name: "an id that starts DU is paper", args: ["DU0000000"] },
    { fn: "isPaper", name: "a live individual account is not", args: ["U0000000"] },
    { fn: "isPaper", name: "nor is an advisor's DF", args: ["DF0000000"] },
    { fn: "chooseAccount", name: "the login's only account, unasked", args: [["U0000000"], null] },
    { fn: "chooseAccount", name: "the one named, of several",
      args: [["U0000000", "U0000001"], "U0000001"] },
    // the owner's decision: with several and none named the read refuses rather than guessing
    { fn: "chooseAccount", name: "several and none named: refused, the ids masked",
      args: [["U0000000", "U0000001"], null] },
    { fn: "chooseAccount", name: "a named account not on the login: refused, it masked too",
      args: [["U0000000", "U0000001"], "DU0000001"] },
    { fn: "chooseAccount", name: "named, even with one account, it must be that one",
      args: [["U0000000"], "U0000001"] },
    { fn: "chooseAccount", name: "a blank name is none", args: [["U0000000"], " "] },
    { fn: "chooseAccount", name: "no account named by the gateway", args: [[], null] },
    // IB's averageCost for an option is per CONTRACT: 2.50 arrives as 250
    { fn: "perShareCost", name: "an option's average cost per share", args: [250, 100] },
    { fn: "perShareCost", name: "a stock's, which has no multiplier, as sent", args: [38.115, null] },
    { fn: "perShareCost", name: "a multiplier of zero divides by nothing", args: [38.115, 0] },
    { fn: "perShareCost", name: "no cost is no cost", args: [null, 100] },
    { fn: "holdingFrom", name: "a long call, its cost per share", args: [{
      sec_type: "OPT", symbol: "ACME", expiry: "20261218", strike: "45.0", right: "C",
      multiplier: "100", currency: "USD", position: "4", market_price: "3.85",
      market_value: "1540.0", average_cost: "262.5", unrealized_pnl: "490.0", realized_pnl: "0.0" }] },
    { fn: "holdingFrom", name: "a short put with realised P&L, its sign kept", args: [{
      sec_type: "OPT", symbol: "ACME", expiry: "20261218", strike: "35.0", right: "P",
      multiplier: "100", currency: "USD", position: "-6", market_price: "0.92",
      market_value: "-552.0", average_cost: "141.8", unrealized_pnl: "298.8",
      realized_pnl: "-412.8" }] },
    // a stock's row carries right "0" and strike "0", expiry and multiplier empty (measured on the
    // live gateway on 2026-11-23)
    { fn: "holdingFrom", name: "a stock: no strike, no side, no expiry, no multiplier", args: [{
      sec_type: "STK", symbol: "ACME", expiry: "", strike: "0", right: "0", multiplier: "",
      currency: "USD", position: "300", market_price: "41.27", market_value: "12381.0",
      average_cost: "38.115", unrealized_pnl: "946.5", realized_pnl: "0.0" }] },
    { fn: "holdingFrom", name: "a stock in another currency, its figures in that one", args: [{
      sec_type: "STK", symbol: "INITECH", expiry: "", strike: "0", right: "0", multiplier: "",
      currency: "HKD", position: "50", market_price: "108.4", market_value: "5420.0",
      average_cost: "102.2", unrealized_pnl: "310.0", realized_pnl: "0.0" }] },
    { fn: "holdingFrom", name: "a side written out in full", args: [{
      sec_type: "OPT", symbol: "ACME", expiry: "20261218", strike: "35", right: "PUT",
      multiplier: "100", currency: "USD", position: "1", market_price: "0.92",
      market_value: "92", average_cost: "100", unrealized_pnl: "-8", realized_pnl: "0" }] },
    // JavaScript's Number, not Python's float: "0x1C" is 28 and "1_00" is no number (round 3)
    { fn: "holdingFrom", name: "a figure is read by JavaScript's Number rules", args: [{
      sec_type: "OPT", symbol: "ACME", expiry: "20261218", strike: "0x1C", right: "C",
      multiplier: "100", currency: "USD", position: "1_00", market_price: " 3.85 ",
      market_value: "Infinity", average_cost: "1e3", unrealized_pnl: "-12.5", realized_pnl: "+5" }] },
    { fn: "holdingFrom", name: "an empty figure is none, never 0", args: [{
      sec_type: "OPT", symbol: "ACME", expiry: "20261218", strike: "45.0", right: "C",
      multiplier: "100", currency: "USD", position: "4", market_price: "", market_value: "",
      average_cost: "", unrealized_pnl: "", realized_pnl: "" }] },
    { fn: "accountAnswer", name: "the base from NetLiquidation, each total from BASE first", args: [
      "U0000000",
      [
        { key: "AccountCode", value: "U0000000", currency: "" },
        { key: "NetLiquidation", value: "184523.17", currency: "USD" },
        { key: "TotalCashValue", value: "61230.55", currency: "USD" },
        { key: "UnrealizedPnL", value: "2875.40", currency: "BASE" },
        { key: "UnrealizedPnL", value: "2565.40", currency: "USD" },
        { key: "UnrealizedPnL", value: "310.00", currency: "EUR" },
        { key: "RealizedPnL", value: "-412.80", currency: "BASE" },
        { key: "RealizedPnL", value: "-412.80", currency: "USD" },
      ],
      [], "14:32"] },
    { fn: "accountAnswer", name: "a total with no BASE row is read in the base currency", args: [
      "DU0000000",
      [
        { key: "NetLiquidation", value: "1003250.00", currency: "USD" },
        { key: "UnrealizedPnL", value: "150.00", currency: "USD" },
        { key: "RealizedPnL", value: "1.00", currency: "EUR" },
      ],
      [], "09:05"] },
    // the live gateway's keys, measured on 2026-11-23: the P&L only under $LEDGER-, in BASE and
    // each currency; NetLiquidation and TotalCashValue plain in USD beside their -S segment rows;
    // the exchange rates in $LEDGER-ExchangeRate, base units per unit of each currency
    { fn: "accountAnswer", name: "the live gateway's keys: P&L from $LEDGER's BASE row", args: [
      "U0000000",
      [
        { key: "AccountCode", value: "U0000000", currency: "" },
        { key: "NetLiquidation", value: "184523.17", currency: "USD" },
        { key: "NetLiquidation-S", value: "184000.00", currency: "USD" },
        { key: "TotalCashValue", value: "61230.55", currency: "USD" },
        { key: "TotalCashValue-S", value: "61000.00", currency: "USD" },
        { key: "$LEDGER-UnrealizedPnL", value: "2071.40", currency: "BASE" },
        { key: "$LEDGER-UnrealizedPnL", value: "1735.30", currency: "USD" },
        { key: "$LEDGER-UnrealizedPnL", value: "2635.10", currency: "HKD" },
        { key: "$LEDGER-RealizedPnL", value: "-412.80", currency: "BASE" },
        { key: "$LEDGER-RealizedPnL", value: "-412.80", currency: "USD" },
        { key: "$LEDGER-ExchangeRate", value: "1.00", currency: "BASE" },
        { key: "$LEDGER-ExchangeRate", value: "1.00", currency: "USD" },
        { key: "$LEDGER-ExchangeRate", value: "0.1284", currency: "HKD" },
        { key: "$LEDGER-ExchangeRate", value: "0.7712", currency: "SGD" },
      ],
      [], "18:07"] },
    { fn: "accountAnswer", name: "a plain BASE row is preferred to $LEDGER's", args: [
      "U0000000",
      [
        { key: "UnrealizedPnL", value: "1.00", currency: "BASE" },
        { key: "$LEDGER-UnrealizedPnL", value: "2.00", currency: "BASE" },
      ],
      [], null] },
    { fn: "accountAnswer", name: "a rate that is not a positive number is no rate", args: [
      "U0000000",
      [
        { key: "NetLiquidation", value: "1.00", currency: "USD" },
        { key: "$LEDGER-ExchangeRate", value: "0", currency: "EUR" },
        { key: "$LEDGER-ExchangeRate", value: "", currency: "JPY" },
        { key: "$LEDGER-ExchangeRate", value: "-1", currency: "CHF" },
        { key: "$LEDGER-ExchangeRate", value: "0x10", currency: "GBP" },
      ],
      [], null] },
    { fn: "accountAnswer", name: "nothing said is nothing claimed", args: ["U0000001", [], [], null] },
  ],
  // the record's fields are a list, which the Python's SDK-frame reader is held to
  // (`vendors/opend/fields.ts` says why it cannot be logic); the quote grade is logic (#464)
  "opend-fields": [
    // what this account's OpenD answered on 2026-11-20, over the websocket and over the SDK's TCP
    // alike: usOptionQotRight 2, which the Python SDK calls LV1
    { fn: "gradeName", name: "2 is Level 1, as this account's options were graded on 2026-11-20", args: [2] },
    { fn: "gradeName", name: "0 is moomoo's Unknow, which the SDK writes N/A", args: [0] },
    { fn: "gradeName", name: "1 is BMP", args: [1] },
    { fn: "gradeName", name: "3 is Level 2", args: [3] },
    { fn: "gradeName", name: "4 is SF", args: [4] },
    { fn: "gradeName", name: "5 is no rights at all", args: [5] },
    // 6 after NO, not after LV2: the enum grew Level 3 last
    { fn: "gradeName", name: "6 is Level 3", args: [6] },
    { fn: "gradeName", name: "a number moomoo has not used is N/A, as the SDK has it", args: [7] },
    { fn: "gradeName", name: "and so is no number at all — a field OpenD left out", args: [null] },
    { fn: "isRealtime", name: "Level 1 is real-time", args: ["LV1"] },
    { fn: "isRealtime", name: "Level 2 is real-time", args: ["LV2"] },
    { fn: "isRealtime", name: "Level 3 is real-time", args: ["LV3"] },
    { fn: "isRealtime", name: "SF is real-time", args: ["SF"] },
    // a grade that is not real-time says nothing of HOW late: moomoo states no minutes
    { fn: "isRealtime", name: "BMP is not real-time", args: ["BMP"] },
    { fn: "isRealtime", name: "NO is not real-time", args: ["NO"] },
    // null, not false: false is a claim about the account, and Unknow is moomoo making none
    { fn: "isRealtime", name: "N/A says nothing either way", args: ["N/A"] },
    { fn: "isRealtime", name: "nor does a name moomoo has not used", args: ["LV9"] },
  ],
};
