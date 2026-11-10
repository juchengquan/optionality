/** The golden cases' INPUTS, written by hand (ADR 0014).
 *
 *  Outputs are never written here: `build.ts` computes them by calling the TypeScript, which is
 *  canonical, and `testdata/golden/*.json` is what that produces. A domain change therefore changes the
 *  expected outputs, `make check-cases` (and cases.test.ts) fail until they are regenerated, and
 *  the regenerated cases turn the Python red until it is ported.
 *
 *  Each case is positional arguments, exactly as the function takes them. The ones that look
 *  arbitrary are there on purpose: every `.5` is a rounding boundary where JavaScript and Python
 *  disagree, and the TypeScript itself rounds three ways (`Math.round` in exit and expiry, Python's
 *  half-to-even in thresholdFill, `toFixed` in round4).
 */
import type { AlarmPolicy, AlarmState } from "../domain/alarm.ts";
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

/** US.SPY as the live gateway gave it on 2026-11-02, trimmed to the fields a Reference reads.
 *
 *  Kept whole-ish because the measurement is the point: the last trade and the previous close are
 *  the same number, which is what a stale last LOOKS like, and the mid is three points away from
 *  both (ADR 0018).
 */
const spy = {
  code: "US.SPY", name: "SPDR S&P 500 ETF Trust",
  bid_price: 758.7, ask_price: 758.76, mid_price: 758.73,
  last_price: 755.72, prev_close_price: 755.72,
};

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

/** The alarm decision's own fixtures (ADR 0017).
 *
 *  `now` and the stamps are fixed instants rather than offsets from today: the decision is
 *  entirely about the gap between two times, and a case computed from `new Date()` would be a
 *  different case every day.
 */
const NOW = new Date("2026-11-01T12:00:00Z");

/** Fixtures for domain/degraded.ts. Named with the prefix because `state` and `ago` are already
 *  taken by the alarm cases below and mean something else there. */
const degradedAgo = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);
const degradedState = (failures: number, since: Date | null, lastNoticeAt: Date | null) =>
  ({ failures, since, lastNoticeAt });
const degradedPolicy_ = { afterFailures: 5, repeatSeconds: 1800 };

/** Fixtures for domain/flapping.ts, which takes TIMESTAMPS rather than a count. */
const flapAgo = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);
const flapState = (secondsAgo: number[]) =>
  ({ failures: secondsAgo.map(flapAgo), lastNoticeAt: null, announced: false });
const flapPolicy = { windowSeconds: 900, afterFailures: 5, repeatSeconds: 1800 };
const flapNoRepeat = { windowSeconds: 900, afterFailures: 5, repeatSeconds: 0 };
const flapOff = { windowSeconds: 900, afterFailures: 0, repeatSeconds: 1800 };
const flapWide = { windowSeconds: 5400, afterFailures: 2, repeatSeconds: 1800 };
const degradedNoRepeat = { afterFailures: 5, repeatSeconds: 0 };
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);
const state = (triggered: boolean, lastAlarmAt: Date | null): AlarmState => ({ triggered, lastAlarmAt });
/** the service's own defaults: throttle a state change for 15 minutes, re-remind after an hour */
const alarms: AlarmPolicy = { cooldownSeconds: 900, repeatSeconds: 3600 };
const noRepeat: AlarmPolicy = { cooldownSeconds: 900, repeatSeconds: 0 };
/** `direction: "below"` — the wording changes on every branch, which is the point of casing it */
const falling: Monitor = { ...single, direction: "below", threshold: 0.3 };

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
/** A day's vol readings for `takesSample`: both maps, or one withheld. */
const WHOLE = { legs_iv: '{"a":14.5}', legs_vega: '{"a":4.25}' };
const NO_VEGA = { legs_iv: '{"a":14.5}', legs_vega: null };
const NO_IV = { legs_iv: null, legs_vega: '{"a":4.25}' };
/** A stored day's row for 9 November 2026 (EST), by when it was observed. */
const PROVISIONAL = { ...WHOLE, observed_at: "2026-11-09 05:05:00.000000" }; // 00:05, before the open
const IN_HOURS = { ...WHOLE, observed_at: "2026-11-09 16:00:00.000000" }; // 11:00
const POST_CLOSE = { ...WHOLE, observed_at: "2026-11-10 01:30:00.000000" }; // 20:30
const LEGACY = { ...WHOLE, observed_at: null }; // written before observed_at existed

export const INPUTS: Record<string, CaseInput[]> = {
  contract: [
    { fn: "normalizeStrikeDate", name: "dashed stays dashed", args: ["2026-11-20"] },
    { fn: "normalizeStrikeDate", name: "compact becomes dashed", args: ["20261120"] },
    { fn: "normalizeStrikeDate", name: "an impossible date is refused", args: ["2026-13-45"] },
    { fn: "normalizeStrikeDate", name: "a date with a time after it", args: ["2026-11-20T00:00"] },
    // JavaScript's \d is 0-9 alone; Python's matches every Unicode decimal digit. These hold the
    // port to the TypeScript's refusal (found porting the Python backend's request schemas).
    { fn: "normalizeStrikeDate", name: "Arabic-Indic digits are not a date", args: ["\u0662\u0660\u0662\u0666-\u0661\u0662-\u0661\u0668"] },
    { fn: "normalizeStrikeDate", name: "full-width digits are not a date", args: ["\uff12\uff10\uff12\uff16\uff11\uff12\uff11\uff18"] },
    { fn: "buildSpxCode", name: "a put", args: ["2026-11-20", "PUT", 6500] },
    { fn: "buildSpxCode", name: "a call from a compact date", args: ["20261120", "CALL", 7100] },
    { fn: "buildSpxCode", name: "an end-of-month expiry", args: ["2026-12-31", "PUT", 6000] },
    { fn: "buildSpxCode", name: "an impossible date is refused", args: ["2026-02-30", "PUT", 6000] },
    { fn: "compactStrikeDate", name: "dashed", args: ["2026-11-20"] },
    { fn: "compactStrikeDate", name: "compact", args: ["20261120"] },
    { fn: "compactStrikeDate", name: "an impossible date is refused", args: ["2026-02-30"] },
    { fn: "parseSpxCode", name: "a put", args: ["US.SPXW261120P6500000"] },
    { fn: "parseSpxCode", name: "a call", args: ["US.SPXW261016C7100000"] },
    { fn: "parseSpxCode", name: "a code from somewhere else", args: ["US.WEIRD123"] },
    { fn: "parseSpxCode", name: "a combo's own name", args: ["sep-condor"] },
    { fn: "parseSpxCode", name: "a day that does not exist", args: ["US.SPXW260230P6500000"] },
    { fn: "parseSpxCode", name: "a strike with a leading zero", args: ["US.SPXW261120P06500000"] },
    // anchoring: the TypeScript matches the WHOLE string, and a port that searches inside one
    // would read a code out of surrounding text — which these two are what catch
    { fn: "parseSpxCode", name: "a code with something before it", args: ["XUS.SPXW261120P6500000"] },
    { fn: "parseSpxCode", name: "a code with something after it", args: ["US.SPXW261120P6500000X"] },
    { fn: "parseSpxCode", name: "a code with non-ASCII digits", args: ["US.SPXW\u0662\u0666\u0661\u0661\u0662\u0660P6500000"] },
    { fn: "shortSpxCode", name: "a call", args: ["US.SPXW260918C8100000"] },
    { fn: "shortSpxCode", name: "a name it cannot read", args: ["sep-condor"] },
    { fn: "expandSpxShort", name: "as the bot prints it", args: ["260918 C8100"] },
    { fn: "expandSpxShort", name: "as a person types it", args: ["260918c8100"] },
    { fn: "expandSpxShort", name: "not the short form at all", args: ["sep-condor"] },
    { fn: "expandSpxShort", name: "a day that does not exist", args: ["260230C8100"] },
    { fn: "expandSpxShort", name: "a short form inside other text", args: ["x260918C8100"] },
    { fn: "expandSpxShort", name: "non-ASCII digits are not a short form", args: ["\u0662\u0666\u0660\u0669\u0661\u0668 C8100"] },
    // what JavaScript's \s strips and Python's does not, and the reverse: a no-break space and a
    // byte-order mark are whitespace to JavaScript; a file separator is whitespace only to Python
    { fn: "expandSpxShort", name: "a no-break space is whitespace", args: ["260918\u00a0C8100"] },
    { fn: "expandSpxShort", name: "a byte-order mark is whitespace", args: ["\ufeff260918 C8100"] },
    { fn: "expandSpxShort", name: "a file separator is not whitespace", args: ["260918\u001cC8100"] },
  ],
  expiry: [
    { fn: "marketDate", name: "one minute before New York's midnight", args: [at("2026-10-17T03:59:00Z")] },
    { fn: "marketDate", name: "New York's midnight", args: [at("2026-10-17T04:00:00Z")] },
    { fn: "marketDate", name: "the morning the clocks go back", args: [at("2026-11-01T05:30:00Z")] },
    { fn: "daysToExpiry", name: "34 days out", args: [EXP, at("2026-10-17T14:00:00Z")] },
    { fn: "daysToExpiry", name: "late evening in New York is still that day", args: [EXP, at("2026-10-18T03:30:00Z")] },
    { fn: "daysToExpiry", name: "expiry day is zero", args: [EXP, at("2026-11-20T15:00:00Z")] },
    { fn: "daysToExpiry", name: "after expiry is negative", args: [EXP, at("2026-11-23T15:00:00Z")] },
    // the hours a day's sample may be taken in: each boundary from both sides, to the millisecond,
    // because the Python reads a microsecond clock and has to land where JavaScript's does
    { fn: "inSampleHours", name: "a millisecond before 09:30", args: [at("2026-11-09T14:29:59.999Z")] },
    { fn: "inSampleHours", name: "09:30 exactly", args: [at("2026-11-09T14:30:00.000Z")] },
    // 16:15 is the options' close, a quarter hour after the stocks', so 16:00 is still inside
    { fn: "inSampleHours", name: "16:00, the stocks' close", args: [at("2026-11-09T21:00:00.000Z")] },
    { fn: "inSampleHours", name: "16:15 exactly", args: [at("2026-11-09T21:15:00.000Z")] },
    { fn: "inSampleHours", name: "a millisecond after 16:15", args: [at("2026-11-09T21:15:00.001Z")] },
    // every calendar day, because the vol chain needs a row for each: these carry the last close
    { fn: "inSampleHours", name: "Saturday noon", args: [at("2026-11-07T17:00:00Z")] },
    { fn: "inSampleHours", name: "Sunday evening, when Global Trading Hours have begun",
      args: [at("2026-11-09T01:30:00Z")] },
    { fn: "inSampleHours", name: "Thanksgiving noon, a holiday with no calendar to say so",
      args: [at("2026-11-26T17:00:00Z")] },
    { fn: "inSampleHours", name: "a half-day after its 13:00 close", args: [at("2026-11-27T19:00:00Z")] },
    // each 2026 clock change, on an instant a fixed offset would get wrong
    { fn: "inSampleHours", name: "09:30 EDT, the Monday after the clocks went forward",
      args: [at("2026-03-09T13:30:00Z")] },
    { fn: "inSampleHours", name: "16:30 EDT, the Friday before the clocks went back",
      args: [at("2026-10-30T20:30:00Z")] },
    { fn: "inSampleHours", name: "09:00 EST, the Monday after the clocks went back",
      args: [at("2026-11-02T14:00:00Z")] },
    // an overnight mark: New York is still on Monday evening while UTC has reached Tuesday
    { fn: "inSampleHours", name: "Monday 23:30 in New York, Tuesday in UTC",
      args: [at("2026-11-10T04:30:00Z")] },
    // what a sweep does with the day's row, branch by branch: Monday 9 November 2026, EST
    { fn: "takesSample", name: "no row, before the open", args: [at("2026-11-09T05:05:00Z"), null, WHOLE] },
    { fn: "takesSample", name: "no row, in the hours", args: [at("2026-11-09T16:00:00Z"), null, WHOLE] },
    { fn: "takesSample", name: "no row, after the close, from a sweep missing a map",
      args: [at("2026-11-10T01:30:00Z"), null, NO_VEGA] },
    { fn: "takesSample", name: "a provisional row, before the open", args: [at("2026-11-09T06:00:00Z"), PROVISIONAL, WHOLE] },
    { fn: "takesSample", name: "a legacy row, before the open", args: [at("2026-11-09T06:00:00Z"), LEGACY, WHOLE] },
    { fn: "takesSample", name: "a provisional row in the hours is restamped, as a weekend's is",
      args: [at("2026-11-09T16:00:00Z"), PROVISIONAL, WHOLE] },
    { fn: "takesSample", name: "a settled row in the hours", args: [at("2026-11-09T16:00:00Z"), IN_HOURS, WHOLE] },
    { fn: "takesSample", name: "a legacy row in the hours", args: [at("2026-11-09T16:00:00Z"), LEGACY, WHOLE] },
    { fn: "takesSample", name: "a provisional row after the close is replaced: a missed session",
      args: [at("2026-11-10T01:30:00Z"), PROVISIONAL, WHOLE] },
    { fn: "takesSample", name: "a complete provisional row is not traded for readings without a vega",
      args: [at("2026-11-10T01:30:00Z"), PROVISIONAL, NO_VEGA] },
    { fn: "takesSample", name: "an incomplete provisional row is replaced whatever the readings",
      args: [at("2026-11-10T01:30:00Z"), { ...PROVISIONAL, ...NO_VEGA }, NO_IV] },
    { fn: "takesSample", name: "a row settled in the hours, after the close", args: [at("2026-11-10T01:30:00Z"), IN_HOURS, WHOLE] },
    { fn: "takesSample", name: "a row settled after the close, up to midnight",
      args: [at("2026-11-10T04:59:59Z"), POST_CLOSE, WHOLE] },
    { fn: "takesSample", name: "a legacy row, after the close", args: [at("2026-11-10T01:30:00Z"), LEGACY, WHOLE] },
    { fn: "takesSample", name: "a settled row without its vega, completed after the close",
      args: [at("2026-11-10T01:30:00Z"), { ...IN_HOURS, ...NO_VEGA }, WHOLE] },
    { fn: "takesSample", name: "a legacy row without its IV, completed after the close",
      args: [at("2026-11-10T01:30:00Z"), { ...LEGACY, ...NO_IV }, WHOLE] },
    { fn: "takesSample", name: "a sweep that would trade one missing map for another",
      args: [at("2026-11-10T01:30:00Z"), { ...IN_HOURS, ...NO_VEGA }, NO_IV] },
    { fn: "takesSample", name: "a millisecond after 16:15, over a settled row",
      args: [at("2026-11-09T21:15:00.001Z"), IN_HOURS, WHOLE] },
    // provisional is read on New York's clock: under EDT, 13:29:59Z is before the open, 13:30Z is it
    { fn: "takesSample", name: "observed at 09:29:59 EDT is provisional",
      args: [at("2026-10-01T15:00:00Z"), { ...WHOLE, observed_at: "2026-10-01 13:29:59.000000" }, WHOLE] },
    { fn: "takesSample", name: "observed at 09:30 EDT is settled",
      args: [at("2026-10-01T15:00:00Z"), { ...WHOLE, observed_at: "2026-10-01 13:30:00.000000" }, WHOLE] },
  ],
  timefmt: [
    { fn: "displayTime", name: "in Singapore", args: [at("2026-10-17T05:26:06Z"), "Asia/Singapore"] },
    // the zone left off, which no case did until now. "" is not UTC: it means the RUNNING
    // machine's zone, and both suites pin TZ for exactly that reason — the library's vitest config
    // sets TZ=UTC so a date test reads the same anywhere
    { fn: "displayTime", name: "no zone given, so the machine's own",
      args: [at("2026-10-17T05:26:06Z")] },
    { fn: "displayTimeShort", name: "no zone given, so the machine's own",
      args: [at("2026-10-17T05:26:06Z")] },
    { fn: "displayTime", name: "in New York, daylight time", args: [at("2026-10-17T05:26:06Z"), "America/New_York"] },
    { fn: "displayTime", name: "in New York, standard time", args: [at("2026-11-17T05:26:06Z"), "America/New_York"] },
    { fn: "displayTime", name: "in UTC", args: [at("2026-10-17T05:26:06Z"), "UTC"] },
    { fn: "displayTime", name: "nothing to show", args: [null, "Asia/Singapore"] },
    { fn: "displayTimeShort", name: "short, in Singapore", args: [at("2026-10-17T05:26:06Z"), "Asia/Singapore"] },
    // The zones where ICU and tzdata name the zone the SAME way, so the port can be held to them
    // exactly. Every other zone is in testdata/zone-abbreviations.json and cannot be a case here:
    // this is the one function whose output legitimately differs, and no tolerance belongs in a
    // mechanism built on having none. Singapore above was the only row for a year, and it agrees —
    // so the port could have drifted anywhere outside it.
    { fn: "displayTimeShort", name: "short, in New York, standard time", args: [at("2026-01-15T12:00:00Z"), "America/New_York"] },
    { fn: "displayTimeShort", name: "short, in New York, daylight time", args: [at("2026-07-15T12:00:00Z"), "America/New_York"] },
    { fn: "displayTimeShort", name: "short, in UTC", args: [at("2026-01-15T12:00:00Z"), "UTC"] },
    // a 45-minute offset, which is what holds the four-digit +0545 spelling rather than +05
    { fn: "displayTimeShort", name: "short, on a three-quarter-hour offset", args: [at("2026-01-15T12:00:00Z"), "Asia/Kathmandu"] },
    // London in WINTER only: ICU has GMT and lacks BST, so the same zone agrees in January and
    // diverges in July — the July instant is in the table, not here
    { fn: "displayTimeShort", name: "short, in London, where only winter agrees", args: [at("2026-01-15T12:00:00Z"), "Europe/London"] },
    { fn: "displayTimeShort", name: "short, nothing to show", args: [null, "Asia/Singapore"] },
    { fn: "marketTimeToDisplay", name: "moomoo's naive Eastern time", args: ["2026-10-16 15:59:58", "Asia/Singapore"] },
    { fn: "marketTimeToDisplay", name: "with a fraction", args: ["2026-10-16 15:59:58.125", "Asia/Singapore"] },
    { fn: "marketTimeToDisplay", name: "the hour that happens twice", args: ["2026-11-01 01:30:00", "UTC"] },
    { fn: "marketTimeToDisplay", name: "non-ASCII digits are not a market time", args: ["\u0662\u0660\u0662\u0666-10-16 15:59:58", "UTC"] },
    { fn: "marketTimeToDisplay", name: "not a time comes back untouched", args: ["N/A", "Asia/Singapore"] },
    { fn: "marketTimeToDisplay", name: "an impossible time comes back untouched", args: ["2026-13-45 99:99:99", "UTC"] },
    // a value that already carries an offset is NOT a naive market time, so the pattern declines it
    // and it comes back whole. That is what makes a second conversion a no-op, and it was worth
    // casing because the comment on `displayRecords` claimed the opposite for months (ADR 0017).
    { fn: "marketTimeToDisplay", name: "an already-converted value comes back untouched",
      args: ["2026-08-10 08:15:00+08:00", "Asia/Singapore"] },
  ],
  quote: [
    // --- stamping a batch for display, and judging one at creation (ADR 0017) ---
    // moomoo's update_time arrives naive US-Eastern and means LAST TRADE; fetched_at is freshness
    { fn: "displayRecords", name: "the last trade is converted and the fetch is stamped",
      args: [[{ code: "US.SPXW261120C7100000", mid_price: 5.1, update_time: "2026-11-19 09:47:23" }],
             "Asia/Singapore", new Date("2026-11-19T13:47:30Z")] },
    { fn: "displayRecords", name: "a record with no last trade is still stamped",
      args: [[{ code: "US.SPXW261120C7100000", mid_price: 5.1 }], "Asia/Singapore",
             new Date("2026-11-19T13:47:30Z")] },
    { fn: "displayRecords", name: "several records, keyed by code",
      args: [[{ code: "A", mid_price: 1 }, { code: "B", mid_price: 2 }], "America/New_York",
             new Date("2026-11-19T13:47:30Z")] },
    // the sweep has never fetched: a null instant must not become "now" or an invalid date
    { fn: "displayRecords", name: "no fetch time at all",
      args: [[{ code: "A", mid_price: 1 }], "Asia/Singapore", null] },
    { fn: "displayRecords", name: "nothing came back", args: [[], "Asia/Singapore", new Date("2026-11-19T13:47:30Z")] },

    { fn: "verifyVerdict", name: "every code priced, so nothing is wrong",
      args: [["A", "B"], { records: [{ code: "A" }, { code: "B" }], unknown: [] }] },
    { fn: "verifyVerdict", name: "a code the provider does not know",
      args: [["A", "B"], { records: [{ code: "A" }], unknown: ["B"] }] },
    { fn: "verifyVerdict", name: "two unknown codes, named in the order asked",
      args: [["A", "B"], { records: [], unknown: ["A", "B"] }] },
    // a code that is neither priced NOR named unknown: the provider contradicted itself, and a
    // gate this strict takes the pessimistic reading
    { fn: "verifyVerdict", name: "silently missing counts as not existing",
      args: [["A", "B"], { records: [{ code: "A" }], unknown: [] }] },
    { fn: "verifyVerdict", name: "unknown wins over missing when both apply",
      args: [["A", "B"], { records: [], unknown: ["B"] }] },
    { fn: "verifyVerdict", name: "nothing asked for is nothing wrong",
      args: [[], { records: [], unknown: [] }] },

    { fn: "round4", name: "four places", args: [1.23456] },
    { fn: "round4", name: "a decimal half that is not one in binary", args: [1.00005] },
    { fn: "round4", name: "2.675", args: [2.675] },
    { fn: "round4", name: "negative", args: [-0.12345] },
    { fn: "round4", name: "float noise", args: [0.1 + 0.2] },
    // exactly half in binary, the only place toFixed (ties up) and Python's round (ties even) part
    { fn: "round4", name: "an exact binary half rounds up", args: [0.03125] },
    { fn: "round4", name: "an exact binary half, negative, rounds away from zero", args: [-0.03125] },

    // --- a probe that THREW, which is not the same refusal as one that answered (ADR 0018) ---
    { fn: "unverifiableVerdict", name: "a dropped connection speaks in errno",
      args: ["snapshot API failed: connect ECONNREFUSED 127.0.0.1:11111"] },
    // the gateway is UP and has declined the security; the old wording called this an outage
    { fn: "unverifiableVerdict", name: "a Provider that answered and declined the security",
      args: ["snapshot API failed: US stock indices are not supported"] },
    { fn: "unverifiableVerdict", name: "a Provider that said nothing at all", args: [""] },
  ],
  reference: [
    // --- which field is true, measured against the live gateway on 2026-11-02 (ADR 0018) ---
    // The scale's three cases went with the column (ADR 0019): a scaled stand-in is a simulation
    // rather than a reading, and `round4` is still exercised by the float-noise case below.
    // SPY's last trade was a session old while its own book was current: 755.72 against 758.73
    { fn: "referenceFigure", name: "the mid leads, because the last trade can be a session old",
      args: [spy] },
    { fn: "referenceFigure", name: "no two-sided quote falls back to the last trade",
      args: [{ ...spy, mid_price: undefined }] },
    // an empty book quotes 0/0 and `(0 + 0) / 2` is a mid, and 0 prints as a price
    { fn: "referenceFigure", name: "a zero mid is not a price, so the last trade is read",
      args: [{ ...spy, bid_price: 0, ask_price: 0, mid_price: 0 }] },
    { fn: "referenceFigure", name: "neither field arrived, so there is no figure",
      args: [{ code: "US.SPY", name: "SPDR S&P 500 ETF Trust" }] },
    { fn: "referenceFigure", name: "no quote at all — a Reference the batch could not price",
      args: [null] },
    // moomoo is a wire format with no published schema, so a field can arrive as a string
    { fn: "referenceFigure", name: "a figure that is not a number", args: [{ mid_price: "758.73" }] },
    { fn: "referenceFigure", name: "an infinite figure", args: [{ mid_price: Infinity }] },
    { fn: "referenceFigure", name: "a negative figure is not a price", args: [{ mid_price: -1, last_price: 2 }] },
    { fn: "referenceFigure", name: "float noise never reaches the page", args: [{ mid_price: 20.15 }] },
    { fn: "referenceFigure", name: "the change is a fraction of the close",
      args: [{ mid_price: 758.73, prev_close_price: 755.72 }] },
    { fn: "referenceFigure", name: "a day down", args: [{ mid_price: 750, prev_close_price: 755.72 }] },
    { fn: "referenceFigure", name: "no close is no change, not a change from nothing",
      args: [{ mid_price: 758.73 }] },
    { fn: "referenceFigure", name: "a zero close would be divided by", args: [{ mid_price: 758.73, prev_close_price: 0 }] },
    // the change is measured from the field the figure came from: a mid against the close beside a
    // last-trade figure is a pair of numbers that cannot both be true
    { fn: "referenceFigure", name: "the fallback's change is the last trade against the close",
      args: [{ last_price: 750, prev_close_price: 755.72 }] },
    // the only shape where the two fields disagree about which is true: a mid that is PRESENT and
    // is not a price. A change computed from it reads -100% beside a figure that moved a point.
    { fn: "referenceFigure", name: "a present-but-zero mid is ignored on both sides at once",
      args: [{ mid_price: 0, last_price: 750, prev_close_price: 755.72 }] },
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
    // one named contract held, one held by nobody: the single leg's value is not an answer to
    // "what would this cost" (2026-10-20). Priced, so the unpriced guard is not what refuses it.
    {
      fn: "costToCloseOf", name: "one named contract is held, the other by nobody",
      args: [[condor], quotes, [SC, code("CALL", 7200)]],
    },
    // and held twice, which was being counted twice rather than refused
    {
      fn: "costToCloseOf", name: "a named contract held twice",
      args: [[condor, putSpread], quotes, [SP]],
    },
    { fn: "contractSize", name: "from the quotes", args: [quotes] },
    { fn: "contractSize", name: "no quotes", args: [{}] },
    { fn: "positionPnl", name: "a condor", args: [condor, quotes] },
    { fn: "positionPnl", name: "a long put's debit", args: [longPut, quotes] },
    { fn: "positionPnl", name: "no entry is no P&L", args: [noEntry, quotes] },
    { fn: "positionPnl", name: "a leg unpriced is no P&L", args: [condor, missingShortPut] },
    { fn: "realizedPoints", name: "a condor closed for less than it took in", args: [condor, 0.4] },
    { fn: "realizedPoints", name: "closed for more than it took in", args: [condor, 9.75] },
    { fn: "realizedPoints", name: "expired worth nothing", args: [condor, 0] },
    { fn: "realizedPoints", name: "no exit is no result", args: [condor, null] },
    { fn: "realizedPoints", name: "no entry is no result", args: [noEntry, 0.4] },
    // Exit is signed like Cost to close: selling a long PAYS you, so its Exit is negative
    { fn: "realizedPoints", name: "a long put sold for more than it cost", args: [longPut, -7.0] },
    { fn: "realizedPoints", name: "a long put sold for less than it cost", args: [longPut, -3.0] },
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
    // the adjacent spread: one leg shared with a held spread, one strike nobody holds. Counting
    // legs made this "all" and put the held spread's entry, P&L and schedule on its row
    // (2026-10-20). No case here exercised the scope decision's shape, only its arithmetic.
    {
      fn: "positionsHolding", name: "one leg shared, one strike unheld",
      args: [[callSpread], [LC, code("CALL", 7200)]],
    },
    // and the other side of the same question: naming MORE than is held still covers what is
    // held, because every held leg is watched
    {
      fn: "positionsHolding", name: "more named than is held",
      args: [[callSpread], [SC, LC, code("CALL", 7200)]],
    },
  ],
  flapping: [
    // A provider that keeps dropping and recovering, which no consecutive count can see. Written
    // after an hour of exactly that went unnoticed on 2026-11-08 (domain/flapping.ts).
    { fn: "flappingVerdict", name: "nothing has failed",
      args: [flapState([]), flapPolicy, NOW] },
    { fn: "flappingVerdict", name: "below the threshold, however spread out",
      args: [flapState([60, 200, 400, 800]), flapPolicy, NOW] },
    { fn: "flappingVerdict", name: "at the threshold, which is where it speaks",
      args: [flapState([60, 200, 400, 600, 800]), flapPolicy, NOW] },
    { fn: "flappingVerdict", name: "older than the window, so not news",
      args: [flapState([901, 1200, 2000, 3000, 4000]), flapPolicy, NOW] },
    { fn: "flappingVerdict", name: "exactly at the window's edge counts",
      args: [flapState([900, 100, 200, 300, 400]), flapPolicy, NOW] },
    // the measured shape: a failure roughly every 90 seconds while the agent churned
    { fn: "flappingVerdict", name: "the outage it was written for",
      args: [flapState([90, 180, 270, 360, 450, 540, 630, 720, 810, 900]), flapPolicy, NOW] },
    // and it never speaks over the sustained notice
    { fn: "flappingVerdict", name: "quiet while a sustained outage is already announced",
      args: [{ ...flapState([60, 120, 180, 240, 300]), announced: true }, flapPolicy, NOW] },
    { fn: "flappingVerdict", name: "repeats once the cadence has passed",
      args: [{ ...flapState([60, 120, 180, 240, 300, 360]), lastNoticeAt: flapAgo(1801) },
        flapPolicy, NOW] },
    { fn: "flappingVerdict", name: "and says nothing before it has",
      args: [{ ...flapState([60, 120, 180, 240, 300, 360]), lastNoticeAt: flapAgo(1799) },
        flapPolicy, NOW] },
    { fn: "flappingVerdict", name: "a zero cadence never reminds",
      args: [{ ...flapState([60, 120, 180, 240, 300, 360]), lastNoticeAt: flapAgo(99999) },
        flapNoRepeat, NOW] },
    { fn: "flappingVerdict", name: "a zero threshold is off",
      args: [flapState([10, 20, 30, 40, 50, 60]), flapOff, NOW] },
    { fn: "flappingVerdict", name: "a window said in hours and minutes",
      args: [flapState([10, 20]), flapWide, NOW] },
  ],
  degraded: [
    // What the owner is told when the service cannot see the market, and how often. The reminder
    // exists because on 2026-11-08 OpenD exited, 646 sweeps failed over 2h42m, and the only
    // message arrived in the first minute (domain/degraded.ts).
    // below, at, and past the threshold
    { fn: "degradedVerdict", name: "under the threshold says nothing",
      args: [degradedState(4, null, null), degradedPolicy_, "the Provider did not answer", NOW] },
    { fn: "degradedVerdict", name: "exactly at the threshold speaks",
      args: [degradedState(5, null, null), degradedPolicy_, "the Provider did not answer", NOW] },
    { fn: "degradedVerdict", name: "the reason is the caller's, naming no vendor",
      args: [degradedState(5, null, null), degradedPolicy_, "a sweep stuck for 90s", NOW] },

    // the reminder, measured from the last notice rather than the first failure
    { fn: "degradedVerdict", name: "repeats once the cadence has passed, with how long",
      args: [degradedState(646, degradedAgo(9720), degradedAgo(1801)), degradedPolicy_,
        "the Provider did not answer", NOW] },
    { fn: "degradedVerdict", name: "and says nothing before it has",
      args: [degradedState(400, degradedAgo(9720), degradedAgo(1799)), degradedPolicy_,
        "the Provider did not answer", NOW] },
    { fn: "degradedVerdict", name: "a zero cadence never reminds",
      args: [degradedState(646, degradedAgo(9720), degradedAgo(99999)), degradedNoRepeat,
        "the Provider did not answer", NOW] },
    { fn: "degradedVerdict", name: "past the threshold with nothing sent says the FIRST wording",
      args: [degradedState(646, degradedAgo(9720), null), degradedPolicy_,
        "the Provider did not answer", NOW] },

    // how long it has been broken
    { fn: "degradedVerdict", name: "minutes under an hour",
      args: [degradedState(50, degradedAgo(420), degradedAgo(1801)), degradedPolicy_, "x", NOW] },
    { fn: "degradedVerdict", name: "hours and minutes above one",
      args: [degradedState(50, degradedAgo(11100), degradedAgo(1801)), degradedPolicy_, "x", NOW] },
    { fn: "degradedVerdict", name: "under a minute is said in words",
      args: [degradedState(50, degradedAgo(30), degradedAgo(1801)), degradedPolicy_, "x", NOW] },
    { fn: "degradedVerdict", name: "an unknown start omits the duration",
      args: [degradedState(646, null, degradedAgo(1801)), degradedPolicy_, "x", NOW] },

    // and coming back
    { fn: "recoveredNotice", name: "says how long it was out",
      args: [degradedState(646, degradedAgo(9720), degradedAgo(60)), degradedPolicy_, NOW] },
    { fn: "recoveredNotice", name: "stays quiet when nothing was ever announced",
      args: [degradedState(4, degradedAgo(60), null), degradedPolicy_, NOW] },
    { fn: "recoveredNotice", name: "an unknown start omits the duration",
      args: [degradedState(646, null, degradedAgo(60)), degradedPolicy_, NOW] },
  ],
  alarm: [
    // the four transitions, each with the sentence it sends
    { fn: "alarmTransition", name: "a first breach crosses and says so",
      args: [single, 0.42, "1120_7100", state(false, null), alarms, NOW] },
    { fn: "alarmTransition", name: "falling below fell rather than crossed",
      args: [falling, 0.21, "1120_7100", state(false, null), alarms, NOW] },
    { fn: "alarmTransition", name: "coming back is the other word again",
      args: [single, 0.12, "1120_7100", state(true, ago(4000)), alarms, NOW] },
    { fn: "alarmTransition", name: "coming back above, for a falling rule",
      args: [falling, 0.44, "1120_7100", state(true, ago(4000)), alarms, NOW] },

    // the flag moves whether or not the owner hears about it
    { fn: "alarmTransition", name: "inside the cooldown the flag is written and nothing is said",
      args: [single, 0.42, "1120_7100", state(false, ago(10)), alarms, NOW] },
    { fn: "alarmTransition", name: "exactly at the cooldown is no longer inside it",
      args: [single, 0.42, "1120_7100", state(false, ago(900)), alarms, NOW] },

    // a breach that persists
    { fn: "alarmTransition", name: "a persisting breach re-reminds once the cadence has passed",
      args: [single, 0.42, "1120_7100", state(true, ago(3601)), alarms, NOW] },
    { fn: "alarmTransition", name: "and says nothing before it has",
      args: [single, 0.42, "1120_7100", state(true, ago(3599)), alarms, NOW] },
    { fn: "alarmTransition", name: "a zero cadence never reminds",
      args: [single, 0.42, "1120_7100", state(true, ago(999999)), noRepeat, NOW] },
    { fn: "alarmTransition", name: "an unbreached rule that was not triggered says nothing at all",
      args: [single, 0.12, "1120_7100", state(false, ago(10)), alarms, NOW] },

    // never alarmed is long ago, not never: the first breach the cooldown swallowed leaves a flag
    // and no stamp, and reading that as "too soon" would silence the rule for ever
    { fn: "alarmTransition", name: "never alarmed counts as long ago",
      args: [single, 0.42, "1120_7100", state(true, null), alarms, NOW] },

    // the figure is three decimals, which is the one place toFixed is exercised by a case
    { fn: "alarmTransition", name: "the figure is three decimals, rounded as JavaScript rounds",
      args: [single, 0.3125, "1120_7100", state(false, null), alarms, NOW] },
    // 0.0625 is an EXACT binary half at the third decimal, so the two languages part company
    // inside the sentence: toFixed gives 0.063 and Python's round gives 0.062. The only case in
    // this file where the notice itself carries a rounding divergence.
    { fn: "alarmTransition", name: "an exact binary half in the figure rounds away from zero",
      args: [falling, 0.0625, "1120_7100", state(false, null), alarms, NOW] },

    // exactly at the threshold is breached: the bell flips at the threshold, no hysteresis
    { fn: "alarmTransition", name: "exactly at the threshold is a breach",
      args: [single, 0.3, "1120_7100", state(false, null), alarms, NOW] },

    // A NEGATIVE reading under `compare: "abs"`, which every case above missed — the ordinary
    // shape of a short put's delta. The comparison is mirrored so the sentence is true of the
    // figure it prints; printing the magnitude instead would have broken the older requirement
    // that the number match the dashboard (review 2026-11-01).
    { fn: "alarmTransition", name: "a negative reading breaches below the negated threshold",
      args: [single, -0.42, "1120_P6500", state(false, null), alarms, NOW] },
    { fn: "alarmTransition", name: "and reminds in the same words",
      args: [single, -0.42, "1120_P6500", state(true, ago(3601)), alarms, NOW] },
    { fn: "alarmTransition", name: "and recovers back ABOVE the negated threshold",
      args: [single, -0.12, "1120_P6500", state(true, ago(3601)), alarms, NOW] },
    // the mirror runs the other way for a below-rule: "alarm when the magnitude has decayed"
    { fn: "alarmTransition", name: "a decayed magnitude reads true under a below-rule",
      args: [{ ...single, threshold: 0.05, direction: "below" }, -0.03, "1120_P6500",
             state(false, null), alarms, NOW] },
    // exactly zero is NOT mirrored. Both wordings are arithmetically true there — 0 ≤ 0.05 and
    // 0 ≥ -0.05 — so nothing but a case can say which one is printed, and the unmirrored reading is
    // the one that reads naturally. `-0 < 0` is false, so a negative zero lands here too.
    { fn: "alarmTransition", name: "a reading of exactly zero is not mirrored",
      args: [{ ...single, threshold: 0.05, direction: "below" }, 0, "1120_P6500",
             state(false, null), alarms, NOW] },
    // an INTEGER threshold, which `mid_price >= 5` is: JavaScript writes 5 and Python's float
    // writes 5.0, a divergence in the one string ADR 0017 exists to compare exactly. Every case
    // above used 0.3 (review 2026-11-01).
    { fn: "alarmTransition", name: "an integer threshold is written without a trailing zero",
      args: [{ ...single, field: "mid_price", threshold: 5 }, 6.5, "1120_IC",
             state(false, null), alarms, NOW] },
    { fn: "alarmTransition", name: "and a negated integer threshold likewise",
      args: [{ ...single, field: "mid_price", threshold: 5 }, -6.5, "1120_IC",
             state(false, null), alarms, NOW] },
    // signed is untouched: a negative threshold is legal there and the sign is the point
    { fn: "alarmTransition", name: "a signed rule is left exactly as it was",
      args: [{ ...single, threshold: -0.1, direction: "below", compare: "signed" }, -0.42,
             "1120_P6500", state(false, null), alarms, NOW] },
  ],
  /** JavaScript's own rules, which the Python reimplements by hand (ADR 0017).
   *
   *  Every one of these was a docstring claim until now. The five that were measured to diverge on
   *  2026-11-01 are marked; the rest are here because a port that gets `Number("")` wrong would be
   *  wrong everywhere a quote field is empty, and nothing said so.
   */
  js: [
    // Math.round ties toward +Infinity; Python's round ties to even
    { fn: "mathRound", name: "a half rounds up", args: [12.5] },
    { fn: "mathRound", name: "a negative half rounds toward zero, not away", args: [-2.5] },
    { fn: "mathRound", name: "minus a half is negative zero", args: [-0.5] },
    { fn: "mathRound", name: "the largest double below a half rounds down", args: [0.49999999999999994] },
    { fn: "mathRound", name: "NaN stays NaN", args: [NaN] },
    { fn: "mathRound", name: "Infinity stays Infinity", args: [Infinity] },

    // toFixed rounds the EXACT binary value and ties away from zero
    { fn: "toFixed", name: "an exact binary half goes away from zero", args: [0.03125, 4] },
    { fn: "toFixed", name: "a decimal half is below its own value in binary", args: [1.0005, 3] },
    { fn: "toFixed", name: "three decimals of an exact binary half", args: [0.0625, 3] },
    { fn: "toFixed", name: "a negative exact half", args: [-0.03125, 4] },
    { fn: "toFixed", name: "no decimals at all", args: [2.5, 0] },
    { fn: "toFixed", name: "NaN survives", args: [NaN, 2] },
    // ten decimals of a large double: `quantize` raised past the default context precision, which
    // the >= 1e21 guard covered only while digits <= 7 — true of every call site in the package,
    // so it was correct because its callers were disciplined (review 2026-11-01)
    { fn: "toFixed", name: "ten decimals of a very large value", args: [1e18, 10] },
    { fn: "toFixed", name: "eight decimals at the edge of the guard", args: [1e20, 8] },
    { fn: "toFixed", name: "above the guard it is returned whole", args: [1e21, 2] },
    { fn: "toFixed", name: "a digit count below zero is refused", args: [1.5, -1] },
    { fn: "toFixed", name: "and one above a hundred", args: [1.5, 101] },

    // Number() on what a quote field can hold
    { fn: "number", name: "the empty string is zero, not an error", args: [""] },
    { fn: "number", name: "whitespace is trimmed", args: ["  12.5  "] },
    { fn: "number", name: "a tab and a newline are whitespace too", args: ["\t-3\n"] },
    { fn: "number", name: "null is zero", args: [null] },           // DIVERGED: the port said NaN
    { fn: "number", name: "a bool is one or zero", args: [true] },
    { fn: "number", name: "a hex literal", args: ["0x10"] },        // DIVERGED: the port said NaN
    { fn: "number", name: "a binary literal", args: ["0b101"] },
    { fn: "number", name: "an octal literal", args: ["0o17"] },
    { fn: "number", name: "an exponent", args: ["1.5e3"] },
    { fn: "number", name: "a leading plus", args: ["+7"] },
    { fn: "number", name: "the word Infinity", args: ["Infinity"] },
    { fn: "number", name: "and negative Infinity", args: ["-Infinity"] },
    { fn: "number", name: "trailing rubbish is not a number", args: ["12abc"] },
    { fn: "number", name: "an empty array is zero", args: [[]] },   // DIVERGED: the port said NaN
    { fn: "number", name: "a one-element array is that element", args: [[5]] },
    { fn: "number", name: "a longer array is not a number", args: [[1, 2]] },
    { fn: "number", name: "an object is not a number", args: [{}] },
    { fn: "number", name: "a signed hex literal is not a number", args: ["-0x10"] },
    // the four the port got wrong, each measured against real JavaScript (review 2026-11-01)
    { fn: "number", name: "a nested array is its own join, so one element deep is that element",
      args: [[[5]]] },
    { fn: "number", name: "and an empty nested array is zero", args: [[[]]] },
    { fn: "number", name: "a nested array of two is not a number", args: [[1, [2]]] },
    // \d matches every Unicode decimal digit, and Python's float() accepts them
    { fn: "number", name: "an Arabic-Indic digit is not a number", args: ["\u0661\u0662\u0663"] },
    // int() tolerates separators, a sign and inner whitespace; StringNumericLiteral does not
    { fn: "number", name: "a hex literal with a separator is not a number", args: ["0x1_0"] },
    { fn: "number", name: "a hex literal with an inner sign is not a number", args: ["0x+10"] },
    { fn: "number", name: "a binary literal with a separator is not a number", args: ["0b1_1"] },

    // truthiness
    { fn: "truthy", name: "zero is falsy", args: [0] },
    { fn: "truthy", name: "the string zero is not", args: ["0"] },
    { fn: "truthy", name: "the empty string is falsy", args: [""] },
    { fn: "truthy", name: "null is falsy", args: [null] },
    { fn: "truthy", name: "NaN is falsy", args: [NaN] },
    { fn: "truthy", name: "an empty array is TRUTHY", args: [[]] },  // DIVERGED: the port said false
    { fn: "truthy", name: "an empty object is truthy too", args: [{}] },
    { fn: "truthy", name: "a negative number is truthy", args: [-1] },
  ],
  /** What the sweep decides about a rule it cannot evaluate, and one that has expired (ADR 0017). */
  lifecycle: [
    // the reason a figure did not arrive, in the words the notice uses
    { fn: "silenceReason", name: "a leg with no quote at all", args: [combo, new Set([SP, SC, LC])] },
    { fn: "silenceReason", name: "two legs missing, named in sorted order",
      args: [combo, new Set([SC, LC])] },
    // the put is EARLIER in the combo's legs and LATER in sorted order, so this is the case that
    // tells the two apart — a sweep's notice must not depend on how the structure was entered
    { fn: "silenceReason", name: "sorted, not in the order the legs were entered",
      args: [combo, new Set([SP, LC])] },
    { fn: "silenceReason", name: "every leg priced, so the field itself is missing",
      args: [combo, new Set([LP, SP, SC, LC])] },
    { fn: "silenceReason", name: "a single contract with no quote", args: [single, new Set()] },

    // the run of silence, and where it ends
    { fn: "silenceVerdict", name: "a first silent sweep only counts",
      args: [single, new Set(), 0, 3] },
    { fn: "silenceVerdict", name: "one short of the limit still only counts",
      args: [single, new Set(), 1, 3] },
    { fn: "silenceVerdict", name: "reaching the limit quarantines and says so",
      args: [single, new Set(), 2, 3] },
    { fn: "silenceVerdict", name: "a limit of one quarantines on the first sweep",
      args: [single, new Set(), 0, 1] },
    // 0 only logs: quarantine is OBSERVED, never declared, and what a provider serves depends on
    // the account rather than on its code
    { fn: "silenceVerdict", name: "a limit of zero never quarantines, however long the run",
      args: [single, new Set(), 99, 0] },
    { fn: "silenceVerdict", name: "the count is forgotten rather than held at the limit",
      args: [single, new Set(), 5, 3] },

    // what becomes of a monitor whose expiry has passed
    { fn: "expiryVerdict", name: "not expired yet, so nothing happens",
      args: [{ code: "1120_7100", strike_date: "2026-11-20", enabled: true }, "2026-11-19", 7] },
    { fn: "expiryVerdict", name: "expiry day itself is not past",
      args: [{ code: "1120_7100", strike_date: "2026-11-20", enabled: true }, "2026-11-20", 7] },
    { fn: "expiryVerdict", name: "the day after expiry mutes with a notice",
      args: [{ code: "1120_7100", strike_date: "2026-11-20", enabled: true }, "2026-11-21", 7] },
    { fn: "expiryVerdict", name: "already muted, so the mute is not announced twice",
      args: [{ code: "1120_7100", strike_date: "2026-11-20", enabled: false }, "2026-11-21", 7] },
    { fn: "expiryVerdict", name: "past the retention window it is removed, quietly if already muted",
      args: [{ code: "1120_7100", strike_date: "2026-11-20", enabled: false }, "2026-11-28", 7] },
    // retention 0: it never got the muted notice, so the removal is what says anything at all
    { fn: "expiryVerdict", name: "zero retention removes the day after, and says so",
      args: [{ code: "1120_7100", strike_date: "2026-11-20", enabled: true }, "2026-11-21", 0] },
    { fn: "expiryVerdict", name: "the retention boundary itself is not past",
      args: [{ code: "1120_7100", strike_date: "2026-11-20", enabled: false }, "2026-11-27", 7] },

    // the other two faults a sweep quarantines for. `silenceVerdict` above counts sweeps because a
    // figure may yet arrive; these two are facts already stated, so one sweep settles them.
    { fn: "unreadableNotice", name: "a row that cannot be hydrated at all", args: ["1120_IC"] },

    { fn: "unknownContractVerdict", name: "a single contract the provider does not carry",
      args: [single, new Set([SC])] },
    { fn: "unknownContractVerdict", name: "nothing unknown, so the rule stands",
      args: [single, new Set([LP])] },
    { fn: "unknownContractVerdict", name: "one delisted leg takes the whole combo",
      args: [combo, new Set([SP])] },
    // the put is EARLIER in the combo's legs and LATER in sorted order, the case that tells the two
    // apart: a notice must not depend on how the structure was entered (silenceReason's rule)
    { fn: "unknownContractVerdict", name: "named in sorted order, not the order entered",
      args: [combo, new Set([SP, LC])] },
    { fn: "unknownContractVerdict", name: "every leg gone", args: [combo, new Set([LP, SP, SC, LC])] },
    // an unknown set naming codes this rule does not watch says nothing about this rule: the batch
    // is the whole watchlist's, so most of what it refuses belongs to somebody else
    { fn: "unknownContractVerdict", name: "another rule's unknown contract is not this rule's fault",
      args: [single, new Set([LP, SP, LC])] },

    { fn: "addDays", name: "across a month end", args: ["2026-11-28", 7] },
    { fn: "addDays", name: "backwards across a month end", args: ["2026-12-03", -7] },
    { fn: "addDays", name: "across a leap day", args: ["2028-02-28", 2] },
  ],
  monitor: [
    { fn: "monitorLegCodes", name: "a combo", args: [combo] },
    { fn: "monitorLegCodes", name: "a single contract", args: [single] },
    { fn: "comboFieldError", name: "IV is never summed", args: ["option_implied_volatility"] },
    { fn: "comboFieldError", name: "mid is", args: ["mid_price"] },
    { fn: "comboFieldSum", name: "a condor's mids", args: [combo, quotes, "mid_price"] },
    { fn: "comboFieldSum", name: "no partial sums", args: [combo, missingShortPut, "mid_price"] },
    // a row that predates the rule, where every leg reports an IV: the condor's signs cancel to 0,
    // which is a figure, and the guard answers no figure at all. The library's port had no guard and
    // answered 0 for this, held by no case until the backend's watchlist port asked (2026-11-09)
    { fn: "comboFieldSum", name: "never an implied volatility, whatever the legs report",
      args: [combo, quotes, "option_implied_volatility"] },
    { fn: "monitorValue", name: "a single contract", args: [single, quotes] },
    { fn: "monitorValue", name: "a combo", args: [combo, quotes] },
    { fn: "monitorValue", name: "unpriced", args: [single, {}] },
    { fn: "thresholdFill", name: "halfway above", args: [0.15, 0.3, "above", "abs"] },
    // a garbage quote field makes monitorValue NaN (js.number), and a NaN fill reached the bar's
    // width as "NaN%" here and a ValueError there. No figure is the answer both can give.
    { fn: "thresholdFill", name: "a NaN reading is no figure, not a fill",
      args: [NaN, 0.3, "above", "abs"] },
    { fn: "thresholdFill", name: "a NaN threshold is no figure either",
      args: [1, NaN, "above", "abs"] },
    // a denormal threshold divides to infinity, which still clamps as it always did
    { fn: "thresholdFill", name: "a threshold too small to divide by clamps full",
      args: [1, 5e-324, "above", "signed"] },
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
    // the OPTIONAL argument left off, which no case did until now: a default is only compared
    // where a case omits it, and `costToClose` defaults to null — the figure a holding has before
    // its first sweep
    { fn: "exitLevels", name: "no cost to close yet, so the argument is left off",
      args: [3, 45, 30, policy] },
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
