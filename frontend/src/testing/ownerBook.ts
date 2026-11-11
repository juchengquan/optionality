/** One book shaped like the owner's, for both of the redesign's arrangements (#289, #290): the desk
 *  table and the phone cards are held to the SAME fixture, so neither can group it differently.
 *
 *  - spreads on the watchlist over three expiries, one with its short leg's delta rule under it,
 *    and a single-contract rule that matches no spread;
 *  - a condor held as two spreads on 2026-12-18, and a 4-leg condor held as one on 2026-12-31;
 *  - a fired entry signal, a fired risk rule, and Monitors that are quarantined, muted and expired.
 *
 *  Plain data: a test that wants the page serves it (`serveBook` in `__browser__/nextBook.ts` for
 *  the layout suites), and the model's tests read it directly.
 */
import type { Entry, Holding, Monitor } from "../api";

function entry(id: string, over: Partial<Entry> & { strike_date: string }): Entry {
  return {
    id, code: id, option_type: "CMB", field: "mid_price", threshold: 6, direction: "above",
    compare: "abs", triggered: false, quote: null, dte: 38, scope: null, positions: [],
    cost_to_close: null, entry: null, pnl: null, fill: 40, schedule: null, watched: 2.4,
    distance: 3.6, in_combos: [], held: false, spx: 6900.5, spx_reason: null,
    ...over,
  } as Entry;
}

const put = (short: number, long: number) => [
  { sign: -1, option_type: "PUT", strike: short }, { sign: 1, option_type: "PUT", strike: long },
];
const call = (short: number, long: number) => [
  { sign: -1, option_type: "CALL", strike: short }, { sign: 1, option_type: "CALL", strike: long },
];

export const QUOTES: Entry[] = [
  // the watchlist: three expiries
  entry("w-dec04", { code: "1204_P6900", strike_date: "2026-12-04", legs: put(6900, 6850),
    combo_value: 6.2, watched: 6.2, distance: -0.2, triggered: true, fill: 100 }),
  entry("w-dec18", { code: "1218_P7150", strike_date: "2026-12-18", legs: put(7150, 7100) }),
  entry("w-dec18-delta", {
    code: "US.SPXW261218P7150000", strike_date: "2026-12-18", option_type: "PUT",
    field: "option_delta", threshold: 0.2, watched: -0.17, distance: 0.03, in_combos: ["w-dec18"],
    quote: { name: "SPXW 261218 7150.00P", option_delta: -0.17 },
  }),
  entry("w-dec31", { code: "1231_C7600", strike_date: "2026-12-31", legs: call(7600, 7650) }),
  // a single contract no spread on the watchlist holds: it stands alone
  entry("w-lone", {
    code: "US.SPXW261231C8000000", strike_date: "2026-12-31", option_type: "CALL",
    field: "option_delta", threshold: 0.1, watched: 0.04, distance: 0.06,
    quote: { name: "SPXW 261231 8000.00C", option_delta: 0.04 },
  }),
  // rules on what is held
  entry("r-calls", { code: "1218_C7300", strike_date: "2026-12-18", legs: call(7300, 7350),
    held: true, scope: "all", positions: [{ id: "h-calls", name: "1218_C7300" }],
    threshold: 4, watched: 4.4, distance: -0.4, triggered: true, fill: 100 }),
  entry("r-ic", { code: "1231_IC", strike_date: "2026-12-31", held: true, scope: "all",
    legs: [...call(7400, 7450), ...put(6300, 6250)],
    positions: [{ id: "h-ic", name: "1231_IC" }] }),
];

function holding(id: string, over: Partial<Holding> & { strike_date: string; legs: Holding["legs"] }): Holding {
  return {
    id, name: id, strategy: null, contracts: 1, entry: 2, created_at: null, opened_at: "2026-11-03",
    closed_on: null, exit: null, realized_points: null, cost_to_close: 1, pnl: 100, captured: 0.5,
    contract_size: 100, spx: 6900.5, spx_reason: null, greeks: {}, legs_delta: null, fetched_at: "x",
    dte: 38, schedule: null, ...over,
  } as Holding;
}

const side = (s: "short" | "long", option_type: "CALL" | "PUT", strike: number) =>
  ({ side: s, option_type, strike });

export const HOLDINGS: Holding[] = [
  // a condor held as two spreads, put side first so the pairing does not lean on arrival order
  holding("h-puts", { name: "1218_P6400", strike_date: "2026-12-18",
    legs: [side("short", "PUT", 6400), side("long", "PUT", 6350)],
    // each leg's own delta, as /positions/values serves it (#318); no rule watches either leg
    legs_delta: { "US.SPXW261218P6400000": -0.21, "US.SPXW261218P6350000": -0.15 } }),
  holding("h-calls", { name: "1218_C7300", strike_date: "2026-12-18",
    legs: [side("short", "CALL", 7300), side("long", "CALL", 7350)], cost_to_close: 4.4, pnl: -240,
    legs_delta: { "US.SPXW261218C7300000": 0.33, "US.SPXW261218C7350000": 0.24 } }),
  // a 4-leg condor held as one: one row, never split
  holding("h-ic", { name: "1231_IC", strike_date: "2026-12-31", entry: 5,
    legs: [side("short", "CALL", 7400), side("long", "CALL", 7450),
           side("short", "PUT", 6300), side("long", "PUT", 6250)],
    legs_delta: { "US.SPXW261231C7400000": 0.12, "US.SPXW261231C7450000": 0.08,
                  "US.SPXW261231P6300000": -0.25, "US.SPXW261231P6250000": -0.18 } }),
];

function monitor(id: string, over: Partial<Monitor>): Monitor {
  return {
    id, code: id, strike_date: "2026-12-18", option_type: "CALL", strike: 8000, field: "option_delta",
    threshold: 0.1, direction: "above", compare: "abs", legs: null, enabled: true, scope: null,
    positions: [], disabled_reason: null, triggered: false, last_value: null, last_checked_at: null,
    created_at: null, ...over,
  } as Monitor;
}

/** `/monitors`: every rule, enabled or not. The enabled ones are `QUOTES`; these are the rest. */
export const MONITORS: Monitor[] = [
  ...QUOTES.map((q) => monitor(q.id, { code: q.code, strike_date: q.strike_date })),
  monitor("q-unknown", { code: "US.SPXW261211C8300000", strike_date: "2026-12-11", enabled: false,
    disabled_reason: "unknown-contract" }),
  monitor("m-muted", { code: "US.SPXW261218C7800000", enabled: false, disabled_reason: "manual" }),
  monitor("m-expired", { code: "US.SPXW261106P6000000", strike_date: "2026-11-06", enabled: false,
    disabled_reason: "expired" }),
];
