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
import type { Entry, Holding, Monitor, Payoff } from "../api";

/** SPX's price as the service derives it (ADR 0024), on every row of both responses. */
const SPX = 6900.5;

/** A short strike as the service serves it in `short_strikes` (#297): the distance worked out as
 *  `strikeDistances` does — positive while SPX has not reached it — at an IV of 18%. */
export function served(date: string, type: "CALL" | "PUT", strike: number, delta: number | null, dte: number,
                       spx: number | null = SPX) {
  const points = spx === null ? null : Number((type === "CALL" ? strike - spx : spx - strike).toFixed(2));
  const sigma = points === null || spx === null ? null
    : Number((points / (spx * 0.18 * Math.sqrt(dte / 365))).toFixed(2));
  const code = `US.SPXW${date.slice(2).replaceAll("-", "")}${type[0]}${strike}000`;
  return { code, option_type: type, strike, delta, points, sigma };
}

function entry(id: string, over: Partial<Entry> & { strike_date: string }): Entry {
  return {
    id, code: id, option_type: "CMB", field: "mid_price", threshold: 6, direction: "above",
    compare: "abs", triggered: false, quote: null, dte: 38, scope: null, positions: [],
    cost_to_close: null, entry: null, pnl: null, fill: 40, schedule: null, watched: 2.4,
    distance: 3.6, in_combos: [], held: false, spx: SPX, spx_reason: null, short_strikes: [],
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
    short_strikes: [served("2026-12-04", "PUT", 6900, -0.48, 38)],
    combo_value: 6.2, watched: 6.2, distance: -0.2, triggered: true, fill: 100 }),
  entry("w-dec18", { code: "1218_P7150", strike_date: "2026-12-18", legs: put(7150, 7100),
    // its value signed as the service signs a combo, minus short: a credit spread's is NEGATIVE
    combo_value: -2.4,
    // SPX is already below this short put: a distance past the strike is negative
    short_strikes: [served("2026-12-18", "PUT", 7150, -0.17, 38)] }),
  entry("w-dec18-delta", {
    code: "US.SPXW261218P7150000", strike_date: "2026-12-18", option_type: "PUT",
    field: "option_delta", threshold: 0.2, watched: -0.17, distance: 0.03, in_combos: ["w-dec18"],
    quote: { name: "SPXW 261218 7150.00P", option_delta: -0.17 },
  }),
  entry("w-dec31", { code: "1231_C7600", strike_date: "2026-12-31", legs: call(7600, 7650),
    short_strikes: [served("2026-12-31", "CALL", 7600, 0.06, 38)] }),
  // a single contract no spread on the watchlist holds: it stands alone
  entry("w-lone", {
    code: "US.SPXW261231C8000000", strike_date: "2026-12-31", option_type: "CALL",
    field: "option_delta", threshold: 0.1, watched: 0.04, distance: 0.06,
    quote: { name: "SPXW 261231 8000.00C", option_delta: 0.04 },
  }),
  // rules on what is held
  entry("r-calls", { code: "1218_C7300", strike_date: "2026-12-18", legs: call(7300, 7350),
    held: true, scope: "all", positions: [{ id: "h-calls", name: "1218_C7300" }],
    short_strikes: [served("2026-12-18", "CALL", 7300, 0.33, 38)],
    threshold: 4, watched: 4.4, distance: -0.4, triggered: true, fill: 100 }),
  entry("r-ic", { code: "1231_IC", strike_date: "2026-12-31", held: true, scope: "all",
    legs: [...call(7400, 7450), ...put(6300, 6250)],
    short_strikes: [served("2026-12-31", "CALL", 7400, 0.12, 38), served("2026-12-31", "PUT", 6300, -0.25, 38)],
    positions: [{ id: "h-ic", name: "1231_IC" }] }),
];

function holding(id: string, over: Partial<Holding> & { strike_date: string; legs: Holding["legs"] }): Holding {
  return {
    id, name: id, strategy: null, contracts: 1, entry: 2, created_at: null, opened_at: "2026-11-03",
    closed_on: null, exit: null, realized_points: null, cost_to_close: 1, pnl: 100, captured: 0.5,
    contract_size: 100, spx: SPX, spx_reason: null, greeks: {}, legs_delta: null, short_strikes: [],
    fetched_at: "x", dte: 38, schedule: null, ...over,
  } as Holding;
}

const side = (s: "short" | "long", option_type: "CALL" | "PUT", strike: number) =>
  ({ side: s, option_type, strike });

export const HOLDINGS: Holding[] = [
  // a condor held as two spreads, put side first so the pairing does not lean on arrival order
  holding("h-puts", { name: "1218_P6400", strike_date: "2026-12-18",
    legs: [side("short", "PUT", 6400), side("long", "PUT", 6350)],
    // each leg's own delta, as /positions/values serves it (#318); no rule watches either leg
    legs_delta: { "US.SPXW261218P6400000": -0.21, "US.SPXW261218P6350000": -0.15 },
    short_strikes: [served("2026-12-18", "PUT", 6400, -0.21, 38)] }),
  holding("h-calls", { name: "1218_C7300", strike_date: "2026-12-18",
    legs: [side("short", "CALL", 7300), side("long", "CALL", 7350)], cost_to_close: 4.4, pnl: -240,
    legs_delta: { "US.SPXW261218C7300000": 0.33, "US.SPXW261218C7350000": 0.24 },
    short_strikes: [served("2026-12-18", "CALL", 7300, 0.33, 38)] }),
  // a 4-leg condor held as one: one row, never split
  holding("h-ic", { name: "1231_IC", strike_date: "2026-12-31", entry: 5,
    legs: [side("short", "CALL", 7400), side("long", "CALL", 7450),
           side("short", "PUT", 6300), side("long", "PUT", 6250)],
    legs_delta: { "US.SPXW261231C7400000": 0.12, "US.SPXW261231C7450000": 0.08,
                  "US.SPXW261231P6300000": -0.25, "US.SPXW261231P6250000": -0.18 },
    short_strikes: [served("2026-12-31", "CALL", 7400, 0.12, 38), served("2026-12-31", "PUT", 6300, -0.25, 38)] }),
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

/** `/positions/{id}/payoff` for each holding above, worked by hand from its legs, its Entry and its
 *  count as the service's `payoffAtExpiry` would (#291): points across the contracts. */
export const PAYOFFS: Record<string, Payoff> = {
  "h-puts": {
    at_strikes: [{ spx: 6350, pnl: -48 }, { spx: 6400, pnl: 2 }],
    slope_below: 0, slope_above: 0, breakevens: [6398], max_profit: 2, max_loss: -48,
  },
  "h-calls": {
    at_strikes: [{ spx: 7300, pnl: 2 }, { spx: 7350, pnl: -48 }],
    slope_below: 0, slope_above: 0, breakevens: [7302], max_profit: 2, max_loss: -48,
  },
  "h-ic": {
    at_strikes: [{ spx: 6250, pnl: -45 }, { spx: 6300, pnl: 5 }, { spx: 7400, pnl: 5 }, { spx: 7450, pnl: -45 }],
    slope_below: 0, slope_above: 0, breakevens: [6295, 7405], max_profit: 5, max_loss: -45,
  },
};

/** `POST /positions/payoff` for w-dec18 drawn at its current value: the 7150/7100 put spread sold
 *  for the 2.40 its combo is worth now. */
export const DRAFT_PAYOFF: Payoff = {
  at_strikes: [{ spx: 7100, pnl: -47.6 }, { spx: 7150, pnl: 2.4 }],
  slope_below: 0, slope_above: 0, breakevens: [7147.6], max_profit: 2.4, max_loss: -47.6,
};

/** The two payoff routes as a test service answers them, or null for any other path: a holding's
 *  by its id, and draft legs with `DRAFT_PAYOFF` whatever they are — a test that cares what was
 *  asked reads the request. Both are reads, so a suite that refuses every write still answers them. */
export function payoffAnswer(path: string): Payoff | null {
  if (path === "/positions/payoff") return DRAFT_PAYOFF;
  const m = /^\/positions\/([^/]+)\/payoff$/.exec(path);
  return m ? PAYOFFS[decodeURIComponent(m[1]!)] ?? null : null;
}
