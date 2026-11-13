/** Combos that only PARTLY overlap a holding (#346), in the shapes the owner's book has had them:
 *
 *  - the live case: the holding `1231_8050` (−C8050 +C8100) with its own value rule `1231_8050`,
 *    which covers exactly its contracts, a delta rule on its short leg, and the combo `1231_8100`
 *    (−C8100 +C8150), linked to it with scope `leg` because C8100 is one of its contracts. A delta
 *    rule on C8150, which nothing holds, is a leg of that combo alone;
 *  - #344's case: a lone held call, `1231_7700`, with its own mid rule, and a watched call spread
 *    `1231_C7700` (−C7700 +C7750) the service links to it with scope `all`, since the spread
 *    contains every contract the holding has;
 *  - a WING of a held condor: `1231_IC` held as one 4-leg holding, and a rule on its call side
 *    `1231_C7400` (−C7400 +C7450), linked with scope `leg`. Every contract it names is held, so it
 *    watches risk on something held and STAYS under the holding, with the wing's own cost to close;
 *  - a RATIO over a 1×1 holding: `1231_7200` (+C7200 −C7250) and a rule `1231_R7200` on
 *    +C7200 −C7250 −C7250, linked with scope `all`. Its second C7250 is held by nobody, so it moves.
 *
 *  Plain data, as `ownerBook.ts` is, and served beside nothing else: the model's tests, the jsdom
 *  suites and the browser suites all read these same rows.
 */
import type { Entry, Holding, Monitor } from "../shared/api";
import { call, entry, holding, monitor, served, side } from "./ownerBook";

const DATE = "2026-12-31";
const code = (strike: number) => `US.SPXW261231C${strike}000`;

export const OVERLAP_HOLDINGS: Holding[] = [
  holding("h-8050", { name: "1231_8050", strike_date: DATE,
    legs: [side("short", "CALL", 8050), side("long", "CALL", 8100)],
    short_strikes: [served(DATE, "CALL", 8050, 0.04, 38)] }),
  holding("h-7700", { name: "1231_7700", strike_date: DATE, legs: [side("short", "CALL", 7700)],
    short_strikes: [served(DATE, "CALL", 7700, 0.09, 38)] }),
  holding("h-ic", { name: "1231_IC", strike_date: DATE,
    legs: [side("short", "CALL", 7400), side("long", "CALL", 7450),
           side("short", "PUT", 6300), side("long", "PUT", 6250)],
    short_strikes: [served(DATE, "CALL", 7400, 0.12, 38), served(DATE, "PUT", 6300, -0.25, 38)] }),
  holding("h-7200", { name: "1231_7200", strike_date: DATE,
    legs: [side("long", "CALL", 7200), side("short", "CALL", 7250)],
    short_strikes: [served(DATE, "CALL", 7250, 0.2, 38)] }),
];

const to8050 = [{ id: "h-8050", name: "1231_8050" }];
const to7700 = [{ id: "h-7700", name: "1231_7700" }];
const toIc = [{ id: "h-ic", name: "1231_IC" }];
const to7200 = [{ id: "h-7200", name: "1231_7200" }];

export const OVERLAP_QUOTES: Entry[] = [
  // the holding's own value rule: exactly its two contracts
  entry("r-8050", { code: "1231_8050", strike_date: DATE, legs: call(8050, 8100), held: true,
    scope: "all", positions: to8050, cost_to_close: 1.2, combo_value: -1.2, watched: -1.2,
    short_strikes: [served(DATE, "CALL", 8050, 0.04, 38)] }),
  // a single contract on its short leg: stays under it, as every single-contract rule does
  entry("r-8050-delta", { code: code(8050), strike_date: DATE, option_type: "CALL",
    field: "option_delta", threshold: 0.2, watched: 0.04, distance: 0.16, held: true, scope: "leg",
    positions: to8050, in_combos: ["r-8050"], quote: { name: "SPXW 261231 8050.00C", option_delta: 0.04 } }),
  // the live case: one leg held by 1231_8050, the other by nothing
  entry("r-8100", { code: "1231_8100", strike_date: DATE, legs: call(8100, 8150), held: true,
    scope: "leg", positions: to8050, cost_to_close: null, combo_value: -0.6, watched: -0.6,
    short_strikes: [served(DATE, "CALL", 8100, 0.03, 38)] }),
  // a single contract nothing holds, a leg of 1231_8100 alone: under it wherever it is drawn
  entry("w-8150-delta", { code: code(8150), strike_date: DATE, option_type: "CALL",
    field: "option_delta", threshold: 0.1, watched: 0.02, distance: 0.08, in_combos: ["r-8100"],
    quote: { name: "SPXW 261231 8150.00C", option_delta: 0.02 } }),
  // #344's case: the lone held call, and a watched spread containing it
  entry("r-7700", { code: code(7700), strike_date: DATE, option_type: "CALL", field: "mid_price",
    threshold: 9, watched: 4.5, distance: 4.5, held: true, scope: "all", positions: to7700,
    in_combos: ["w-7700"], quote: { name: "SPXW 261231 7700.00C", mid_price: 4.5 } }),
  entry("w-7700", { code: "1231_C7700", strike_date: DATE, legs: call(7700, 7750), held: true,
    scope: "all", positions: to7700, cost_to_close: null, entry: 2, pnl: -250, combo_value: -1.5,
    watched: -1.5, short_strikes: [served(DATE, "CALL", 7700, 0.09, 38)] }),
  // a wing of the held condor: every contract it names is held, so it stays, at the wing's own
  // cost to close (`costToCloseOf` over the two contracts it names), not its signed value
  entry("r-ic-calls", { code: "1231_C7400", strike_date: DATE, legs: call(7400, 7450), held: true,
    scope: "leg", positions: toIc, cost_to_close: 1.3, combo_value: -1.25, watched: -1.25,
    short_strikes: [served(DATE, "CALL", 7400, 0.12, 38)] }),
  // a 1×2 ratio over a 1×1 holding: one C7250 more than is held. `costToCloseOf` counts the
  // contracts it names once each, so the service does serve it a cost to close — the 1×1's
  entry("r-ratio", { code: "1231_R7200", strike_date: DATE, held: true, scope: "all", positions: to7200,
    legs: [{ sign: 1, option_type: "CALL", strike: 7200 }, { sign: -1, option_type: "CALL", strike: 7250 },
           { sign: -1, option_type: "CALL", strike: 7250 }],
    cost_to_close: 0.9, combo_value: -0.4, watched: -0.4,
    short_strikes: [served(DATE, "CALL", 7250, 0.2, 38)] }),
];

export const OVERLAP_MONITORS: Monitor[] = OVERLAP_QUOTES.map((q) => monitor(q.id, {
  code: q.code, strike_date: q.strike_date, option_type: q.option_type, field: q.field,
  strike: q.legs ? 0 : Number(/C(\d+)000$/.exec(q.code)![1]),
  legs: (q.legs ?? null) as Monitor["legs"], scope: q.scope, positions: q.positions,
}));
