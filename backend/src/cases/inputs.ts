/** The golden cases' INPUTS, written by hand (ADR 0014).
 *
 *  Outputs are never written here: `build.ts` computes them by calling the TypeScript, which is
 *  canonical, and `cases/*.json` is what that produces. A domain change therefore changes the
 *  expected outputs, `make check-cases` (and cases.test.ts) fail until they are regenerated, and
 *  the regenerated cases turn the Python red until it is ported.
 *
 *  Each case is positional arguments, exactly as the function takes them. The ones that look
 *  arbitrary are there on purpose: every `.5` is a rounding boundary where JavaScript and Python
 *  disagree, and the TypeScript itself rounds three ways (`Math.round` in exit and expiry, Python's
 *  half-to-even in thresholdFill, `toFixed` in round4).
 */
import { buildSpxCode } from "../domain/contract.ts";
import type { ExitPolicy } from "../domain/exit.ts";
import type { Monitor } from "../domain/monitor.ts";
import type { ByCode, Position } from "../domain/position.ts";
import type { VolSample } from "../domain/vol.ts";

export interface CaseInput {
  fn: string;
  name: string;
  args: unknown[];
}

const EXP = "2026-11-20";
const code = (type: "CALL" | "PUT", strike: number) => buildSpxCode(EXP, type, strike);
const LP = code("PUT", 6450), SP = code("PUT", 6500), SC = code("CALL", 7100), LC = code("CALL", 7150);

/** an iron condor: long and short puts, short and long calls */
const condor: Position & { id: string } = {
  id: "p1", name: "1120_IC", strike_date: EXP, contracts: 2, entry: 3.0, strategy: "iron condor",
  opened_at: "2026-10-06",
  legs: [
    { side: "long", option_type: "PUT", strike: 6450 },
    { side: "short", option_type: "PUT", strike: 6500 },
    { side: "short", option_type: "CALL", strike: 7100 },
    { side: "long", option_type: "CALL", strike: 7150 },
  ],
};
/** the call spread and the put spread of the same condor, held as two Positions (ADR 0004) */
const callSpread: Position & { id: string } = {
  id: "p2", name: "1120_CS", strike_date: EXP, contracts: 1, entry: 1.4,
  legs: [{ side: "short", option_type: "CALL", strike: 7100 }, { side: "long", option_type: "CALL", strike: 7150 }],
};
const putSpread: Position & { id: string } = {
  id: "p3", name: "1120_PS", strike_date: EXP, contracts: 1, entry: 1.6,
  legs: [{ side: "short", option_type: "PUT", strike: 6500 }, { side: "long", option_type: "PUT", strike: 6450 }],
};
/** a lone long put, whose debit is recorded as a NEGATIVE entry */
const longPut: Position & { id: string } = {
  id: "p4", name: "1120_P6000", strike_date: EXP, contracts: 1, entry: -5.0,
  legs: [{ side: "long", option_type: "PUT", strike: 6000 }],
};
const noEntry: Position = { ...condor, entry: null };

const q = (mid: number, delta: number, extra: Record<string, unknown> = {}) => ({
  mid_price: mid, option_delta: delta, option_gamma: 0.001, option_theta: -0.4,
  option_vega: 2.5, option_implied_volatility: 18.5, option_contract_size: 100, ...extra,
});
const quotes: ByCode = {
  [LP]: q(1.5, -0.08), [SP]: q(3.0, -0.15, { option_vega: 3.1 }),
  [SC]: q(5.0, 0.18, { option_vega: 3.4 }), [LC]: q(2.0, 0.1),
  [code("PUT", 6000)]: q(8.0, -0.02),
};
const missingShortPut: ByCode = Object.fromEntries(Object.entries(quotes).filter(([c]) => c !== SP));
const unreadableVega: ByCode = { ...quotes, [SC]: { ...quotes[SC], option_vega: "n/a" } };

const combo: Monitor = {
  code: "1120_IC", strike_date: EXP, option_type: "CMB", strike: 0, field: "mid_price",
  threshold: 2.5, direction: "above", compare: "abs",
  legs: [
    { sign: 1, option_type: "PUT", strike: 6450 }, { sign: -1, option_type: "PUT", strike: 6500 },
    { sign: -1, option_type: "CALL", strike: 7100 }, { sign: 1, option_type: "CALL", strike: 7150 },
  ],
};
const single: Monitor = {
  code: SC, strike_date: EXP, option_type: "CALL", strike: 7100, field: "option_delta",
  threshold: 0.3, direction: "above", compare: "abs",
};

const policy: ExitPolicy = { takeFraction: 0.5, stopMultiple: 2, manageByDte: 21 };

const sample = (observed_on: string, dte: number, iv: number[], vega: number[]): VolSample => ({
  observed_on, dte,
  legs_iv: Object.fromEntries([LP, SP, SC, LC].map((c, i) => [c, iv[i]!])),
  legs_vega: Object.fromEntries([LP, SP, SC, LC].map((c, i) => [c, vega[i]!])),
});
const chain = [
  sample("2026-10-06", 45, [20, 19, 12, 11.5], [2.0, 3.0, 3.2, 2.4]),
  sample("2026-10-07", 44, [20.5, 19.6, 12.4, 11.8], [2.0, 3.1, 3.3, 2.4]),
  sample("2026-10-08", 43, [19.8, 18.7, 11.9, 11.2], [1.9, 3.0, 3.2, 2.3]),
];

const at = (iso: string) => new Date(iso);

export const INPUTS: Record<string, CaseInput[]> = {
  contract: [
    { fn: "normalizeStrikeDate", name: "dashed stays dashed", args: ["2026-11-20"] },
    { fn: "normalizeStrikeDate", name: "compact becomes dashed", args: ["20261120"] },
    { fn: "normalizeStrikeDate", name: "an impossible date is refused", args: ["2026-13-45"] },
    { fn: "buildSpxCode", name: "a put", args: ["2026-11-20", "PUT", 6500] },
    { fn: "buildSpxCode", name: "a call from a compact date", args: ["20261120", "CALL", 7100] },
    { fn: "buildSpxCode", name: "an end-of-month expiry", args: ["2026-12-31", "PUT", 6000] },
    { fn: "buildSpxCode", name: "an impossible date is refused", args: ["2026-02-30", "PUT", 6000] },
  ],
  expiry: [
    { fn: "marketDate", name: "one minute before New York's midnight", args: [at("2026-10-17T03:59:00Z")] },
    { fn: "marketDate", name: "New York's midnight", args: [at("2026-10-17T04:00:00Z")] },
    { fn: "marketDate", name: "the morning the clocks go back", args: [at("2026-11-01T05:30:00Z")] },
    { fn: "daysToExpiry", name: "34 days out", args: [EXP, at("2026-10-17T14:00:00Z")] },
    { fn: "daysToExpiry", name: "late evening in New York is still that day", args: [EXP, at("2026-10-18T03:30:00Z")] },
    { fn: "daysToExpiry", name: "expiry day is zero", args: [EXP, at("2026-11-20T15:00:00Z")] },
    { fn: "daysToExpiry", name: "after expiry is negative", args: [EXP, at("2026-11-23T15:00:00Z")] },
  ],
  timefmt: [
    { fn: "displayTime", name: "in Singapore", args: [at("2026-10-17T05:26:06Z"), "Asia/Singapore"] },
    { fn: "displayTime", name: "in New York, daylight time", args: [at("2026-10-17T05:26:06Z"), "America/New_York"] },
    { fn: "displayTime", name: "in New York, standard time", args: [at("2026-11-17T05:26:06Z"), "America/New_York"] },
    { fn: "displayTime", name: "in UTC", args: [at("2026-10-17T05:26:06Z"), "UTC"] },
    { fn: "displayTime", name: "nothing to show", args: [null, "Asia/Singapore"] },
    { fn: "displayTimeShort", name: "short, in Singapore", args: [at("2026-10-17T05:26:06Z"), "Asia/Singapore"] },
    { fn: "marketTimeToDisplay", name: "moomoo's naive Eastern time", args: ["2026-10-16 15:59:58", "Asia/Singapore"] },
    { fn: "marketTimeToDisplay", name: "with a fraction", args: ["2026-10-16 15:59:58.125", "Asia/Singapore"] },
    { fn: "marketTimeToDisplay", name: "the hour that happens twice", args: ["2026-11-01 01:30:00", "UTC"] },
    { fn: "marketTimeToDisplay", name: "not a time comes back untouched", args: ["N/A", "Asia/Singapore"] },
    { fn: "marketTimeToDisplay", name: "an impossible time comes back untouched", args: ["2026-13-45 99:99:99", "UTC"] },
  ],
  quote: [
    { fn: "round4", name: "four places", args: [1.23456] },
    { fn: "round4", name: "a decimal half that is not one in binary", args: [1.00005] },
    { fn: "round4", name: "2.675", args: [2.675] },
    { fn: "round4", name: "negative", args: [-0.12345] },
    { fn: "round4", name: "float noise", args: [0.1 + 0.2] },
  ],
  position: [
    { fn: "scopedLegs", name: "the calls of a condor", args: [condor, "calls"] },
    { fn: "scopedLegs", name: "the puts of a condor", args: [condor, "puts"] },
    { fn: "scopedLegs", name: "no scope is every leg", args: [condor, null] },
    { fn: "positionLegCodes", name: "a condor's codes", args: [condor] },
    { fn: "legReadings", name: "vega per leg", args: [condor, quotes, "option_vega"] },
    { fn: "legReadings", name: "a leg unpriced is no map", args: [condor, missingShortPut, "option_vega"] },
    { fn: "legReadings", name: "a reading that is not a number is no map (#109)", args: [condor, unreadableVega, "option_vega"] },
    { fn: "costToClose", name: "a condor", args: [condor, quotes] },
    { fn: "costToClose", name: "its calls", args: [condor, quotes, "calls"] },
    { fn: "costToClose", name: "its puts", args: [condor, quotes, "puts"] },
    { fn: "costToClose", name: "a leg unpriced is no figure", args: [condor, missingShortPut] },
    { fn: "costToClose", name: "a long put", args: [longPut, quotes] },
    { fn: "positionGreek", name: "delta, exposure-signed", args: [condor, quotes, "option_delta"] },
    { fn: "positionGreek", name: "theta", args: [condor, quotes, "option_theta"] },
    { fn: "positionGreek", name: "vega of the puts", args: [condor, quotes, "option_vega", "puts"] },
    { fn: "costToCloseOf", name: "the short put alone (#105)", args: [[condor], quotes, [SP]] },
    { fn: "costToCloseOf", name: "a wing across two holdings", args: [[callSpread, putSpread], quotes, [SC, SP]] },
    { fn: "costToCloseOf", name: "nothing named is held", args: [[condor], quotes, [code("PUT", 6000)]] },
    { fn: "costToCloseOf", name: "a named contract unpriced", args: [[condor], missingShortPut, [SP, SC]] },
    { fn: "contractSize", name: "from the quotes", args: [quotes] },
    { fn: "contractSize", name: "no quotes", args: [{}] },
    { fn: "positionPnl", name: "a condor", args: [condor, quotes] },
    { fn: "positionPnl", name: "a long put's debit", args: [longPut, quotes] },
    { fn: "positionPnl", name: "no entry is no P&L", args: [noEntry, quotes] },
    { fn: "positionPnl", name: "a leg unpriced is no P&L", args: [condor, missingShortPut] },
    { fn: "combinedCostToClose", name: "two spreads", args: [[callSpread, putSpread], quotes] },
    { fn: "combinedEntry", name: "two spreads", args: [[callSpread, putSpread]] },
    { fn: "combinedEntry", name: "one without an entry", args: [[callSpread, noEntry]] },
    { fn: "combinedPnl", name: "two spreads", args: [[callSpread, putSpread], quotes] },
    { fn: "combinedGreek", name: "delta of two spreads", args: [[callSpread, putSpread], quotes, "option_delta"] },
    { fn: "positionsHolding", name: "a whole condor", args: [[condor], [LP, SP, SC, LC]] },
    { fn: "positionsHolding", name: "part of a condor", args: [[condor], [SP]] },
    { fn: "positionsHolding", name: "two spreads together", args: [[callSpread, putSpread], [LP, SP, SC, LC]] },
    { fn: "positionsHolding", name: "a contract held twice is ambiguous", args: [[condor, putSpread], [SP]] },
    { fn: "positionsHolding", name: "nothing held", args: [[condor], [code("PUT", 6000)]] },
  ],
  monitor: [
    { fn: "monitorLegCodes", name: "a combo", args: [combo] },
    { fn: "monitorLegCodes", name: "a single contract", args: [single] },
    { fn: "comboFieldError", name: "IV is never summed", args: ["option_implied_volatility"] },
    { fn: "comboFieldError", name: "mid is", args: ["mid_price"] },
    { fn: "comboFieldSum", name: "a condor's mids", args: [combo, quotes, "mid_price"] },
    { fn: "comboFieldSum", name: "no partial sums", args: [combo, missingShortPut, "mid_price"] },
    { fn: "monitorValue", name: "a single contract", args: [single, quotes] },
    { fn: "monitorValue", name: "a combo", args: [combo, quotes] },
    { fn: "monitorValue", name: "unpriced", args: [single, {}] },
    { fn: "thresholdFill", name: "halfway above", args: [0.15, 0.3, "above", "abs"] },
    { fn: "thresholdFill", name: "12.5 rounds to even", args: [0.125, 1, "above", "abs"] },
    { fn: "thresholdFill", name: "13.5 rounds to even", args: [0.135, 1, "above", "abs"] },
    { fn: "thresholdFill", name: "past the threshold is full", args: [0.5, 0.3, "above", "abs"] },
    { fn: "thresholdFill", name: "below", args: [4, 2, "below", "abs"] },
    { fn: "thresholdFill", name: "below at zero", args: [0, 2, "below", "abs"] },
    { fn: "thresholdFill", name: "abs of a negative", args: [-0.15, 0.3, "above", "abs"] },
    { fn: "thresholdFill", name: "signed and negative", args: [-0.15, 0.3, "above", "signed"] },
    { fn: "thresholdFill", name: "no value", args: [null, 0.3, "above", "abs"] },
    { fn: "thresholdFault", name: "abs needs a positive threshold", args: ["abs", 0] },
    { fn: "thresholdFault", name: "signed may be negative", args: ["signed", -1.5] },
    { fn: "thresholdFault", name: "signed may not be zero", args: ["signed", 0] },
    { fn: "isBreached", name: "exactly at the threshold, above", args: [0.3, 0.3, "above", "abs"] },
    { fn: "isBreached", name: "just under, above", args: [0.2999, 0.3, "above", "abs"] },
    { fn: "isBreached", name: "exactly at the threshold, below", args: [2, 2, "below", "abs"] },
    { fn: "isBreached", name: "abs ignores the sign", args: [-0.31, 0.3, "above", "abs"] },
    { fn: "isBreached", name: "signed below a negative threshold", args: [-2.1, -2, "below", "signed"] },
  ],
  exit: [
    { fn: "dteAtOpen", name: "45 DTE", args: [EXP, "2026-10-06"] },
    { fn: "dteAtOpen", name: "compact dates", args: ["20261120", "20261006"] },
    { fn: "onPace", name: "halfway in time", args: [3, 45, 22] },
    { fn: "onPace", name: "on the day it was opened", args: [3, 45, 45] },
    { fn: "onPace", name: "later than it was opened is no figure", args: [3, 45, 46] },
    { fn: "onPace", name: "no entry", args: [null, 45, 22] },
    { fn: "exitLevels", name: "a credit, calm", args: [3, 45, 30, policy, 1.9] },
    { fn: "exitLevels", name: "a credit at its stop", args: [3, 45, 30, policy, 6] },
    { fn: "exitLevels", name: "a credit at its target", args: [3, 45, 30, policy, 1.5] },
    { fn: "exitLevels", name: "a debit has no target or stop", args: [-5, 45, 30, policy, 8] },
    { fn: "exitLevels", name: "target DTE 12.5 rounds up, as Math.round does", args: [3, 50, 30, policy, null] },
    { fn: "exitLevels", name: "manage-by is inclusive", args: [3, 45, 21, policy, 2] },
    { fn: "exitLevels", name: "never declared opened", args: [3, null, 30, policy, 2] },
  ],
  vol: [
    { fn: "volAttribution", name: "three days from the day it was opened", args: [chain, condor] },
    { fn: "volAttribution", name: "no sample from the day it was opened", args: [chain.slice(1), condor] },
    { fn: "volAttribution", name: "a market day missing", args: [[chain[0], chain[2]], condor] },
    { fn: "volAttribution", name: "a day without vega", args: [[chain[0], { ...chain[1]!, legs_vega: null }], condor] },
  ],
};
