/** The HTTP door's scenarios, as inputs: a world and one request each (ADR 0021).
 *
 *  `coverage.test.ts` holds this list to `/openapi.json`: every status every documented endpoint
 *  can answer has at least one scenario here. Beyond that, a scenario earns its place by a branch
 *  the code takes — the order a refusal is decided in, a call that must NOT be made, a write that
 *  reaches a second table.
 */
import { buildSpxCode } from "optionality/domain/contract";

import type { EarlierRequest, HttpRequest, World } from "../format.ts";
import {
  BOOK, C7300, C7350, C7500, P6350, P6400, EXPIRY, PREMIUM_BOOK, at, chosenInterval, combo, except,
  link, monitor,
  position, quote,
  reference, request, sample, watchDay, world,
} from "./fixtures.ts";

export interface HttpInput {
  name: string;
  world: World;
  /** requests made before the event, for a memory no table holds (ADR 0027) */
  earlier?: EarlierRequest[];
  request: HttpRequest;
}

const DOWN = "connect ECONNREFUSED 127.0.0.1:33333";

/** The book as it stands: the condor held, its short call watched on delta, its call spread
 *  watched as a combo, both rules linked to the holding. */
/** A holding the service cannot read (#422): a side of "sold", which no leg has had since ADR 0013. */
const BROKEN = position({
  id: "pos-9", name: "dec-broken",
  legs: [{ side: "sold", option_type: "CALL", strike: 7500 }, { side: "long", option_type: "CALL", strike: 7550 }],
});

const held = {
  positions: [position({ id: "pos-1" })],
  monitors: [monitor({ id: "mon-1", scope: "leg" }), combo({ id: "mon-2", scope: "calls" })],
  monitor_positions: [link("mon-1", "pos-1"), link("mon-2", "pos-1")],
};

/** The condor held as two spreads, a combo over the whole of it covering both, and a combo over
 *  the call side alone — so the call spread has a rule of its own and the put spread does not. */
const wings = {
  positions: [
    position({
      id: "pos-calls", name: "dec-call-spread", entry: 2.5,
      legs: [
        { side: "short", option_type: "CALL", strike: 7300 },
        { side: "long", option_type: "CALL", strike: 7350 },
      ],
    }),
    position({
      id: "pos-puts", name: "dec-put-spread", entry: null,
      legs: [
        { side: "short", option_type: "PUT", strike: 6400 },
        { side: "long", option_type: "PUT", strike: 6350 },
      ],
    }),
  ],
  monitors: [
    combo({
      id: "mon-condor", code: "dec-condor", scope: "all",
      legs: [
        { sign: -1, option_type: "CALL", strike: 7300 }, { sign: 1, option_type: "CALL", strike: 7350 },
        { sign: -1, option_type: "PUT", strike: 6400 }, { sign: 1, option_type: "PUT", strike: 6350 },
      ],
    }),
    combo({ id: "mon-calls", code: "dec-calls", scope: "all" }),
  ],
  monitor_positions: [
    link("mon-condor", "pos-calls"), link("mon-condor", "pos-puts"), link("mon-calls", "pos-calls"),
  ],
};

/** Three days of a holding opened on the sixth: each leg's IV and vega, a day apart in DTE. */
const opened = position({ id: "pos-1", opened_at: "2026-11-06" });
const codes = [C7300, "US.SPXW261218C7350000", P6400, P6350];
const day = (observed_on: string, dte: number, ivs: number[]) => sample({
  position_id: "pos-1", observed_on, dte, cost_to_close: 3.25,
  legs_iv: Object.fromEntries(codes.map((c, i) => [c, ivs[i]])),
  legs_vega: Object.fromEntries(codes.map((c) => [c, 4.25])),
});

/** A day with its own Cost to close, each leg's own vega and the instant it was observed (#333). */
const dayAt = (observed_on: string, dte: number, cost: number | null, ivs: number[], vegas: number[],
  observed_at: string) => sample({
  position_id: "pos-1", observed_on, dte, cost_to_close: cost, observed_at,
  legs_iv: Object.fromEntries(codes.map((c, i) => [c, ivs[i]])),
  legs_vega: Object.fromEntries(codes.map((c, i) => [c, vegas[i]])),
});
const VEGAS = [5.5, 4.75, 4.25, 3.5];

/** Out of New York's session (#380): Saturday 14 November 2026, noon there. moomoo quotes every
 *  option bid 0 / ask 0 now, so a holding is valued from its latest close rather than live. */
const SATURDAY = "2026-11-14T17:00:00.000Z";
const condorCodes = [C7300, C7350, P6400, P6350];
const legMap = (values: number[]) => Object.fromEntries(condorCodes.map((c, i) => [c, values[i]]));
/** A day's row of the condor, observed at a UTC instant, with every figure a close carries. */
const closeRow = (observed_on: string, dte: number, cost: number | null, observed_at: string, over = {}) =>
  sample({
    position_id: "pos-1", observed_on, dte, cost_to_close: cost, observed_at,
    legs_iv: legMap([14.5, 14, 19.25, 20]), legs_vega: legMap([4.25, 4, 4.5, 3.75]),
    legs_delta: legMap([0.2, 0.14, -0.17, -0.11]), spx: 6900.5, contract_size: 100, ...over,
  });
/** Thursday's and Friday's closes, at 16:14 New York, and Saturday's row: filled after New York's
 *  midnight with each leg's vol and no price (#380). */
const THU = closeRow("2026-11-12", 36, 3.75, "2026-11-12 21:14:58.000000");
const FRI = closeRow("2026-11-13", 35, 3.25, "2026-11-13 21:14:59.000000");
const SAT = closeRow("2026-11-14", 34, null, "2026-11-14 05:00:12.000000");
/** 20:15:07 on Sunday 15 November in New York: the first moment of Monday's GTH (#416), and 00:00
 *  on Monday, still in it. */
const GTH = "2026-11-16T01:15:07.000Z";
const GTH_MONDAY = "2026-11-16T05:00:00.000Z";
/** Thursday's and Friday's closes, Saturday's costless fill, and the two rows the service priced
 *  overnight before #416 — Sunday 20:15:07 and Monday 00:00 New York — which migration 0015 clears. */
const GTH_ROWS = [THU, FRI, SAT,
  closeRow("2026-11-15", 33, 3.4, "2026-11-16 01:15:07.000000"),
  closeRow("2026-11-16", 32, 3.05, "2026-11-16 05:00:06.000000"),
];
/** A call spread beside the condor, its long leg the 7500 call. */
const wing = position({
  id: "pos-2", name: "dec-call-wing", strategy: "call spread", entry: 1.5, opened_at: "2026-11-13",
  legs: [
    { side: "short", option_type: "CALL", strike: 7350 },
    { side: "long", option_type: "CALL", strike: 7500 },
  ],
});
/** moomoo's answer for the condor out of hours: no mid on any leg (`midPrice`), the rest as before. */
const OUT_OF_HOURS = Object.fromEntries(Object.entries(BOOK).map(([code, q]) => {
  const { mid_price: _mid, ...rest } = q;
  return [code, { ...rest, bid_price: 0, ask_price: 0 }];
}));

const single = { strike_date: EXPIRY, option_type: "CALL", strike: 7300, threshold: 0.3 };
const comboBody = {
  name: "dec-calls", strike_date: EXPIRY, threshold: 4,
  legs: [
    { sign: -1, option_type: "CALL", strike: 7300 }, { sign: 1, option_type: "CALL", strike: 7350 },
  ],
};
const condorBody = {
  name: "dec-condor", strike_date: EXPIRY, entry: 6.4, strategy: "iron condor",
  opened_at: "2026-10-12",
  legs: [
    { side: "short", option_type: "CALL", strike: 7300 },
    { side: "long", option_type: "CALL", strike: 7350 },
    { side: "short", option_type: "PUT", strike: 6400 },
    { side: "long", option_type: "PUT", strike: 6350 },
  ],
};

/** The condor as the add form sends it, as two spreads held: each with its Entry, the day it was
 *  opened, and its two usual Monitors (#293). */
const PUT_SPREAD = {
  name: "dec-puts", held: true, entry: 2.25, opened_at: "2026-11-06",
  legs: [
    { side: "short", option_type: "PUT", strike: 6400 }, { side: "long", option_type: "PUT", strike: 6350 },
  ],
  monitors: [{ threshold: 4.5 }, { option_type: "PUT", strike: 6400, threshold: 0.3 }],
};
const CALL_SPREAD = {
  name: "dec-calls", held: true, entry: 1, opened_at: "2026-11-06", contracts: 2,
  legs: [
    { side: "short", option_type: "CALL", strike: 7300 }, { side: "long", option_type: "CALL", strike: 7350 },
  ],
  monitors: [{ threshold: 2 }, { option_type: "CALL", strike: 7300, threshold: 0.3 }],
};

/** The put spread watched before it was sold: an entry signal on its value and on its short
 *  put's delta, linked to no holding. */
const WATCHING_PUTS = [
  combo({
    id: "mon-watch-value", code: "dec-puts", threshold: 2.5,
    legs: [{ sign: -1, option_type: "PUT", strike: 6400 }, { sign: 1, option_type: "PUT", strike: 6350 }],
  }),
  monitor({ id: "mon-watch-delta", option_type: "PUT", strike: 6400, threshold: 0.15 }),
];

/** One contract held, as the add form's "one contract" sends it (#331): a spread of one leg, and
 *  the one Monitor the owner typed, naming that leg. */
const ONE_PUT = {
  name: "1218_P6400", held: true, entry: 4.5, contracts: 1, opened_at: "2026-11-06",
  legs: [{ side: "short", option_type: "PUT", strike: 6400 }],
  monitors: [{ option_type: "PUT", strike: 6400, field: "option_delta", threshold: 0.3, direction: "above", compare: "abs" }],
};

/** A quantity per leg (#351). A 1×2 put ratio held: the 6400 bought, the 6350 sold twice over, for a
 *  credit — its value rule the holding's signed stop, its delta rule on the short leg once, since
 *  |Δ| is one contract's whatever the quantity. */
const RATIO = {
  name: "dec-ratio", held: true, entry: 0.5, opened_at: "2026-11-06",
  legs: [
    { side: "long", option_type: "PUT", strike: 6400 }, { side: "short", option_type: "PUT", strike: 6350, qty: 2 },
  ],
  monitors: [
    { threshold: -1, direction: "below", compare: "signed" }, { option_type: "PUT", strike: 6350, threshold: 0.3 },
  ],
};
/** A call butterfly, 1×2×1, watched: an entry signal on its value. */
const C7400 = "US.SPXW261218C7400000";
const FLY_BOOK = { ...BOOK, [C7400]: quote("SPXW 261218 7400C", 1, 0.1) };
const FLY = {
  name: "dec-fly", held: false,
  legs: [
    { side: "long", option_type: "CALL", strike: 7300 }, { side: "short", option_type: "CALL", strike: 7350, qty: 2 },
    { side: "long", option_type: "CALL", strike: 7400 },
  ],
  monitors: [{ threshold: 0.5 }, { option_type: "CALL", strike: 7350, threshold: 0.3 }],
};
/** The ratio as `POST /spreads` leaves it: held, its value rule linked as the whole of it. */
const ratioHeld = {
  positions: [position({ id: "pos-ratio", name: "dec-ratio", entry: 0.5, legs: RATIO.legs })],
  monitors: [combo({
    id: "mon-ratio", code: "dec-ratio", scope: "all", threshold: -1, direction: "below", compare: "signed",
    legs: [{ sign: 1, option_type: "PUT", strike: 6400 }, { sign: -1, option_type: "PUT", strike: 6350, qty: 2 }],
  })],
  monitor_positions: [link("mon-ratio", "pos-ratio")],
};

/** The ratio typed as a 1×3 (#359), held, with its value rule ringing, its short leg's Δ rule and a
 *  day's sample: what a quantity correction starts from. */
const TYPED13 = [
  { side: "long", option_type: "PUT", strike: 6400 }, { side: "short", option_type: "PUT", strike: 6350, qty: 3 },
];
const typed13 = {
  positions: [position({ id: "pos-ratio", name: "dec-ratio", entry: 0.5, legs: TYPED13 })],
  monitors: [
    combo({
      id: "mon-ratio", code: "dec-ratio", scope: "all", threshold: -1, direction: "below", compare: "signed",
      triggered: 1, last_alarm_at: "2026-11-09 14:00:00.000000",
      legs: [{ sign: 1, option_type: "PUT", strike: 6400 }, { sign: -1, option_type: "PUT", strike: 6350, qty: 3 }],
    }),
    monitor({
      id: "mon-ratio-d", option_type: "PUT", strike: 6350, scope: "leg", triggered: 1,
      last_alarm_at: "2026-11-09 14:00:00.000000",
    }),
  ],
  monitor_positions: [link("mon-ratio", "pos-ratio"), link("mon-ratio-d", "pos-ratio")],
  position_samples: [sample({ position_id: "pos-ratio", observed_on: "2026-11-06", cost_to_close: 2.25 })],
};

/** The book with a far call priced too, which nothing holds and no combo names. */
const WIDE = { ...BOOK, [C7500]: quote("SPXW 261218 7500C", 0.5, 0.06) };

/** A far put, priced: the sixth leg of the six-leg spread (#334). */
const P6300 = "US.SPXW261218P6300000";
const SIX_BOOK = { ...WIDE, [P6300]: quote("SPXW 261218 6300P", 1.25, -0.08) };
/** The condor with a further wing bought on each side: six legs, the most one spread may have. */
const SIX_LEGS = [
  ...PUT_SPREAD.legs, ...CALL_SPREAD.legs,
  { side: "long", option_type: "PUT", strike: 6300 }, { side: "long", option_type: "CALL", strike: 7500 },
];

const CONDOR_SIGNS = [
  { sign: -1, option_type: "CALL", strike: 7300 }, { sign: 1, option_type: "CALL", strike: 7350 },
  { sign: -1, option_type: "PUT", strike: 6400 }, { sign: 1, option_type: "PUT", strike: 6350 },
];

const SPY = { name: "SPDR S&P 500 ETF", mid_price: 689.45, last_price: 689.4, prev_close_price: 685.2 };
const VIX = {
  name: "CBOE Volatility Index", last_price: 16.82, prev_close_price: 17.4, delayed: true,
  last_known: false, delayed_by_minutes: 15,
};
const references = {
  reference_securities: [
    reference({ id: "ref-1", code: "US.SPY", label: "SPX via SPY" }),
    reference({ id: "ref-2", code: "^VIX", source: "yahoo", created_at: "2026-11-02 14:31:00.000000" }),
    reference({ id: "ref-3", code: "VIX", source: "ibkr", created_at: "2026-11-02 14:32:00.000000" }),
  ],
};

/** A put spread quoted so its sums carry float noise (#454): mids 10.1 and 6, summed -4.100000000000001;
 *  gammas 0.0004503 and 0.00041, summed -0.000040300000000000004. */
const NOISY_PUTS = {
  [buildSpxCode(EXPIRY, "PUT", 6800)]: quote("SPXW 261218 6800P", 10.1, -0.2345678, {
    bid_price: 10.05, ask_price: 10.15, option_gamma: 0.0004503, option_theta: -1.2345678,
    option_vega: 9.8765432, option_implied_volatility: 18.123456,
  }),
  [buildSpxCode(EXPIRY, "PUT", 6750)]: quote("SPXW 261218 6750P", 6, -0.2012345, {
    bid_price: 5.95, ask_price: 6.05, option_gamma: 0.00041, option_theta: -1.1111111,
    option_vega: 9.1234567, option_implied_volatility: 19.654321,
  }),
};

/** C7300 as moomoo's snapshot record carries it, every `RECORD_FIELDS` key (review of #455): text as
 *  text, counts, strikes and sizes whole, and every other figure with more places than it is written at. */
const FULL_RECORD = {
  code: C7300, name: "SPXW 261218 7300C", update_time: "2026-11-09 09:59:58", lot_size: 1, suspension: false,
  last_price: 2.7512345, open_price: 2.9012345, high_price: 3.0512345, low_price: 2.6012345,
  prev_close_price: 2.8512345, ask_price: 2.8000000000000003, bid_price: 2.7, ask_vol: 12, bid_vol: 7,
  volume: 1234, turnover: 339512.3456789, turnover_rate: 0.0123456789, amplitude: 16.12345678,
  avg_price: 2.7512345678, bid_ask_ratio: 26.315789473684, option_type: "CALL", stock_owner: "US..SPX",
  option_strike_time: "2026-12-18", option_strike_price: 7300, option_contract_size: 100,
  option_contract_multiplier: 100, option_open_interest: 4321, option_implied_volatility: 14.523456789,
  option_premium: 5.8312345678, option_delta: 0.212345678, option_gamma: 0.000123456789,
  option_vega: 4.2512345678, option_theta: -0.8512345678, option_rho: 0.312345678,
  option_expiry_date_distance: 39, option_area_type: "EUROPEAN", mid_price: 2.75,
};

/** One JSON-RPC request to the MCP door, as a client sends it (ADR 0026). */
const rpc = (method: string, params?: unknown) =>
  ({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) });
/** One `tools/call`. */
const tool = (name: string, args?: Record<string, unknown>) =>
  rpc("tools/call", { name, ...(args === undefined ? {} : { arguments: args }) });

/** An agent's writes switched on (#456, ADR 0028). */
const WRITING = { MCP_WRITES: "1" };
/** The condor's put spread, as `add_rule` takes it: the structure `price_spreads` takes, and a name. */
const PUT_SPREAD_RULE = {
  expiry: "20261218", name: "1218-6400", threshold: 2.25,
  legs: [{ side: "short", option_type: "PUT", strike: 6400 }, { side: "long", option_type: "PUT", strike: 6350 }],
};

/** Rules to name (#447's follow-up): the short call watched for its Δ (`mon-1`) and its price
 *  (`mon-3`), the short put for its Δ alone (`mon-4`), and the call spread as the combo `1218-6800`. */
const RULES = world({
  tables: {
    monitors: [
      monitor({ id: "mon-1" }),
      monitor({ id: "mon-3", field: "mid_price", threshold: 9.5, compare: "signed", created_at: "2026-11-02 14:31:00.000000" }),
      monitor({ id: "mon-4", option_type: "PUT", strike: 6400, threshold: 0.15, created_at: "2026-11-02 14:32:00.000000" }),
      combo({ id: "mon-2", code: "1218-6800", created_at: "2026-11-02 14:33:00.000000" }),
    ],
    watch_samples: [
      watchDay([P6400], {
        observed_on: "2026-11-05", dte: 43, observed_at: "2026-11-05 21:14:00.000000", spx: 6812.5,
        legs_mid: { [P6400]: 4.1 }, legs_iv: { [P6400]: 18.5 }, legs_delta: { [P6400]: -0.12 }, contract_size: 100,
      }),
      watchDay([C7300, C7350], {
        observed_on: "2026-11-05", dte: 43, observed_at: "2026-11-05 21:14:00.000000", spx: 6812.5,
        legs_mid: { [C7300]: 3, [C7350]: 2 }, contract_size: 100,
      }),
    ],
  },
  provider: { down: DOWN },
});

/** The condor's call spread and its put spread as `spread=` writes them, URI-encoded (#452). */
const QUOTE_CALLS = "20261218%3A-C7300%2C+C7350";
const QUOTE_PUTS = "20261218%3A-P6400%2C%2BP6350";
/** Six legs, the most one structure may have. */
const SIX_QUOTED = "20261218%3A-P6400%2C%2BP6350%2C-P6300%2C%2BP6250%2C-P6200%2C%2BP6150";

export const HTTP: readonly HttpInput[] = [
  // --- /health ----------------------------------------------------------------------------
  {
    name: "GET /health answers without a token on a service that has not swept yet",
    world: world(),
    request: request("GET", "/health", null, { anonymous: true }),
  },
  {
    // a sweep that fetched and had nothing to write: what a healthy, quiet service looks like
    name: "GET /health after a sweep that worked",
    world: world({
      tables: { positions: [position({ id: "pos-1" })] },
      sweeps: [{ at: at(-10), down: null }],
    }),
    request: request("GET", "/health"),
  },
  {
    // the last batch outranks the probe: the port answers and the gateway does not
    name: "GET /health after the Provider failed a sweep",
    world: world({
      tables: { positions: [position({ id: "pos-1" })] },
      sweeps: [{ at: at(-10), down: DOWN }],
    }),
    request: request("GET", "/health"),
  },

  {
    // the interval IN FORCE, and where it came from (#442): the page's choice, .env's beside it
    name: "GET /health says the sweep interval the page chose",
    world: world({ tables: { sweep_interval: [chosenInterval(5)] } }),
    request: request("GET", "/health", null, { anonymous: true }),
  },
  {
    // a value no route writes got in by hand: refused when read, and .env's is in force
    name: "GET /health sweeps at the .env interval when the stored one is not a preset",
    world: world({ tables: { sweep_interval: [chosenInterval(2)] } }),
    request: request("GET", "/health", null, { anonymous: true }),
  },

  // --- /settings --------------------------------------------------------------------------
  {
    name: "PATCH /settings chooses the sweep's interval from the presets",
    world: world(),
    request: request("PATCH", "/settings", { sweep_seconds: 5 }),
  },
  {
    // one row at most: a second choice replaces the first
    name: "PATCH /settings changes a choice already made",
    world: world({ tables: { sweep_interval: [chosenInterval(60)] } }),
    request: request("PATCH", "/settings", { sweep_seconds: 30 }),
  },
  {
    // back to MONITOR_INTERVAL_SECONDS by deleting the row, not by storing 15
    name: "PATCH /settings goes back to the .env interval on null",
    world: world({ tables: { sweep_interval: [chosenInterval(60)] } }),
    request: request("PATCH", "/settings", { sweep_seconds: null }),
  },
  {
    // nothing below 5s: each sweep is one moomoo snapshot call, 60 per 30s shared with the pages
    name: "PATCH /settings refuses an interval that is not a preset",
    world: world({ tables: { sweep_interval: [chosenInterval(60)] } }),
    request: request("PATCH", "/settings", { sweep_seconds: 2 }),
  },
  {
    // null is a choice, so a body without the key must not read as one
    name: "PATCH /settings refuses a body that does not say the interval",
    world: world({ tables: { sweep_interval: [chosenInterval(60)] } }),
    request: request("PATCH", "/settings", {}),
  },
  {
    name: "PATCH /settings needs the token",
    world: world(),
    request: request("PATCH", "/settings", { sweep_seconds: 5 }, { anonymous: true }),
  },

  // --- /quotes ----------------------------------------------------------------------------
  {
    name: "GET /quotes prices the whole watchlist in one call",
    world: world({ tables: held, provider: { quotes: BOOK } }),
    request: request("GET", "/quotes"),
  },
  {
    // a quantity per leg (#351): the held ratio's value, greeks and cost to close each count its
    // short leg twice, and its rule reads the holding's Entry as the whole of it
    name: "GET /quotes values a held 1×2 ratio, its short leg counted twice",
    world: world({ tables: ratioHeld, provider: { quotes: BOOK } }),
    request: request("GET", "/quotes"),
  },
  {
    // and a 1×1 watched on the same strikes beside it, as adoption links one (the POST /spreads
    // scenarios below run it): part of the holding, "leg", so its row carries none of the 1×2's
    // Entry, P&L, cost to close or schedule, and is valued as ITS legs say
    name: "GET /quotes values a 1×1 watched beside a held 1×2 on the same strikes as its own legs",
    world: world({
      tables: {
        ...ratioHeld,
        monitors: [...ratioHeld.monitors, combo({
          id: "mon-one", code: "dec-one", scope: "leg",
          legs: [{ sign: 1, option_type: "PUT", strike: 6400 }, { sign: -1, option_type: "PUT", strike: 6350 }],
        })],
        monitor_positions: [...ratioHeld.monitor_positions, link("mon-one", "pos-ratio")],
      },
      provider: { quotes: BOOK },
    }),
    request: request("GET", "/quotes"),
  },
  {
    name: "GET /quotes marks a contract the Provider does not know",
    world: world({
      tables: held,
      provider: { quotes: except(BOOK, C7300), unknown: [C7300] },
    }),
    request: request("GET", "/quotes"),
  },
  {
    // what a rule's sentence reads after "now" (ADR 0023): how far each figure is from its
    // threshold in the field's own units — negative past it, zero AT it, where the bell rings as
    // well, signed for a signed rule, and nothing where nothing was priced
    name: "GET /quotes says how far each rule is from its threshold",
    world: world({
      tables: {
        monitors: [
          // 2.75 against 2.50: a quarter past
          monitor({ id: "mon-past", field: "mid_price", threshold: 2.5 }),
          // 1.75 against 1.75: exactly at it, which is breached
          monitor({ id: "mon-at", strike: 7350, field: "mid_price", threshold: 1.75 }),
          // 4.50 waiting to fall to 1.50: three points to go
          monitor({
            id: "mon-inside", option_type: "PUT", strike: 6400, field: "mid_price", threshold: 1.5,
            direction: "below",
          }),
          // nothing quoted for it
          monitor({ id: "mon-unpriced", strike: 7500 }),
          // -2.75 + 1.75 = -1.00, signed, below -0.75: a quarter past
          combo({ id: "mon-calls", threshold: -0.75, direction: "below", compare: "signed" }),
        ],
      },
      provider: { quotes: BOOK },
    }),
    request: request("GET", "/quotes"),
  },
  {
    // a single Contract's rule names every ENABLED combo whose legs hold that Contract, which is
    // what sits a short leg's delta rule under its spread on the page (ADR 0023). A combo that
    // was switched off is not in the watchlist and is not named; a Contract no combo holds, and
    // a combo's own row, name none
    name: "GET /quotes finds the spreads each single Contract is a leg of",
    world: world({
      tables: {
        monitors: [
          monitor({ id: "mon-short-call" }),
          monitor({ id: "mon-short-put", option_type: "PUT", strike: 6400 }),
          monitor({ id: "mon-far-call", strike: 7500 }),
          // the two combos holding the short call ARRIVE out of id order, so its list shows the
          // sort rather than the order they came in. The watchlist orders by strike_date, legs,
          // option_type and strike, which cannot tell two combos on one expiry apart, and a tie
          // arrives as stored — which in a scenario is by id, because the format lists rows by
          // key. So the condor's strike, which the API stores as 0 for a combo and nothing reads
          // (its legs carry the strikes), is 1 here: it puts the condor second
          combo({ id: "mon-spread" }),
          combo({ id: "mon-condor", code: "dec-condor", strike: 1, legs: CONDOR_SIGNS }),
          combo({
            id: "mon-puts", code: "dec-puts", enabled: 0, disabled_reason: "no-figure",
            legs: [
              { sign: -1, option_type: "PUT", strike: 6400 }, { sign: 1, option_type: "PUT", strike: 6350 },
            ],
          }),
        ],
      },
      provider: { quotes: WIDE },
    }),
    request: request("GET", "/quotes"),
  },
  {
    // whether a rule watches anything held, which tells a risk alarm from an entry signal (ADR
    // 0023). On a roll day two open holdings share the short call, so no link names either and
    // `positions` is empty — but the Contract is held. A candidate nothing holds is not, and
    // neither is a Contract only a CLOSED holding had
    name: "GET /quotes says a rule is held on a roll day, when no link names the holding",
    world: world({
      tables: {
        positions: [
          position({
            id: "pos-old", name: "dec-call-spread", strategy: "call spread", entry: 2,
            legs: [
              { side: "short", option_type: "CALL", strike: 7300 },
              { side: "long", option_type: "CALL", strike: 7350 },
            ],
          }),
          position({
            id: "pos-rolled", name: "dec-call-spread-wide", strategy: "call spread", entry: 2.5,
            opened_at: "2026-11-09",
            legs: [
              { side: "short", option_type: "CALL", strike: 7300 },
              { side: "long", option_type: "CALL", strike: 7500 },
            ],
          }),
          position({
            id: "pos-closed", name: "dec-short-put", strategy: "short put", entry: 4,
            closed_on: "2026-11-06", exit: 3.5,
            legs: [{ side: "short", option_type: "PUT", strike: 6400 }],
          }),
        ],
        monitors: [
          monitor({ id: "mon-short-call" }),
          monitor({ id: "mon-candidate", option_type: "PUT", strike: 6350 }),
          monitor({ id: "mon-closed-put", option_type: "PUT", strike: 6400 }),
        ],
      },
      provider: { quotes: WIDE },
    }),
    request: request("GET", "/quotes"),
  },
  {
    // a field the quote schema does not type passes through as the Provider sent it, so an
    // infinite reading reaches the row. It is no figure — JSON cannot write one, and no market
    // quotes one — so it is served as no figure, no distance, no fill and no bell, as the sweep
    // reads it, and every other row is answered as usual
    name: "GET /quotes serves an infinite reading as no figure, and answers every other row",
    world: world({
      tables: {
        monitors: [
          monitor({ id: "mon-delta" }),
          monitor({ id: "mon-interest", strike: 7350, field: "option_open_interest", threshold: 1000 }),
        ],
      },
      provider: {
        quotes: { ...BOOK, [C7350]: { ...BOOK[C7350], option_open_interest: "Infinity" } },
      },
    }),
    request: request("GET", "/quotes"),
  },
  {
    // a reading that is not a number is no reading: no figure, no distance, no bar and no bell
    name: "GET /quotes serves a reading that is not a number as no figure",
    world: world({
      tables: {
        monitors: [
          monitor({ id: "mon-delta" }),
          monitor({ id: "mon-interest", strike: 7350, field: "option_open_interest", threshold: 1000 }),
        ],
      },
      provider: {
        quotes: { ...BOOK, [C7350]: { ...BOOK[C7350], option_open_interest: "n/a" } },
      },
    }),
    request: request("GET", "/quotes"),
  },
  {
    name: "GET /quotes answers 502 naming the Provider when it is down",
    world: world({ tables: held, provider: { down: DOWN } }),
    request: request("GET", "/quotes"),
  },
  {
    name: "GET /quotes on an empty watchlist asks the Provider nothing",
    world: world(),
    request: request("GET", "/quotes"),
  },

  // --- /monitors --------------------------------------------------------------------------
  {
    name: "GET /monitors lists every rule with the holdings it covers",
    world: world({ tables: held }),
    request: request("GET", "/monitors"),
  },
  // --- a watched rule's daily closes (#402): stored history, and no market data --------------
  {
    // the call spread watched on its value: each day valued under the rule's signs, a close and an
    // evening reading with no book. The Provider is DOWN, so a route that asked it would fail
    name: "GET /monitors/{id}/samples serves a watched spread's days under its own signs",
    world: world({
      tables: {
        monitors: [combo({ id: "mon-2" })],
        watch_samples: [
          watchDay([C7300, C7350], {
            observed_on: "2026-11-05", dte: 43, observed_at: "2026-11-05 21:14:00.000000", spx: 6812.5,
            legs_mid: { [C7300]: 3, [C7350]: 2 }, legs_iv: { [C7300]: 14.5, [C7350]: 14.25 },
            legs_delta: { [C7300]: 0.22, [C7350]: 0.16 }, contract_size: 100,
          }),
          watchDay([C7300, C7350], {
            observed_on: "2026-11-06", dte: 42, observed_at: "2026-11-07 01:00:00.000000",
            legs_iv: { [C7300]: 14.25, [C7350]: 14 },
          }),
        ],
      },
      provider: { down: DOWN },
    }),
    request: request("GET", "/monitors/mon-2/samples"),
  },
  {
    // the short call watched on its delta: a single contract's history is its own mid, and the
    // spread's price rule is no threshold of its
    name: "GET /monitors/{id}/samples serves a single contract's days as its own mid",
    world: world({
      tables: {
        monitors: [monitor({ id: "mon-1" }), combo({ id: "mon-2" })],
        watch_samples: [watchDay([C7300], {
          observed_on: "2026-11-06", dte: 42, legs_mid: { [C7300]: 3 }, legs_delta: { [C7300]: 0.22 },
        })],
      },
      provider: { down: DOWN },
    }),
    request: request("GET", "/monitors/mon-1/samples"),
  },
  {
    name: "GET /monitors/{id}/samples on a rule that does not exist",
    world: world({ tables: held }),
    request: request("GET", "/monitors/mon-9/samples"),
  },
  {
    // the Provider DOWN, as through an outage: each rule's last close from the stored history, a
    // database read that asks no Provider (#402). The delta-watched spread's is its price's latest
    // close taken in a session, not the evening's reading after it; the call spread held exactly by a
    // holding has none (its days are the holding's); the short call's own mid
    name: "GET /monitors/closes serves each rule's last close with the Provider down",
    world: world({
      tables: {
        positions: [position({
          id: "pos-calls", name: "dec-call-spread", entry: 2.5,
          legs: [{ side: "short", option_type: "CALL", strike: 7300 }, { side: "long", option_type: "CALL", strike: 7350 }],
        })],
        monitors: [
          monitor({ id: "mon-1" }),
          combo({ id: "mon-2", scope: "all" }),
          combo({
            id: "mon-3", code: "dec-puts", field: "option_delta", threshold: 0.1,
            legs: [{ sign: -1, option_type: "PUT", strike: 6400 }, { sign: 1, option_type: "PUT", strike: 6350, qty: 2 }],
          }),
        ],
        monitor_positions: [link("mon-2", "pos-calls")],
        watch_samples: [
          watchDay([C7300], { observed_on: "2026-11-06", dte: 42, legs_mid: { [C7300]: 3 } }),
          watchDay([C7300, C7350], { observed_on: "2026-11-06", dte: 42, legs_mid: { [C7300]: 3, [C7350]: 2 } }),
          watchDay([P6400, P6350], {
            observed_on: "2026-11-06", dte: 42, observed_at: "2026-11-06 21:14:00.000000",
            legs_mid: { [P6400]: 4.5, [P6350]: 2 },
          }),
          watchDay([P6400, P6350], {
            observed_on: "2026-11-07", dte: 41, observed_at: "2026-11-08 01:00:00.000000",
            legs_mid: { [P6400]: 4.75, [P6350]: 2 },
          }),
        ],
      },
      provider: { down: DOWN },
    }),
    request: request("GET", "/monitors/closes"),
  },
  {
    // a rule whose stored legs the engine cannot read: refused in words, in the shape every refusal
    // has, rather than a 500
    name: "GET /monitors/{id}/samples refuses a rule that cannot be read",
    world: world({
      tables: { monitors: [combo({ id: "mon-2", legs: [{ sign: 2, option_type: "CALL", strike: 7300 }] })] },
      provider: { down: DOWN },
    }),
    request: request("GET", "/monitors/mon-2/samples"),
  },
  {
    name: "GET /monitors without the token is refused",
    world: world({ tables: held }),
    request: request("GET", "/monitors", null, { anonymous: true }),
  },
  {
    name: "POST /monitors creates a single-leg rule and links it to the holding of its contract",
    world: world({ tables: { positions: [position({ id: "pos-1" })] }, provider: { quotes: BOOK } }),
    request: request("POST", "/monitors", single),
  },
  {
    name: "POST /monitors creates a rule already muted",
    world: world({ provider: { quotes: BOOK } }),
    request: request("POST", "/monitors", { ...single, enabled: false }),
  },
  {
    name: "POST /monitors creates a combo from its legs, probing both in one call",
    world: world({ provider: { quotes: BOOK } }),
    request: request("POST", "/monitors", comboBody),
  },
  {
    // a quantity is POST /spreads' to take (#351): refused in words here, never dropped into a 1×1
    name: "POST /monitors refuses a leg's quantity, asking the Provider nothing",
    world: world({ provider: { quotes: BOOK } }),
    request: request("POST", "/monitors", {
      ...comboBody, legs: [comboBody.legs[0], { ...comboBody.legs[1], qty: 2 }],
    }),
  },
  {
    // the database before the Provider: a duplicate costs no bounded call
    name: "POST /monitors refuses a duplicate without asking the Provider",
    world: world({ tables: held, provider: { quotes: BOOK } }),
    request: request("POST", "/monitors", single),
  },
  {
    name: "POST /monitors refuses a contract the Provider does not know",
    world: world({ provider: { unknown: [C7500] } }),
    request: request("POST", "/monitors", { ...single, strike: 7500 }),
  },
  {
    // strict on purpose: creation is refused while the Provider is down
    name: "POST /monitors refuses while the Provider cannot confirm the contract",
    world: world({ provider: { down: DOWN } }),
    request: request("POST", "/monitors", single),
  },
  {
    name: "POST /monitors refuses a zero threshold compared as an absolute",
    world: world({ provider: { quotes: BOOK } }),
    request: request("POST", "/monitors", { ...single, threshold: 0 }),
  },
  {
    name: "POST /monitors refuses a strike date it cannot read",
    world: world(),
    request: request("POST", "/monitors", { ...single, strike_date: "18 Dec" }),
  },
  {
    // a body carrying legs is a combo, and the combo's own refusal is the one reported — not
    // "Invalid input" from both shapes at once, nor the single-leg shape's missing option_type
    name: "POST /monitors refuses a combo's strike date it cannot read",
    world: world(),
    request: request("POST", "/monitors", { ...comboBody, strike_date: "18 Dec" }),
  },
  {
    name: "POST /monitors refuses a combo on a figure that does not add up",
    world: world({ provider: { quotes: BOOK } }),
    request: request("POST", "/monitors", { ...comboBody, field: "option_implied_volatility" }),
  },
  {
    // a quote's text is no figure: watched, it read NaN every sweep — never breached, never silent,
    // never quarantined — so it is refused, asking the Provider nothing
    name: "POST /monitors refuses a field that is not a figure a quote carries",
    world: world({ provider: { quotes: BOOK } }),
    request: request("POST", "/monitors", { ...single, field: "option_type" }),
  },
  {
    name: "POST /monitors refuses a combo on a field that is not a figure a quote carries",
    world: world({ provider: { quotes: BOOK } }),
    request: request("POST", "/monitors", { ...comboBody, field: "name" }),
  },
  {
    name: "PATCH /monitors/{id} moves a threshold",
    world: world({ tables: held }),
    request: request("PATCH", "/monitors/mon-1", { threshold: 0.35 }),
  },
  {
    // the dashboard edits every field in place (#292): what a rule watches, its direction and how
    // it compares, with the threshold that is legal under the new compare, in one change
    name: "PATCH /monitors/{id} changes what a rule watches, its direction and its compare",
    world: world({ tables: held }),
    request: request("PATCH", "/monitors/mon-1", {
      field: "mid_price", direction: "below", compare: "signed", threshold: -1.5,
    }),
  },
  {
    // a ringing rule edited to watch something else is a new rule: its bell and its last alarm are
    // the old rule's, and the sweep would compare the new figure against them (#292)
    name: "PATCH /monitors/{id} forgets a ringing rule's alarm when what it watches changes",
    world: world({
      tables: { monitors: [monitor({ id: "mon-1", triggered: 1, last_alarm_at: "2026-11-02 14:30:00" })] },
    }),
    request: request("PATCH", "/monitors/mon-1", { field: "mid_price", threshold: 4 }),
  },
  {
    // a threshold moved alone keeps the bell: it flips at the new line on the next sweep
    name: "PATCH /monitors/{id} keeps a ringing rule's alarm when only its threshold moves",
    world: world({
      tables: { monitors: [monitor({ id: "mon-1", triggered: 1, last_alarm_at: "2026-11-02 14:30:00" })] },
    }),
    request: request("PATCH", "/monitors/mon-1", { threshold: 0.35 }),
  },
  {
    // switched off with its holding while ringing, then back on: it comes back as a new rule
    name: "PATCH /monitors/{id} forgets the alarm of a rule switched back on",
    world: world({
      tables: {
        monitors: [monitor({
          id: "mon-1", enabled: 0, disabled_reason: "holding-closed", triggered: 1,
          last_alarm_at: "2026-11-02 14:30:00",
        })],
      },
    }),
    request: request("PATCH", "/monitors/mon-1", { enabled: true }),
  },
  {
    name: "PATCH /monitors/{id} refuses a combo moved onto a figure that does not add up",
    world: world({ tables: held }),
    request: request("PATCH", "/monitors/mon-2", { field: "option_implied_volatility" }),
  },
  {
    name: "PATCH /monitors/{id} refuses a field that is not a figure a quote carries",
    world: world({ tables: held }),
    request: request("PATCH", "/monitors/mon-1", { field: "abs" }),
  },
  {
    // the owner's fix for a quarantine: switched back on, its reason cleared, the sweep to judge it
    name: "PATCH /monitors/{id} switches a quarantined rule back on and clears its reason",
    world: world({
      tables: {
        monitors: [monitor({ id: "mon-1", enabled: 0, disabled_reason: "unknown-contract" })],
      },
    }),
    request: request("PATCH", "/monitors/mon-1", { enabled: true }),
  },
  {
    name: "PATCH /monitors/{id} mutes a rule by hand",
    world: world({ tables: held }),
    request: request("PATCH", "/monitors/mon-1", { enabled: false }),
  },
  {
    name: "PATCH /monitors/{id} renames a combo and keeps its alarm state",
    world: world({ tables: held }),
    request: request("PATCH", "/monitors/mon-2", { name: "dec-call-spread" }),
  },
  {
    // the dashboard says so where the name is typed (#336): a holding recorded under the same name,
    // as POST /spreads records a held spread's, keeps it — PATCH /positions takes no name at all
    name: "PATCH /monitors/{id} renames a held spread's rule and leaves its holding's name",
    world: world({
      tables: {
        positions: [position({
          id: "pos-calls", name: "dec-calls",
          legs: [
            { side: "short", option_type: "CALL", strike: 7300 }, { side: "long", option_type: "CALL", strike: 7350 },
          ],
        })],
        monitors: [combo({ id: "mon-2", code: "dec-calls", scope: "all" })],
        monitor_positions: [link("mon-2", "pos-calls")],
      },
    }),
    request: request("PATCH", "/monitors/mon-2", { name: "dec-call-spread" }),
  },
  {
    name: "PATCH /monitors/{id} refuses a rename onto a name already taken",
    world: world({
      tables: { ...held, monitors: [...held.monitors, combo({ id: "mon-3", code: "dec-wing" })] },
    }),
    request: request("PATCH", "/monitors/mon-2", { name: "dec-wing" }),
  },
  {
    name: "PATCH /monitors/{id} refuses to rename a single-leg rule",
    world: world({ tables: held }),
    request: request("PATCH", "/monitors/mon-1", { name: "short-call" }),
  },
  {
    name: "PATCH /monitors/{id} refuses a zero threshold",
    world: world({ tables: held }),
    request: request("PATCH", "/monitors/mon-1", { threshold: 0 }),
  },
  {
    name: "PATCH /monitors/{id} refuses an empty change",
    world: world({ tables: held }),
    request: request("PATCH", "/monitors/mon-1", {}),
  },
  {
    name: "PATCH /monitors/{id} on a rule that does not exist",
    world: world({ tables: held }),
    request: request("PATCH", "/monitors/mon-9", { threshold: 0.35 }),
  },
  {
    name: "DELETE /monitors/{id} removes the rule and its links and keeps the holding",
    world: world({ tables: held }),
    request: request("DELETE", "/monitors/mon-1"),
  },
  {
    name: "DELETE /monitors/{id} on a rule that does not exist",
    world: world({ tables: held }),
    request: request("DELETE", "/monitors/mon-9"),
  },
  {
    name: "POST /monitors/{id}/total-entry derives the one wing with no rule of its own",
    world: world({ tables: wings }),
    request: request("POST", "/monitors/mon-condor/total-entry", { entry: 6.4 }),
  },
  {
    name: "POST /monitors/{id}/total-entry refuses a rule that covers no holding",
    world: world({ tables: { monitors: [monitor({ id: "mon-1" })] } }),
    request: request("POST", "/monitors/mon-1/total-entry", { entry: 6.4 }),
  },
  {
    name: "POST /monitors/{id}/total-entry on a rule that does not exist",
    world: world({ tables: wings }),
    request: request("POST", "/monitors/mon-9/total-entry", { entry: 6.4 }),
  },

  // --- /positions -------------------------------------------------------------------------
  {
    name: "GET /positions lists what is held",
    world: world({ tables: held }),
    request: request("GET", "/positions"),
  },
  {
    // a rule set before the holding was recorded is adopted by it
    name: "POST /positions records a holding and adopts the rule already watching it",
    world: world({ tables: { monitors: [monitor({ id: "mon-1" })] }, provider: { quotes: BOOK } }),
    request: request("POST", "/positions", condorBody),
  },
  {
    name: "POST /positions refuses a name already held without asking the Provider",
    world: world({ tables: held, provider: { quotes: BOOK } }),
    request: request("POST", "/positions", condorBody),
  },
  {
    name: "POST /positions refuses a leg the Provider does not know",
    world: world({
      provider: { quotes: except(BOOK, P6350), unknown: [P6350] },
    }),
    request: request("POST", "/positions", condorBody),
  },
  {
    name: "POST /positions refuses a holding with no legs",
    world: world(),
    request: request("POST", "/positions", { ...condorBody, legs: [] }),
  },
  {
    // SPX's price, derived from the premiums of the options this one batch priced (ADR 0024): the
    // median of each option's inversion, on every row, as each row was priced by the same batch
    name: "GET /quotes derives SPX's price from the batch's option premiums",
    world: world({
      tables: {
        monitors: [
          monitor({ id: "mon-1" }),
          monitor({ id: "mon-2", option_type: "PUT", strike: 6400 }),
          combo({ id: "mon-3" }),
        ],
      },
      provider: { quotes: PREMIUM_BOOK },
    }),
    request: request("GET", "/quotes"),
  },
  {
    // a Provider with no premium (IB Gateway serves none) leaves a dash and says why. A Reference
    // naming SPX is on the page and is NOT what fills it: a Reference is a figure nothing derives
    // from (ADR 0018), and /quotes does not ask the Reference path at all
    name: "GET /quotes gives no SPX price without premiums, and never a Reference's",
    world: world({
      tables: {
        monitors: [monitor({ id: "mon-1" })],
        reference_securities: [reference({ id: "ref-1", code: "^GSPC", source: "yahoo", label: "SPX" })],
      },
      provider: { quotes: BOOK },
    }),
    request: request("GET", "/quotes"),
  },
  {
    // premiums, but no last trade beside any of them (before the open, say): nothing to invert,
    // and the reason says that rather than blaming the Provider
    name: "GET /quotes gives no SPX price where no option has a last trade",
    world: world({
      tables: { monitors: [monitor({ id: "mon-1" })] },
      provider: { quotes: { [C7300]: { ...PREMIUM_BOOK[C7300], last_price: null } } },
    }),
    request: request("GET", "/quotes"),
  },
  {
    // the holdings' own batch gives their SPX, so a held spread's strikes are placed against the
    // index of the instant its own cost to close was read (ADR 0010)
    name: "GET /positions/values derives SPX's price from the holdings' own batch",
    world: world({ tables: held, provider: { quotes: PREMIUM_BOOK } }),
    request: request("GET", "/positions/values"),
  },
  {
    // each leg's own delta, all or nothing: one leg with none and the holding serves no map, while
    // its cost to close, which needs only the mids, is still there (#318)
    name: "GET /positions/values serves no leg deltas when one leg has none",
    world: world({
      tables: held,
      provider: { quotes: { ...BOOK, [P6350]: { ...BOOK[P6350], option_delta: null } } },
    }),
    request: request("GET", "/positions/values"),
  },
  {
    // a quantity per leg (#351): the 6350 bought back twice, 2 × 2.25 − 4.5 = 0, and its greeks twice
    name: "GET /positions/values values a 1×2 ratio, its short leg counted twice",
    world: world({ tables: ratioHeld, provider: { quotes: BOOK } }),
    request: request("GET", "/positions/values"),
  },
  {
    name: "GET /positions/values values every holding from one call",
    world: world({ tables: held, provider: { quotes: BOOK } }),
    request: request("GET", "/positions/values"),
  },
  {
    // the share of a credit captured so far, (Entry − Cost to close) / Entry: the call spread was
    // sold for 2.00 and costs 1.00 to close, so half is kept. A debit has no credit to keep a
    // share of, and an Entry nobody recorded has no share either
    name: "GET /positions/values gives a credit the share it has captured, and a debit none",
    world: world({
      tables: {
        positions: [
          position({
            id: "pos-calls", name: "dec-call-spread", strategy: "call spread", entry: 2,
            legs: [
              { side: "short", option_type: "CALL", strike: 7300 },
              { side: "long", option_type: "CALL", strike: 7350 },
            ],
          }),
          position({
            id: "pos-puts", name: "dec-put-spread", strategy: "put spread", entry: null,
            legs: [
              { side: "short", option_type: "PUT", strike: 6400 },
              { side: "long", option_type: "PUT", strike: 6350 },
            ],
          }),
          position({
            id: "pos-long", name: "dec-long-call", strategy: "long call", entry: -0.75,
            legs: [{ side: "long", option_type: "CALL", strike: 7500 }],
          }),
        ],
      },
      provider: { quotes: WIDE },
    }),
    request: request("GET", "/positions/values"),
  },
  {
    // legs that are not even JSON: listed with the reason, so the page can offer it for deletion
    name: "GET /positions lists a holding that cannot be read, with why",
    world: world({
      tables: {
        positions: [position({ id: "pos-1" }), position({ id: "pos-2", name: "dec-broken", legs: "not json" })],
      },
    }),
    request: request("GET", "/positions"),
  },
  // --- a holding the service cannot read, everywhere it could have failed the book (#422's review)
  {
    // the only holdings are unreadable: listed, and no Provider asked — there is nothing to price
    name: "GET /positions/values lists a holding that cannot be read when it is the only one",
    world: world({ tables: { positions: [BROKEN] }, provider: { down: "connect ECONNREFUSED 127.0.0.1:33333" } }),
    request: request("GET", "/positions/values"),
  },
  {
    // an Entry of "abc" failed the response's own schema, and took the whole listing with it: it is
    // served as null on the one row that cannot be read
    name: "GET /positions/values lists a holding whose stored entry is no number",
    world: world({
      tables: { positions: [position({ id: "pos-1" }), position({ id: "pos-2", name: "dec-text-entry", entry: "abc" })] },
      provider: { quotes: BOOK },
    }),
    request: request("GET", "/positions/values"),
  },
  {
    name: "GET /positions lists a holding whose stored count is no number",
    world: world({
      tables: { positions: [position({ id: "pos-1" }), position({ id: "pos-2", name: "dec-text-count", contracts: "two" })] },
    }),
    request: request("GET", "/positions"),
  },
  {
    // an expiry that is no date was "moomoo call failed: invalid strike_date" for the whole book; it
    // is the holding's own fault now, read as such, with no DTE to count
    name: "GET /positions/values lists a holding whose expiry is no date",
    world: world({
      tables: { positions: [position({ id: "pos-1" }), position({ id: "pos-2", name: "dec-no-date", strike_date: "garbage" })] },
      provider: { quotes: BOOK },
    }),
    request: request("GET", "/positions/values"),
  },
  {
    name: "POST /monitors links a new rule beside a holding that cannot be read",
    world: world({ tables: { positions: [position({ id: "pos-1" }), BROKEN] }, provider: { quotes: BOOK } }),
    request: request("POST", "/monitors", single),
  },
  {
    name: "POST /spreads records a spread beside a holding that cannot be read",
    world: world({ tables: { positions: [BROKEN] }, provider: { quotes: BOOK } }),
    request: request("POST", "/spreads", { strike_date: EXPIRY, spreads: [PUT_SPREAD] }),
  },
  {
    name: "POST /positions/{id}/close closes a holding beside one that cannot be read",
    world: world({ tables: { ...held, positions: [...held.positions, BROKEN] } }),
    request: request("POST", "/positions/pos-1/close", { exit: 1.25 }),
  },
  {
    name: "DELETE /positions/{id} deletes a holding with linked rules beside one that cannot be read",
    world: world({ tables: { ...held, positions: [...held.positions, BROKEN] } }),
    request: request("DELETE", "/positions/pos-1"),
  },
  {
    // every route that works from a holding's legs answers why, rather than a 500
    name: "PATCH /positions/{id} refuses to correct the legs of a holding that cannot be read",
    world: world({ tables: { positions: [BROKEN] } }),
    request: request("PATCH", "/positions/pos-9", {
      legs: [{ side: "short", option_type: "CALL", strike: 7500 }, { side: "long", option_type: "CALL", strike: 7550 }],
    }),
  },
  {
    name: "GET /positions/{id}/vol refuses a holding that cannot be read, saying why",
    world: world({ tables: { positions: [BROKEN] } }),
    request: request("GET", "/positions/pos-9/vol"),
  },
  {
    name: "GET /positions/{id}/payoff refuses a holding that cannot be read, saying why",
    world: world({ tables: { positions: [BROKEN] } }),
    request: request("GET", "/positions/pos-9/payoff"),
  },
  {
    name: "GET /positions/{id}/samples refuses a holding that cannot be read, saying why",
    world: world({ tables: { positions: [BROKEN] } }),
    request: request("GET", "/positions/pos-9/samples"),
  },
  {
    name: "GET /positions/values answers 502 naming the Provider when it is down",
    world: world({ tables: held, provider: { down: DOWN } }),
    request: request("GET", "/positions/values"),
  },
  {
    // one holding whose row cannot be read no longer fails the book (#422, the owner's decision of
    // what #266 answered with a 502): the rest is valued, and it is listed with no legs and no
    // figures, its reason in the reader's own words — which both backends must say alike
    name: "GET /positions/values values the book and lists a holding that cannot be read",
    world: world({
      tables: {
        positions: [
          position({ id: "pos-1" }),
          position({
            id: "pos-2", name: "dec-call-spread", entry: 2.5,
            legs: [
              { side: "sold", option_type: "CALL", strike: 7500 },
              { side: "long", option_type: "CALL", strike: 7550 },
            ],
          }),
        ],
      },
      provider: { quotes: BOOK },
    }),
    request: request("GET", "/positions/values"),
  },
  {
    // #380: outside the session the holding is valued from Friday's close, past Saturday's costless
    // row: its cost, P&L at the stored size, Levels and pace at the close's own 35 DTE, its greeks
    // from the legs' stored delta and vega (no gamma, no theta), SPX as stored, and the close's
    // observed time as its stamp — with the Provider DOWN, because nothing is asked of it
    name: "GET /positions/values outside the session values a holding from its last close, asking the Provider nothing",
    world: world({
      clock: SATURDAY,
      tables: { ...held, position_samples: [THU, FRI, SAT] },
      provider: { down: DOWN },
    }),
    request: request("GET", "/positions/values"),
  },
  {
    // the holding with a close is valued from it; the one with none is valued live — and only its
    // contracts are asked for, which out of hours come back with no book: a dash, never a 0
    name: "GET /positions/values outside the session values live only a holding with no close",
    world: world({
      clock: SATURDAY,
      tables: {
        positions: [
          position({ id: "pos-1" }),
          position({
            id: "pos-2", name: "dec-call-wing", strategy: "call spread", entry: 1.5, opened_at: "2026-11-13",
            legs: [
              { side: "short", option_type: "CALL", strike: 7350 },
              { side: "long", option_type: "CALL", strike: 7500 },
            ],
          }),
        ],
        position_samples: [FRI, SAT],
      },
      provider: { quotes: { ...OUT_OF_HOURS, [C7500]: { ...quote("SPXW 261218 7500C", 0.5, 0.06), mid_price: null, bid_price: 0, ask_price: 0 } } },
    }),
    request: request("GET", "/positions/values"),
  },
  {
    // a trade recorded in New York's evening has no close yet, only its first row, taken after the
    // close: no close (#416), so it values nothing, and the holding is valued live — the Provider
    // down, a dash
    name: "GET /positions/values outside the session values nothing from a reading after the close",
    world: world({
      clock: SATURDAY,
      tables: {
        positions: [position({ id: "pos-1", opened_at: "2026-11-13" })],
        position_samples: [
          closeRow("2026-11-13", 35, 3.5, "2026-11-14 01:30:00.000000"), // 20:30 New York
          SAT,
        ],
      },
      provider: { down: DOWN },
    }),
    request: request("GET", "/positions/values"),
  },
  {
    // ...and a close before a LATER reading that is not one: Friday's session was missed and its
    // row filled that evening, so Thursday's close is what the holding is valued from (F6)
    name: "GET /positions/values outside the session prefers the latest close to a later reading after the close",
    world: world({
      clock: SATURDAY,
      tables: {
        ...held,
        position_samples: [THU, closeRow("2026-11-13", 35, 3.5, "2026-11-14 01:30:00.000000"), SAT],
      },
      provider: { down: DOWN },
    }),
    request: request("GET", "/positions/values"),
  },
  {
    // a close summed before a leg's quantity was corrected is another structure's cost (#359): it
    // values nothing. Corrected on Friday evening, after both closes, so the holding has none left
    // and is valued live — out of hours, a dash
    name: "GET /positions/values outside the session skips a close summed before a quantity was corrected",
    world: world({
      clock: SATURDAY,
      tables: {
        positions: [position({ id: "pos-1", qty_corrected_at: "2026-11-14 01:00:00.000000" })],
        position_samples: [THU, FRI, SAT],
      },
      provider: { quotes: OUT_OF_HOURS },
    }),
    request: request("GET", "/positions/values"),
  },
  {
    // #387: out of the session a Provider that is down costs only the holding that needed it — a
    // dash with the reason — and the holding with a close is served from it, where this was a 502
    name: "GET /positions/values outside the session with the Provider down dashes only the holding with no close",
    world: world({
      clock: SATURDAY,
      tables: {
        positions: [
          position({ id: "pos-1" }),
          position({
            id: "pos-2", name: "dec-call-wing", strategy: "call spread", entry: 1.5, opened_at: "2026-11-13",
            legs: [
              { side: "short", option_type: "CALL", strike: 7350 },
              { side: "long", option_type: "CALL", strike: 7500 },
            ],
          }),
        ],
        position_samples: [FRI, SAT],
      },
      provider: { down: DOWN },
    }),
    request: request("GET", "/positions/values"),
  },
  {
    // ...and on a weekday night, which is no weekend: Tuesday 20:00 New York, Tuesday's close stored
    // for one holding and nothing for the other (#387 review)
    name: "GET /positions/values on a weekday night with the Provider down dashes only the holding with no close",
    world: world({
      clock: "2026-11-11T01:00:00.000Z",
      tables: {
        positions: [
          position({ id: "pos-1" }),
          position({
            id: "pos-2", name: "dec-call-wing", strategy: "call spread", entry: 1.5, opened_at: "2026-11-10",
            legs: [
              { side: "short", option_type: "CALL", strike: 7350 },
              { side: "long", option_type: "CALL", strike: 7500 },
            ],
          }),
        ],
        position_samples: [closeRow("2026-11-10", 38, 3.3, "2026-11-10 21:14:59.000000")],
      },
      provider: { down: DOWN },
    }),
    request: request("GET", "/positions/values"),
  },
  {
    // #416: Sunday 20:15:07 New York is Monday's GTH, and moomoo quotes SPX options live. The condor,
    // every leg quoted, is valued LIVE — never Friday's close — with SPX said stale beside its price;
    // the call wing, one leg with no two-sided quote, from its close, as when nothing trades
    name: "GET /positions/values overnight (GTH) values live where every leg is quoted, from the close where one is not",
    world: world({
      clock: GTH,
      tables: {
        positions: [position({ id: "pos-1" }), wing],
        position_samples: [FRI, closeRow("2026-11-13", 35, 1.25, "2026-11-13 21:14:59.000000", { position_id: "pos-2" })],
      },
      provider: { quotes: { ...PREMIUM_BOOK, [C7500]: { ...quote("SPXW 261218 7500C", 0.5, 0.06), mid_price: null, bid_price: 0, ask_price: 0 } } },
    }),
    request: request("GET", "/positions/values"),
  },
  {
    // ...and with the Provider down overnight, no 502 as in the session: every leg is unquoted, so
    // each holding is valued from its close
    name: "GET /positions/values overnight with the Provider down values each holding from its close",
    world: world({
      clock: GTH,
      tables: { positions: [position({ id: "pos-1" })], position_samples: [FRI] },
      provider: { down: DOWN },
    }),
    request: request("GET", "/positions/values"),
  },
  {
    // #416: the derived SPX overnight is the last close's level — moomoo's index quote stands still
    // and each premium is worked out against it — so it is said stale beside its price, never current
    name: "GET /quotes overnight says SPX is the last close's level beside its price",
    world: world({ clock: GTH, tables: held, provider: { quotes: PREMIUM_BOOK } }),
    request: request("GET", "/quotes"),
  },
  {
    // #416: rows the service priced overnight before the change — Sunday 20:15 and Monday 00:00 New
    // York — are served with no price: the burndown plots closes
    name: "GET /positions/{id}/samples serves no price read overnight",
    world: world({ clock: GTH_MONDAY, tables: { positions: [position({ id: "pos-1" })], position_samples: GTH_ROWS } }),
    request: request("GET", "/positions/pos-1/samples"),
  },
  {
    // ...and the pace gap is measured at Friday's close, past both
    name: "GET /positions/{id}/vol measures the gap at the last close, never at a price read overnight",
    world: world({ clock: GTH_MONDAY, tables: { positions: [position({ id: "pos-1" })], position_samples: GTH_ROWS } }),
    request: request("GET", "/positions/pos-1/vol"),
  },
  {
    // ...and a watched rule's history serves a day priced overnight (before migration 0015) with no
    // value: its chart plots closes (#416 review)
    name: "GET /monitors/{id}/samples serves no value for a day priced overnight",
    world: world({
      clock: GTH_MONDAY,
      tables: {
        monitors: [monitor({ id: "mon-1", field: "mid_price", threshold: 3 })],
        watch_samples: [
          watchDay([C7300], { observed_on: "2026-11-13", dte: 35, legs_mid: { [C7300]: 2.75 }, observed_at: "2026-11-13 21:14:59.000000" }),
          watchDay([C7300], { observed_on: "2026-11-15", dte: 33, legs_mid: { [C7300]: 3.4 }, observed_at: "2026-11-16 01:15:07.000000" }),
        ],
      },
      provider: { down: DOWN },
    }),
    request: request("GET", "/monitors/mon-1/samples"),
  },
  {
    // ...and a holding's days WATCHED before its entry, and its entry day's watched close, the same:
    // Sunday's GTH-priced watch day is served with no Cost to close, and Monday's — the day it was
    // entered, its own row costless — is no entry-day close (#416 review)
    name: "GET /positions/{id}/samples serves no watched price read overnight, before entry or as the entry day's close",
    world: world({
      clock: GTH_MONDAY,
      tables: {
        positions: [position({ id: "pos-1", opened_at: "2026-11-16" })],
        position_samples: [closeRow("2026-11-16", 32, null, "2026-11-16 05:00:06.000000")],
        watch_samples: [
          watchDay(condorCodes, { observed_on: "2026-11-13", dte: 35, legs_mid: legMap([2.75, 1.75, 4.5, 2.25]),
            observed_at: "2026-11-13 21:14:59.000000" }),
          watchDay(condorCodes, { observed_on: "2026-11-15", dte: 33, legs_mid: legMap([3, 2, 5, 2.5]),
            observed_at: "2026-11-16 01:15:07.000000" }),
          watchDay(condorCodes, { observed_on: "2026-11-16", dte: 32, legs_mid: legMap([3.25, 2, 5, 2.5]),
            observed_at: "2026-11-16 05:00:06.000000" }),
        ],
      },
      provider: { down: DOWN },
    }),
    request: request("GET", "/positions/pos-1/samples"),
  },
  {
    // ...and a watched rule's last close is Friday's, never the GTH mids stored after it
    name: "GET /monitors/closes never serves a price read overnight as a close",
    world: world({
      clock: GTH_MONDAY,
      tables: {
        monitors: [monitor({ id: "mon-1", field: "mid_price", threshold: 3 })],
        watch_samples: [
          watchDay([C7300], { observed_on: "2026-11-13", dte: 35, legs_mid: { [C7300]: 2.75 }, observed_at: "2026-11-13 21:14:59.000000" }),
          watchDay([C7300], { observed_on: "2026-11-15", dte: 33, legs_mid: { [C7300]: 3.4 }, observed_at: "2026-11-16 01:15:07.000000" }),
          watchDay([C7300], { observed_on: "2026-11-16", dte: 32, legs_mid: { [C7300]: 3.05 }, observed_at: "2026-11-16 05:00:06.000000" }),
        ],
      },
      provider: { down: DOWN },
    }),
    request: request("GET", "/monitors/closes"),
  },
  {
    // ...and where no holding has a close, every one is a dash with the reason, as out of hours it
    // would be with the Provider up: a 200, not the 502 the session still answers
    name: "GET /positions/values outside the session with the Provider down and no close dashes every holding",
    world: world({ clock: SATURDAY, tables: held, provider: { down: DOWN } }),
    request: request("GET", "/positions/values"),
  },
  {
    // #387, #416: a row priced in the hours on a Saturday is no close — by the session closeSample
    // asks, not by the hour — and values nothing
    name: "GET /positions/values outside the session never values from a weekend reading, which is no close",
    world: world({
      clock: SATURDAY,
      tables: {
        positions: [position({ id: "pos-1", opened_at: "2026-11-13" })],
        position_samples: [
          closeRow("2026-11-13", 35, 3.5, "2026-11-14 01:30:00.000000"), // Friday 20:30 New York
          closeRow("2026-11-14", 34, 3.4, "2026-11-14 16:00:00.000000"), // Saturday 11:00
        ],
      },
      provider: { down: DOWN },
    }),
    request: request("GET", "/positions/values"),
  },
  {
    // in the session the Provider's quote is the price, whatever is stored: unchanged by #380
    name: "GET /positions/values in the session values live though a close is stored",
    world: world({ tables: { ...held, position_samples: [THU, FRI] }, provider: { quotes: BOOK } }),
    request: request("GET", "/positions/values"),
  },
  {
    name: "GET /positions/values with nothing held asks the Provider nothing",
    world: world(),
    request: request("GET", "/positions/values"),
  },
  {
    name: "GET /positions/{id}/vol measures vol over the holding's own samples",
    world: world({
      tables: {
        positions: [opened],
        position_samples: [
          day("2026-11-06", 42, [14.5, 14, 19.25, 20]),
          day("2026-11-07", 41, [14.75, 14, 19.5, 20.25]),
          day("2026-11-08", 40, [15, 14.25, 19, 20]),
        ],
      },
    }),
    request: request("GET", "/positions/pos-1/vol"),
  },
  {
    // the chain must start on the day it was opened; this one starts later
    name: "GET /positions/{id}/vol says nothing when the samples do not reach back to the open",
    world: world({
      tables: {
        positions: [opened],
        position_samples: [day("2026-11-08", 40, [15, 14.25, 19, 20])],
      },
    }),
    request: request("GET", "/positions/pos-1/vol"),
  },
  {
    // the legs' vegas do not cancel, so it says what would cover the gap; and today's row was
    // observed at 09:45 with New York's hours still running, so it is no close yet (#333)
    name: "GET /positions/{id}/vol splits the gap and covers it, at a row in hours that are still running",
    world: world({
      tables: {
        positions: [opened],
        position_samples: [
          dayAt("2026-11-06", 42, 6.4, [14.5, 14, 19.25, 20], VEGAS, "2026-11-06 21:05:00.000000"),
          dayAt("2026-11-07", 41, 6.1, [14.75, 14, 19.5, 20.25], VEGAS, "2026-11-07 21:05:00.000000"),
          dayAt("2026-11-08", 40, 6.25, [15, 14.25, 19, 20], VEGAS, "2026-11-08 21:05:00.000000"),
          dayAt("2026-11-09", 39, 6.3, [15.25, 14.5, 19.5, 20.5], VEGAS, "2026-11-09 14:45:00.000000"),
        ],
      },
    }),
    request: request("GET", "/positions/pos-1/vol"),
  },
  {
    // opened this morning: one row, a true zero and no measurement
    name: "GET /positions/{id}/vol says nothing has moved on the day it was opened",
    world: world({
      tables: {
        positions: [position({ id: "pos-1", opened_at: "2026-11-09" })],
        position_samples: [
          dayAt("2026-11-09", 39, 6.4, [15.25, 14.5, 19.5, 20.5], VEGAS, "2026-11-09 14:45:00.000000"),
        ],
      },
    }),
    request: request("GET", "/positions/pos-1/vol"),
  },
  {
    // the weekend is missing: the chain is broken and the reason names the two days around it; the
    // Monday's row from 16:05 New York is that day's close, asked on the Tuesday
    name: "GET /positions/{id}/vol names a missing day, and still covers the gap at the last close",
    world: world({
      clock: "2026-11-10T15:00:00.000Z",
      tables: {
        positions: [opened],
        position_samples: [
          dayAt("2026-11-06", 42, 6.4, [14.5, 14, 19.25, 20], VEGAS, "2026-11-06 21:05:00.000000"),
          dayAt("2026-11-09", 39, 6.25, [15, 14.25, 19, 20], VEGAS, "2026-11-09 21:05:00.000000"),
        ],
      },
    }),
    request: request("GET", "/positions/pos-1/vol"),
  },
  {
    name: "GET /positions/{id}/vol on a holding that does not exist",
    world: world({ tables: held }),
    request: request("GET", "/positions/pos-9/vol"),
  },
  // --- the daily samples (#295): stored history, and no market data -----------------------
  {
    // the Provider is DOWN, so a route that asked it anything would fail. Opened at 42 DTE for a
    // 6.40 credit: a close, an evening fill of a missed session, an overnight fill nothing
    // replaced, and a row from before observed_at existed — each said by its `timing`
    name: "GET /positions/{id}/samples serves an open holding's days against its plan",
    world: world({
      tables: {
        positions: [opened],
        position_samples: [
          sample({
            position_id: "pos-1", observed_on: "2026-11-06", dte: 42, cost_to_close: 6.25,
            observed_at: "2026-11-06 21:00:00.000000", spx: 6812.5,
            legs_iv: { [C7300]: 14.5, [P6400]: 19.25 }, legs_vega: { [C7300]: 4.25, [P6400]: 4 },
            legs_delta: { [C7300]: 0.21, [P6400]: -0.18 },
          }),
          sample({
            position_id: "pos-1", observed_on: "2026-11-07", dte: 41, cost_to_close: 6,
            observed_at: "2026-11-08 01:30:00.000000",
          }),
          sample({
            position_id: "pos-1", observed_on: "2026-11-08", dte: 40, cost_to_close: 5.75,
            observed_at: "2026-11-08 05:05:00.000000",
          }),
          sample({ position_id: "pos-1", observed_on: "2026-11-05", dte: 43, cost_to_close: 6.5 }),
        ],
      },
      provider: { down: DOWN },
    }),
    request: request("GET", "/positions/pos-1/samples"),
  },
  {
    // each short strike against THAT day's SPX (#395), with the Provider down — stored history only.
    // A day with SPX and both IVs: points and σ. A day with SPX and one IV missing: that strike's
    // points and no σ. A day with IVs and no SPX: each strike placed and no distance at all
    name: "GET /positions/{id}/samples places each day's short strikes against that day's SPX",
    world: world({
      tables: {
        positions: [opened],
        position_samples: [
          sample({
            position_id: "pos-1", observed_on: "2026-11-06", dte: 42, cost_to_close: 6.25,
            observed_at: "2026-11-06 21:00:00.000000", spx: 6812.5,
            legs_iv: { [C7300]: 14.5, [P6400]: 19.25 }, legs_delta: { [C7300]: 0.21, [P6400]: -0.18 },
          }),
          sample({
            position_id: "pos-1", observed_on: "2026-11-07", dte: 41, cost_to_close: 6,
            observed_at: "2026-11-07 21:00:00.000000", spx: 6830.25, legs_iv: { [C7300]: 14.25 },
          }),
          sample({
            position_id: "pos-1", observed_on: "2026-11-08", dte: 40, cost_to_close: 5.75,
            observed_at: "2026-11-08 21:00:00.000000", legs_iv: { [C7300]: 14, [P6400]: 19 },
          }),
        ],
      },
      provider: { down: DOWN },
    }),
    request: request("GET", "/positions/pos-1/samples"),
  },
  {
    // closed on the last day sampled: its history whole, held against the same schedule
    name: "GET /positions/{id}/samples serves a closed holding's history",
    world: world({
      tables: {
        positions: [{ ...opened, closed_on: "2026-11-07", exit: 6 }],
        position_samples: [
          sample({ position_id: "pos-1", observed_on: "2026-11-06", dte: 42, cost_to_close: 6.25,
            observed_at: "2026-11-06 21:00:00.000000" }),
          sample({ position_id: "pos-1", observed_on: "2026-11-07", dte: 41, cost_to_close: 6,
            observed_at: "2026-11-07 21:00:00.000000" }),
        ],
      },
    }),
    request: request("GET", "/positions/pos-1/samples"),
  },
  {
    // the sweep sampled the 7th and 8th before the close was recorded as the 6th: those rows are
    // not its history, and they are kept (`rows` is empty)
    name: "GET /positions/{id}/samples hides the days after a backdated close",
    world: world({
      tables: {
        positions: [{ ...opened, closed_on: "2026-11-06", exit: 6.25 }],
        position_samples: [
          sample({ position_id: "pos-1", observed_on: "2026-11-06", dte: 42, cost_to_close: 6.25,
            observed_at: "2026-11-06 21:00:00.000000" }),
          sample({ position_id: "pos-1", observed_on: "2026-11-07", dte: 41, cost_to_close: 6,
            observed_at: "2026-11-07 21:00:00.000000" }),
          sample({ position_id: "pos-1", observed_on: "2026-11-08", dte: 40, cost_to_close: 5.75,
            observed_at: "2026-11-08 21:00:00.000000" }),
        ],
      },
    }),
    request: request("GET", "/positions/pos-1/samples"),
  },
  {
    // a stamp in another spelling and one that is no time at all: each row costs its own timing
    // and stamp, read as unrecorded, and the request answers (#295 review)
    name: "GET /positions/{id}/samples reads a stamp it cannot parse as unrecorded",
    world: world({
      tables: {
        positions: [opened],
        position_samples: [
          sample({ position_id: "pos-1", observed_on: "2026-11-06", dte: 42, cost_to_close: 6.25,
            observed_at: "2026-11-06T21:00:00Z" }),
          sample({ position_id: "pos-1", observed_on: "2026-11-07", dte: 41, cost_to_close: 6,
            observed_at: "not a time" }),
        ],
      },
    }),
    request: request("GET", "/positions/pos-1/samples"),
  },
  {
    name: "GET /positions/{id}/samples answers an empty history for a holding never sampled",
    world: world({ tables: { positions: [opened] } }),
    request: request("GET", "/positions/pos-1/samples"),
  },
  {
    // no Opened, so no schedule is inferred: the costs alone, with no plan and no Levels
    name: "GET /positions/{id}/samples serves no plan for a holding with no Opened",
    world: world({
      tables: {
        positions: [position({ id: "pos-1", opened_at: null })],
        position_samples: [sample({ position_id: "pos-1", observed_on: "2026-11-06", dte: 42,
          cost_to_close: 6.25, observed_at: "2026-11-06 21:00:00.000000" })],
      },
    }),
    request: request("GET", "/positions/pos-1/samples"),
  },
  {
    // the condor was watched for three days before it was entered on the 6th (#402): those days, by
    // the same contracts, valued as the holding's Cost to close — and the day it was entered is its
    // own, so the watch row for it is not served. The Provider is down: stored history only.
    name: "GET /positions/{id}/samples serves the days its contracts were watched before it was entered",
    world: world({
      tables: {
        positions: [opened],
        position_samples: [sample({ position_id: "pos-1", observed_on: "2026-11-06", dte: 42,
          cost_to_close: 6.25, observed_at: "2026-11-06 21:00:00.000000" })],
        watch_samples: [
          watchDay([C7300, C7350, P6400, P6350], {
            observed_on: "2026-11-04", dte: 44, observed_at: "2026-11-04 21:14:00.000000", spx: 6812.5,
            legs_mid: { [C7300]: 3, [C7350]: 2, [P6400]: 5, [P6350]: 2.5 },
            legs_iv: { [C7300]: 14.5, [C7350]: 14.25, [P6400]: 19.25, [P6350]: 20 },
          }),
          watchDay([C7300, C7350, P6400, P6350], {
            observed_on: "2026-11-05", dte: 43, observed_at: "2026-11-06 01:00:00.000000",
          }),
          watchDay([C7300, C7350, P6400, P6350], {
            observed_on: "2026-11-06", dte: 42, observed_at: "2026-11-06 21:14:00.000000",
            legs_mid: { [C7300]: 2.75, [C7350]: 1.75, [P6400]: 4.5, [P6350]: 2.25 },
          }),
        ],
      },
      provider: { down: DOWN },
    }),
    request: request("GET", "/positions/pos-1/samples"),
  },
  {
    // recorded in New York's evening: its own row for the day it was entered has no Cost to close
    // (moomoo's 0/0, #380), and the watch history has that day's close — served apart as
    // `entry_close`, its own row left as it is (owner's decision, 2026-11-15)
    name: "GET /positions/{id}/samples serves the entry day's watched close where its own has no cost",
    world: world({
      tables: {
        positions: [opened],
        position_samples: [sample({ position_id: "pos-1", observed_on: "2026-11-06", dte: 42,
          cost_to_close: null, observed_at: "2026-11-07 01:30:00.000000" })],
        watch_samples: [watchDay([C7300, C7350, P6400, P6350], {
          observed_on: "2026-11-06", dte: 42, observed_at: "2026-11-06 21:14:00.000000",
          legs_mid: { [C7300]: 2.75, [C7350]: 1.75, [P6400]: 4.5, [P6350]: 2.25 },
        })],
      },
      provider: { down: DOWN },
    }),
    request: request("GET", "/positions/pos-1/samples"),
  },
  {
    name: "GET /positions/{id}/samples on a holding that does not exist",
    world: world({ tables: held }),
    request: request("GET", "/positions/pos-9/samples"),
  },
  // --- the payoff at expiry (#291): legs, an Entry and a count, and no market data ---------
  {
    // the Provider is DOWN, so a payoff that asked it anything would fail; it answers, and asks
    // nothing (`calls` is empty)
    name: "GET /positions/{id}/payoff draws a holding's payoff with the Provider down",
    world: world({ tables: held, provider: { down: DOWN } }),
    request: request("GET", "/positions/pos-1/payoff"),
  },
  {
    name: "GET /positions/{id}/payoff on a holding that does not exist",
    world: world({ tables: held }),
    request: request("GET", "/positions/pos-9/payoff"),
  },
  {
    // a curve is drawn at a credit, and the put spread's was never recorded
    name: "GET /positions/{id}/payoff refuses a holding with no entry",
    world: world({ tables: wings }),
    request: request("GET", "/positions/pos-puts/payoff"),
  },
  {
    // the add form's preview: it writes nothing (`rows` is empty) and asks no Provider, which is
    // down, so the scenario fails if either backend asks it
    name: "POST /positions/payoff draws draft legs, writing nothing and asking no Provider",
    world: world({ tables: held, provider: { down: DOWN } }),
    request: request("POST", "/positions/payoff", {
      legs: [
        { side: "short", option_type: "PUT", strike: 6400 },
        { side: "long", option_type: "PUT", strike: 6350 },
      ],
      entry: 1.85, contracts: 2,
    }),
  },
  {
    // the add form's preview of a butterfly (#351): a tent on the middle strike, sold twice over
    name: "POST /positions/payoff draws a butterfly's middle leg twice",
    world: world({ provider: { down: DOWN } }),
    request: request("POST", "/positions/payoff", {
      legs: [
        { side: "long", option_type: "CALL", strike: 7300 }, { side: "short", option_type: "CALL", strike: 7350, qty: 2 },
        { side: "long", option_type: "CALL", strike: 7400 },
      ],
      entry: -1.25,
    }),
  },
  {
    // a wrong leg sign, which is what the preview is for: a credit on a spread that was bought
    // can never lose, and its lowest P&L says so by being positive
    name: "POST /positions/payoff shows a wrong-sign leg as a credit that cannot be lost",
    world: world(),
    request: request("POST", "/positions/payoff", {
      legs: [
        { side: "long", option_type: "PUT", strike: 6400 },
        { side: "short", option_type: "PUT", strike: 6350 },
      ],
      entry: 1.85,
    }),
  },
  {
    // a strike of zero is no contract, and the payoff's left end is SPX at zero
    name: "POST /positions/payoff refuses a strike that is not above zero",
    world: world(),
    request: request("POST", "/positions/payoff", {
      legs: [{ side: "short", option_type: "PUT", strike: 0 }], entry: 1,
    }),
  },
  {
    name: "POST /positions/payoff refuses draft legs with no entry",
    world: world(),
    request: request("POST", "/positions/payoff", {
      legs: [{ side: "short", option_type: "PUT", strike: 6400 }],
    }),
  },
  {
    name: "PATCH /positions/{id} records the entry and the day it was opened",
    world: world({ tables: held }),
    request: request("PATCH", "/positions/pos-1", { entry: 6.5, opened_at: "20261013" }),
  },
  {
    name: "PATCH /positions/{id} refuses an empty change",
    world: world({ tables: held }),
    request: request("PATCH", "/positions/pos-1", {}),
  },
  {
    name: "PATCH /positions/{id} on a holding that does not exist",
    world: world({ tables: held }),
    request: request("PATCH", "/positions/pos-9", { entry: 6.5 }),
  },
  {
    // ADR 0022: the holding and its samples are KEPT; the rules watching it go off and forget it
    name: "POST /positions/{id}/close keeps the holding and its samples and switches off its rules",
    world: world({
      tables: {
        ...held, position_samples: [sample({ position_id: "pos-1", observed_on: "2026-11-06" })],
      },
    }),
    request: request("POST", "/positions/pos-1/close", { exit: 1.25 }),
  },
  {
    // left out, the day is the clock's own New York market date, and a blank exit stays blank
    name: "POST /positions/{id}/close with nothing said closes it today with no exit",
    world: world({ tables: { positions: [position({ id: "pos-1" })] } }),
    request: request("POST", "/positions/pos-1/close", {}),
  },
  {
    // the roll: a new spread shares the short call, so the rule watching it is handed to the new
    // holding and stays ON — a review found it switched off, silencing the new trade's alarm
    name: "POST /positions/{id}/close hands a rule to the holding that still holds its contract",
    world: world({
      tables: {
        positions: [
          position({ id: "pos-1" }),
          position({
            id: "pos-2", name: "dec-call-spread-rolled", entry: 2.5,
            legs: [
              { side: "short", option_type: "CALL", strike: 7300 },
              { side: "long", option_type: "CALL", strike: 7500 },
            ],
          }),
        ],
        monitors: [monitor({ id: "mon-1", scope: "leg" })],
        monitor_positions: [link("mon-1", "pos-1")],
      },
    }),
    request: request("POST", "/positions/pos-1/close", { exit: 1.25 }),
  },
  {
    // 02:00 UTC on the 10th is 21:00 on the 9th in New York, so the day is the 9th
    name: "POST /positions/{id}/close takes the New York day, not the UTC one",
    world: world({
      clock: "2026-11-10T02:00:00.000Z",
      tables: { positions: [position({ id: "pos-1" })] },
    }),
    request: request("POST", "/positions/pos-1/close", { exit: 1.25 }),
  },
  {
    name: "POST /positions/{id}/close refuses a day before the holding was opened",
    world: world({ tables: held }),
    request: request("POST", "/positions/pos-1/close", { exit: 1.25, closed_on: "2026-10-11" }),
  },
  {
    name: "POST /positions/{id}/close refuses a holding already closed",
    world: world({
      tables: { positions: [position({ id: "pos-1", closed_on: "2026-11-06", exit: 1.25 })] },
    }),
    request: request("POST", "/positions/pos-1/close", { exit: 0.5 }),
  },
  {
    name: "POST /positions/{id}/close on a holding that does not exist",
    world: world({ tables: held }),
    request: request("POST", "/positions/pos-9/close", { exit: 1.25 }),
  },
  {
    // a closed holding is listed with what it made, and valued no longer: the batch asks only
    // for what is still held
    name: "GET /positions/values leaves a closed holding out of the batch",
    world: world({
      tables: {
        positions: [
          position({ id: "pos-1" }),
          position({
            id: "pos-2", name: "dec-call-spread", entry: 2.5, closed_on: "2026-11-06", exit: 0.75,
            legs: [
              { side: "short", option_type: "CALL", strike: 7500 },
              { side: "long", option_type: "CALL", strike: 7550 },
            ],
          }),
        ],
      },
      provider: { quotes: BOOK },
    }),
    request: request("GET", "/positions/values"),
  },
  {
    // a mistyped close is corrected rather than deleted, so the samples survive it
    name: "PATCH /positions/{id} corrects a closed holding's exit and close day",
    world: world({
      tables: {
        positions: [position({ id: "pos-1", closed_on: "2026-11-06", exit: 1.25 })],
        position_samples: [sample({ position_id: "pos-1", observed_on: "2026-11-05" })],
      },
    }),
    request: request("PATCH", "/positions/pos-1", { exit: 1.5, closed_on: "2026-11-05" }),
  },
  {
    // a close may leave the exit blank, so a correction may put it back to blank
    name: "PATCH /positions/{id} clears a closed holding's exit back to blank",
    world: world({
      tables: { positions: [position({ id: "pos-1", closed_on: "2026-11-06", exit: 1.25 })] },
    }),
    request: request("PATCH", "/positions/pos-1", { exit: null }),
  },
  {
    // #359: a 1×3 typed where a 1×2 was meant is corrected in place, so its samples survive it. Its
    // value rule takes the new quantity and is a new rule, unrung; the short leg's Δ rule is one
    // contract's whatever the quantity, and keeps everything
    name: "PATCH /positions/{id} corrects a held 1×3 to a 1×2, keeping its samples, and its rules follow",
    world: world({ tables: typed13 }),
    request: request("PATCH", "/positions/pos-ratio", {
      legs: [
        { side: "short", option_type: "PUT", strike: 6350, qty: 2 }, { side: "long", option_type: "PUT", strike: 6400 },
      ],
    }),
  },
  {
    // a rule that valued other quantities is not re-quantified; it is given the scope it now has
    name: "PATCH /positions/{id} corrects a held 1×2 to a 1×1, and a 1×1 rule on it becomes all of it",
    world: world({
      tables: {
        ...ratioHeld,
        monitors: [...ratioHeld.monitors, combo({
          id: "mon-w11", code: "w11", scope: "leg", triggered: 1,
          legs: [{ sign: 1, option_type: "PUT", strike: 6400 }, { sign: -1, option_type: "PUT", strike: 6350 }],
        })],
        monitor_positions: [...ratioHeld.monitor_positions, link("mon-w11", "pos-ratio")],
      },
    }),
    request: request("PATCH", "/positions/pos-ratio", {
      legs: [{ side: "long", option_type: "PUT", strike: 6400 }, { side: "short", option_type: "PUT", strike: 6350 }],
    }),
  },
  {
    name: "PATCH /positions/{id} refuses legs of another structure",
    world: world({ tables: typed13 }),
    request: request("PATCH", "/positions/pos-ratio", {
      legs: [
        { side: "long", option_type: "PUT", strike: 6400 }, { side: "short", option_type: "PUT", strike: 6300, qty: 2 },
      ],
    }),
  },
  {
    name: "PATCH /positions/{id} refuses a leg's quantity above ten",
    world: world({ tables: typed13 }),
    request: request("PATCH", "/positions/pos-ratio", {
      legs: [
        { side: "long", option_type: "PUT", strike: 6400 }, { side: "short", option_type: "PUT", strike: 6350, qty: 11 },
      ],
    }),
  },
  {
    // a closed holding's legs are the record it closed with, and no rule is linked to follow them
    name: "PATCH /positions/{id} refuses to correct a closed holding's quantity",
    world: world({
      tables: { positions: [position({ id: "pos-ratio", name: "dec-ratio", legs: TYPED13, closed_on: "2026-11-06", exit: 0.25 })] },
    }),
    request: request("PATCH", "/positions/pos-ratio", {
      legs: [
        { side: "long", option_type: "PUT", strike: 6400 }, { side: "short", option_type: "PUT", strike: 6350, qty: 2 },
      ],
    }),
  },
  {
    // the rows observed before the correction were summed under the 1×3, and are kept as they were
    name: "GET /positions/{id}/samples marks the days summed before a leg's quantity was corrected",
    world: world({
      tables: {
        positions: [{ ...opened, qty_corrected_at: "2026-11-08 15:00:00.000000" }],
        position_samples: [
          day("2026-11-06", 42, [14.5, 14, 19.25, 20]),
          dayAt("2026-11-07", 41, 6.1, [14.75, 14, 19.5, 20.25], VEGAS, "2026-11-07 21:05:00.000000"),
          dayAt("2026-11-08", 40, 6.25, [15, 14.25, 19, 20], VEGAS, "2026-11-08 21:05:00.000000"),
        ],
      },
    }),
    request: request("GET", "/positions/pos-1/samples"),
  },
  {
    // the vol part is re-measured under the corrected quantities from per-contract readings; the
    // gap is read off a Cost to close summed before the correction, and is withheld
    name: "GET /positions/{id}/vol withholds a gap read off a day summed before a correction",
    world: world({
      tables: {
        positions: [{ ...opened, qty_corrected_at: "2026-11-09 14:50:00.000000" }],
        // the weekend's rows with no price, as the sweep keeps them (#416); Monday's in the session
        position_samples: [
          dayAt("2026-11-06", 42, 6.4, [14.5, 14, 19.25, 20], VEGAS, "2026-11-06 21:05:00.000000"),
          dayAt("2026-11-07", 41, null, [14.75, 14, 19.5, 20.25], VEGAS, "2026-11-07 21:05:00.000000"),
          dayAt("2026-11-08", 40, null, [15, 14.25, 19, 20], VEGAS, "2026-11-08 21:05:00.000000"),
          dayAt("2026-11-09", 39, 6.3, [15.25, 14.5, 19.5, 20.5], VEGAS, "2026-11-09 14:45:00.000000"),
        ],
      },
    }),
    request: request("GET", "/positions/pos-1/vol"),
  },
  {
    name: "PATCH /positions/{id} refuses an exit on a holding still held",
    world: world({ tables: held }),
    request: request("PATCH", "/positions/pos-1", { exit: 1.25 }),
  },
  {
    // a backdated close: the sweep sampled it after the day it was sold, and those rows are
    // ignored by the measurement — and kept
    name: "GET /positions/{id}/vol measures a closed holding only to the day it closed",
    world: world({
      tables: {
        positions: [{ ...opened, closed_on: "2026-11-07", exit: 1.25 }],
        position_samples: [
          day("2026-11-06", 42, [14.5, 14, 19.25, 20]),
          day("2026-11-07", 41, [14.75, 14, 19.5, 20.25]),
          day("2026-11-08", 40, [15, 14.25, 19, 20]),
        ],
      },
    }),
    request: request("GET", "/positions/pos-1/vol"),
  },
  {
    name: "GET /positions lists a closed holding with what it made",
    world: world({
      tables: { positions: [position({ id: "pos-1", closed_on: "2026-11-06", exit: 1.25 })] },
    }),
    request: request("GET", "/positions"),
  },
  {
    // the rules survive and forget the scope they had; the samples go with the holding
    name: "DELETE /positions/{id} removes the holding with its links and samples and keeps the rules",
    world: world({
      tables: {
        ...held, position_samples: [sample({ position_id: "pos-1", observed_on: "2026-11-06" })],
      },
    }),
    request: request("DELETE", "/positions/pos-1"),
  },
  {
    name: "DELETE /positions/{id} on a holding that does not exist",
    world: world({ tables: held }),
    request: request("DELETE", "/positions/pos-9"),
  },

  // --- /spreads (#293): a spread and its Monitors in one step, all of it or none ---------------
  {
    // the condor the old form took 34 clicks to enter: two spreads held, each with its two usual
    // Monitors — the value at 2x its Entry and the short leg's delta at 0.30 — every leg probed in
    // ONE call, and each rule linked to its own holding
    name: "POST /spreads records a condor as two holdings with their four Monitors",
    world: world({ provider: { quotes: BOOK } }),
    request: request("POST", "/spreads", { strike_date: EXPIRY, spreads: [PUT_SPREAD, CALL_SPREAD] }),
  },
  {
    // a candidate is watched, not held: its entry signals and no holding
    name: "POST /spreads watches a spread with its entry thresholds and records no holding",
    world: world({ provider: { quotes: BOOK } }),
    request: request("POST", "/spreads", {
      strike_date: EXPIRY,
      spreads: [{
        name: "dec-puts", held: false, legs: PUT_SPREAD.legs,
        monitors: [{ threshold: 2.5 }, { option_type: "PUT", strike: 6400, threshold: 0.15 }],
      }],
    }),
  },
  {
    // the form leaves a default it was told to switch off out of the request, and nothing makes it
    name: "POST /spreads creates no Monitor that was switched off",
    world: world({ provider: { quotes: BOOK } }),
    request: request("POST", "/spreads", {
      strike_date: EXPIRY, spreads: [{ ...PUT_SPREAD, monitors: [PUT_SPREAD.monitors[1]] }],
    }),
  },
  {
    // one Contract refused and the other spread, which the Provider knows, is not written either
    name: "POST /spreads writes nothing when the Provider refuses one leg",
    world: world({ provider: { quotes: except(BOOK, C7350), unknown: [C7350] } }),
    request: request("POST", "/spreads", { strike_date: EXPIRY, spreads: [PUT_SPREAD, CALL_SPREAD] }),
  },
  {
    // decided before the Provider is asked, so it is asked nothing
    name: "POST /spreads writes nothing when one Monitor is invalid, asking the Provider nothing",
    world: world({ provider: { quotes: BOOK } }),
    request: request("POST", "/spreads", {
      strike_date: EXPIRY,
      spreads: [PUT_SPREAD, { ...CALL_SPREAD, monitors: [CALL_SPREAD.monitors[0], { ...CALL_SPREAD.monitors[1], threshold: 0 }] }],
    }),
  },
  {
    name: "POST /spreads refuses a Monitor on a contract that is not one of the spread's legs",
    world: world({ provider: { quotes: BOOK } }),
    request: request("POST", "/spreads", {
      strike_date: EXPIRY,
      spreads: [{ ...PUT_SPREAD, monitors: [{ option_type: "PUT", strike: 6300, threshold: 0.3 }] }],
    }),
  },
  {
    name: "POST /spreads refuses a watched spread that carries a holding's Entry",
    world: world({ provider: { quotes: BOOK } }),
    request: request("POST", "/spreads", {
      strike_date: EXPIRY, spreads: [{ ...PUT_SPREAD, held: false }],
    }),
  },
  {
    name: "POST /spreads refuses a holding's name already held, without asking the Provider",
    world: world({ tables: held, provider: { quotes: BOOK } }),
    request: request("POST", "/spreads", {
      strike_date: EXPIRY, spreads: [{ ...PUT_SPREAD, name: "dec-condor" }],
    }),
  },
  {
    // a watched spread replaces nothing: the short call's delta is already watched, so its default
    // would be a second rule on it, and the whole request is refused
    name: "POST /spreads refuses a Monitor that is already there, without asking the Provider",
    world: world({ tables: { monitors: [monitor({ id: "mon-1" })] }, provider: { quotes: BOOK } }),
    request: request("POST", "/spreads", {
      strike_date: EXPIRY,
      spreads: [{ name: "dec-calls", held: false, legs: CALL_SPREAD.legs, monitors: CALL_SPREAD.monitors }],
    }),
  },
  {
    // the candidate the owner watched has been sold: its watch rules, linked to no holding, are
    // deleted and the holding's own made in their place — a deletion the owner asked for by saving
    name: "POST /spreads replaces the watch rules a held spread clashes with",
    world: world({ tables: { monitors: WATCHING_PUTS }, provider: { quotes: BOOK } }),
    request: request("POST", "/spreads", { strike_date: EXPIRY, spreads: [PUT_SPREAD] }),
  },
  {
    // only a Monitor the request MAKES replaces one: the delta default switched off leaves the watch
    // rule on the short put alone, and the new holding then adopts it, as POST /positions would
    name: "POST /spreads leaves the watch rule of a default switched off, and the holding adopts it",
    world: world({ tables: { monitors: WATCHING_PUTS }, provider: { quotes: BOOK } }),
    request: request("POST", "/spreads", {
      strike_date: EXPIRY, spreads: [{ ...PUT_SPREAD, monitors: [PUT_SPREAD.monitors[0]] }],
    }),
  },
  {
    // the short call's delta rule belongs to the condor already held: a 409, and nothing written
    name: "POST /spreads refuses a clash with a rule another holding owns",
    world: world({ tables: held, provider: { quotes: BOOK } }),
    request: request("POST", "/spreads", {
      strike_date: EXPIRY, spreads: [{ ...CALL_SPREAD, name: "dec-call-spread" }],
    }),
  },
  {
    // scaling in on the condor's put strikes: the new holding's own rules are linked to IT, not
    // left unlinked because two open holdings now hold those contracts
    name: "POST /spreads links a new holding's Monitors to it when another holding shares its legs",
    world: world({ tables: { positions: [position({ id: "pos-1" })] }, provider: { quotes: BOOK } }),
    request: request("POST", "/spreads", { strike_date: EXPIRY, spreads: [PUT_SPREAD] }),
  },
  // one contract, as the add form's "one contract" sends it (#331): a spread of one leg and the one
  // Monitor naming that leg, on any field, direction and compare
  {
    // the strike the owner watched has been sold: its watch rule, linked to no holding, is replaced
    // by the holding's own, as a held spread's are (#322)
    name: "POST /spreads records one contract held, replacing the watch rule on it",
    world: world({ tables: { monitors: [WATCHING_PUTS[1]!] }, provider: { quotes: BOOK } }),
    request: request("POST", "/spreads", { strike_date: EXPIRY, spreads: [ONE_PUT] }),
  },
  {
    // the watch rule was RINGING, its alarm sent: the holding's rule watches the same figure the same
    // way at another threshold, so it keeps the bell, as a PATCH moving the threshold alone keeps it
    // (#292) — remade fresh, the next sweep would say "crossed" a second time (#336)
    name: "POST /spreads carries a ringing watch rule's alarm over to the holding's rule watching it the same way",
    world: world({
      tables: { monitors: [{ ...WATCHING_PUTS[1]!, triggered: 1, last_alarm_at: "2026-11-09 14:45:00.000000", last_value: -0.21 }] },
      provider: { quotes: BOOK },
    }),
    request: request("POST", "/spreads", { strike_date: EXPIRY, spreads: [ONE_PUT] }),
  },
  {
    // the same, but the holding's rule watches its size from BELOW: another rule, which a PATCH
    // changing the direction would also make unrung (#292)
    name: "POST /spreads starts the alarm afresh where the holding's rule watches another way",
    world: world({
      tables: { monitors: [{ ...WATCHING_PUTS[1]!, triggered: 1, last_alarm_at: "2026-11-09 14:45:00.000000", last_value: -0.21 }] },
      provider: { quotes: BOOK },
    }),
    request: request("POST", "/spreads", {
      strike_date: EXPIRY, spreads: [{ ...ONE_PUT, monitors: [{ ...ONE_PUT.monitors[0]!, direction: "below" }] }],
    }),
  },
  {
    // the 7300 call sold from a watchlist that also watches the 7300/7350 call spread `cs` and the
    // 6400 put: the call's watch rule is replaced, and the ADOPTION that follows every POST /spreads
    // links `cs` to the new holding as covering all of it — the spread's row then reads the one
    // call's Entry. The dashboard names both before the save (#336); this is what it is held to.
    name: "POST /spreads records one contract held, and a watched spread holding it is linked to it",
    world: world({
      tables: {
        monitors: [
          combo({ id: "mon-cs", code: "cs" }),
          monitor({ id: "mon-c7300" }),
          monitor({ id: "mon-p6400", option_type: "PUT", strike: 6400, threshold: 0.15 }),
        ],
      },
      provider: { quotes: BOOK },
    }),
    request: request("POST", "/spreads", {
      strike_date: EXPIRY,
      spreads: [{
        name: "1218_C7300", held: true, entry: 2.75, contracts: 1, opened_at: "2026-11-06",
        legs: [{ side: "short", option_type: "CALL", strike: 7300 }],
        monitors: [{ option_type: "CALL", strike: 7300, field: "option_delta", threshold: 0.3, direction: "above", compare: "abs" }],
      }],
    }),
  },
  {
    // "Record as held" from the watched call spread `dec-calls` (#408): its value rule and its short
    // leg's Δ are REPLACED by the holding's own; its Θ and its long leg's Δ are on nothing the save
    // makes, so the adoption that follows every POST /spreads takes them over AS THEY ARE — the Θ as
    // covering all of it, the long leg's Δ as one leg of it. The dashboard names both before the save.
    name: "POST /spreads takes over a watched spread's theta and its long leg's delta, kept as they are",
    world: world({
      tables: {
        monitors: [
          combo({ id: "mon-value" }),
          combo({ id: "mon-theta", field: "option_theta", threshold: 0.5 }),
          monitor({ id: "mon-c7300" }),
          monitor({ id: "mon-c7350", strike: 7350, threshold: 0.1 }),
        ],
      },
      provider: { quotes: BOOK },
    }),
    request: request("POST", "/spreads", {
      strike_date: EXPIRY,
      spreads: [{
        name: "dec-calls", held: true, entry: 1, contracts: 1, opened_at: "2026-11-06",
        legs: [{ side: "short", option_type: "CALL", strike: 7300 }, { side: "long", option_type: "CALL", strike: 7350 }],
        monitors: [{ threshold: -2, direction: "below", compare: "signed" }, { option_type: "CALL", strike: 7300, threshold: 0.3 }],
      }],
    }),
  },
  {
    // the condor already holds the 6400 put: the lone holding's rule is linked to IT, never to the
    // condor, and the condor gains no rule nobody asked for
    name: "POST /spreads links one contract's rule to its own holding when another holding holds that strike",
    world: world({ tables: { positions: [position({ id: "pos-1" })] }, provider: { quotes: BOOK } }),
    request: request("POST", "/spreads", { strike_date: EXPIRY, spreads: [ONE_PUT] }),
  },
  {
    // a strike nothing holds, watched on its IV, signed and below: one contract's IV is its own,
    // where a spread's would be a sum and is refused
    name: "POST /spreads watches one contract's IV",
    world: world({ provider: { quotes: WIDE } }),
    request: request("POST", "/spreads", {
      strike_date: EXPIRY,
      spreads: [{
        name: "1218_C7500", held: false, legs: [{ side: "short", option_type: "CALL", strike: 7500 }],
        monitors: [{
          option_type: "CALL", strike: 7500, field: "option_implied_volatility", threshold: 18,
          direction: "below", compare: "signed",
        }],
      }],
    }),
  },
  {
    name: "POST /spreads refuses a monitor on a field that is not a figure a quote carries",
    world: world({ provider: { quotes: BOOK } }),
    request: request("POST", "/spreads", {
      strike_date: EXPIRY,
      spreads: [{ ...PUT_SPREAD, monitors: [{ option_type: "PUT", strike: 6400, field: "update_time", threshold: 1 }] }],
    }),
  },
  {
    name: "POST /spreads refuses a spread's own monitor on a field that is not a figure a quote carries",
    world: world({ provider: { quotes: BOOK } }),
    request: request("POST", "/spreads", {
      strike_date: EXPIRY, spreads: [{ ...PUT_SPREAD, monitors: [{ field: "name", threshold: 1 }] }],
    }),
  },
  {
    name: "POST /spreads refuses a spread with no name",
    world: world(),
    request: request("POST", "/spreads", { strike_date: EXPIRY, spreads: [{ ...PUT_SPREAD, name: "" }] }),
  },
  {
    name: "POST /spreads refuses a spread naming one contract twice",
    world: world(),
    request: request("POST", "/spreads", {
      strike_date: EXPIRY, spreads: [{ ...PUT_SPREAD, legs: [PUT_SPREAD.legs[0], PUT_SPREAD.legs[0]] }],
    }),
  },
  {
    name: "POST /spreads refuses a spread both short and long one contract",
    world: world(),
    request: request("POST", "/spreads", {
      strike_date: EXPIRY,
      spreads: [{ ...PUT_SPREAD, legs: [PUT_SPREAD.legs[0], { ...PUT_SPREAD.legs[0], side: "long" }] }],
    }),
  },
  {
    // at most eight spreads of at most six legs, and 32 legs in all: the one probe stays small
    name: "POST /spreads refuses more than eight spreads",
    world: world(),
    request: request("POST", "/spreads", {
      strike_date: EXPIRY,
      spreads: Array.from({ length: 9 }, (_, i) => ({ ...PUT_SPREAD, name: `dec-puts-${i}` })),
    }),
  },
  {
    // six legs is the most a spread may have, as the old dashboard's combo builder took (#334)
    name: "POST /spreads records a six-leg spread with its value and both short legs' delta Monitors",
    world: world({ provider: { quotes: SIX_BOOK } }),
    request: request("POST", "/spreads", {
      strike_date: EXPIRY,
      spreads: [{
        name: "dec-six", held: true, entry: 3.5, opened_at: "2026-11-06", legs: SIX_LEGS,
        monitors: [
          { threshold: 7 },
          { option_type: "PUT", strike: 6400, threshold: 0.3 }, { option_type: "CALL", strike: 7300, threshold: 0.3 },
        ],
      }],
    }),
  },
  {
    name: "POST /spreads refuses a spread of more than six legs",
    world: world(),
    request: request("POST", "/spreads", {
      strike_date: EXPIRY,
      spreads: [{ ...PUT_SPREAD, legs: [...SIX_LEGS, { side: "long", option_type: "CALL", strike: 7600 }] }],
    }),
  },
  {
    // six-leg spreads, each within the schema, but 36 legs in all: refused before the one probe,
    // and before anything else the request says about itself — two of them share a name, which
    // is refused too, but not first
    name: "POST /spreads refuses more than 32 legs in all, first and asking the Provider nothing",
    world: world({ provider: { quotes: SIX_BOOK } }),
    request: request("POST", "/spreads", {
      strike_date: EXPIRY,
      spreads: Array.from({ length: 6 }, (_, i) => ({ ...PUT_SPREAD, name: `dec-six-${i % 5}`, legs: SIX_LEGS, monitors: [] })),
    }),
  },
  // a quantity per leg (#351): one leg per contract, the quantity on the holding and on its rule
  {
    name: "POST /spreads records a 1×2 ratio held, its short leg's quantity on the holding and its rule",
    world: world({ provider: { quotes: BOOK } }),
    request: request("POST", "/spreads", { strike_date: EXPIRY, spreads: [RATIO] }),
  },
  {
    name: "POST /spreads watches a butterfly, asking for each contract once",
    world: world({ provider: { quotes: FLY_BOOK } }),
    request: request("POST", "/spreads", { strike_date: EXPIRY, spreads: [FLY] }),
  },
  {
    // ADOPTION, run: a 1×1 watched on the ratio's strikes is linked to the new holding as part of it
    // ("leg"), never as all of it — it values another structure (#351)
    name: "POST /spreads adopts a 1×1 watched on a held 1×2's strikes as part of it",
    world: world({
      tables: { monitors: [combo({
        id: "mon-one", code: "dec-one",
        legs: [{ sign: 1, option_type: "PUT", strike: 6400 }, { sign: -1, option_type: "PUT", strike: 6350 }],
      })] },
      provider: { quotes: BOOK },
    }),
    request: request("POST", "/spreads", { strike_date: EXPIRY, spreads: [RATIO] }),
  },
  {
    // and the other way round: a 1×2 watched, then the 1×1 put spread held on its strikes
    name: "POST /spreads adopts a 1×2 watched on a held 1×1's strikes as part of it",
    world: world({
      tables: { monitors: [combo({
        id: "mon-ratio", code: "dec-ratio",
        legs: [{ sign: 1, option_type: "PUT", strike: 6400 }, { sign: -1, option_type: "PUT", strike: 6350, qty: 2 }],
      })] },
      provider: { quotes: BOOK },
    }),
    request: request("POST", "/spreads", {
      strike_date: EXPIRY,
      spreads: [{ ...PUT_SPREAD, monitors: [PUT_SPREAD.monitors[1]] }],
    }),
  },
  {
    // a two-leg 1×1 is still named as #293 named it (#351), so the watch rule saved under that name
    // is the one the held spread replaces: the form posts this name, and the rule goes
    name: "POST /spreads replaces a watch rule saved under the 1×1 spread's derived name",
    world: world({
      tables: { monitors: [combo({
        id: "mon-watch-value", code: "1218_P6400_P6350", threshold: 2.5,
        legs: [{ sign: -1, option_type: "PUT", strike: 6400 }, { sign: 1, option_type: "PUT", strike: 6350 }],
      })] },
      provider: { quotes: BOOK },
    }),
    request: request("POST", "/spreads", {
      strike_date: EXPIRY, spreads: [{ ...PUT_SPREAD, name: "1218_P6400_P6350" }],
    }),
  },
  {
    name: "POST /spreads refuses a quantity of none, asking the Provider nothing",
    world: world({ provider: { quotes: BOOK } }),
    request: request("POST", "/spreads", {
      strike_date: EXPIRY, spreads: [{ ...RATIO, legs: [RATIO.legs[0], { ...RATIO.legs[1], qty: 0 }] }],
    }),
  },
  {
    name: "POST /spreads refuses a quantity of more than ten, asking the Provider nothing",
    world: world({ provider: { quotes: BOOK } }),
    request: request("POST", "/spreads", {
      strike_date: EXPIRY, spreads: [{ ...RATIO, legs: [RATIO.legs[0], { ...RATIO.legs[1], qty: 11 }] }],
    }),
  },
  {
    name: "POST /spreads refuses a request with no spreads in it",
    world: world(),
    request: request("POST", "/spreads", { strike_date: EXPIRY, spreads: [] }),
  },

  // --- /references ------------------------------------------------------------------------
  {
    // one bounded call per source in use, and a source this build lacks dashes only its own row
    name: "GET /references reads each Reference from its own source",
    world: world({
      tables: references,
      provider: { quotes: { "US.SPY": SPY } },
      sources: { yahoo: { quotes: { "^VIX": VIX } } },
    }),
    request: request("GET", "/references"),
  },
  {
    // moomoo refuses a whole batch over one code it will not price: the rest still read
    name: "GET /references retries one code at a time when a source refuses the batch",
    world: world({
      tables: {
        reference_securities: [
          reference({ id: "ref-1", code: "US.SPY" }),
          reference({ id: "ref-2", code: "US..SPX", created_at: "2026-11-02 14:31:00.000000" }),
        ],
      },
      provider: { quotes: { "US.SPY": SPY }, rejects: { "US..SPX": "unknown stock US..SPX" } },
    }),
    request: request("GET", "/references"),
  },
  {
    // the one route that cannot fail: the page it decorates must still draw
    name: "GET /references still answers when the Provider is down",
    world: world({
      tables: { reference_securities: [reference({ id: "ref-1", code: "US.SPY" })] },
      provider: { down: DOWN },
    }),
    request: request("GET", "/references"),
  },
  {
    name: "POST /references keeps a Security once its own source confirms it",
    world: world({ sources: { yahoo: { quotes: { "^VIX": VIX } } } }),
    request: request("POST", "/references", { code: "^vix", label: "VIX", source: "yahoo" }),
  },
  {
    name: "POST /references refuses a code already kept",
    world: world({ tables: references, provider: { quotes: { "US.SPY": SPY } } }),
    request: request("POST", "/references", { code: "US.SPY", source: "moomoo" }),
  },
  {
    name: "POST /references refuses a source this build cannot reach",
    world: world(),
    request: request("POST", "/references", { code: "VIX", source: "ibkr" }),
  },
  {
    name: "POST /references refuses a code its source does not know",
    world: world({ provider: { unknown: ["US..SPX"] } }),
    request: request("POST", "/references", { code: "US..SPX", source: "moomoo" }),
  },
  {
    name: "DELETE /references/{id} stops keeping a Security",
    world: world({ tables: references }),
    request: request("DELETE", "/references/ref-2"),
  },
  {
    name: "DELETE /references/{id} on a Reference that does not exist",
    world: world({ tables: references }),
    request: request("DELETE", "/references/ref-9"),
  },
  // --- /mcp ----------------------------------------------------------------------------------
  // The MCP door (ADR 0026, #447): one JSON-RPC message per POST, each tool a GET of the API's
  // own. Its answers are compared as TEXT, word for word, so these hold the Python to the same
  // bytes — keys sorted, numbers as JavaScript writes them. Not in `/openapi.json`, which cannot
  // describe JSON-RPC; `coverage.test.ts` holds these to the tools the door LISTS instead.
  {
    name: "POST /mcp initializes at the version the client asks for",
    world: world(),
    request: request("POST", "/mcp", rpc("initialize", {
      protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "2" },
    })),
  },
  {
    name: "POST /mcp answers its newest version to one it does not speak",
    world: world(),
    request: request("POST", "/mcp", rpc("initialize", { protocolVersion: "2099-01-01" })),
  },
  {
    name: "POST /mcp lists every tool, each a read",
    world: world(),
    request: request("POST", "/mcp", rpc("tools/list")),
  },
  {
    name: "POST /mcp accepts a notification with no answer",
    world: world(),
    request: request("POST", "/mcp", { jsonrpc: "2.0", method: "notifications/initialized" }),
  },
  {
    // 2025-03-26 allowed batches and 2024-11-05 is the old HTTP+SSE transport: neither is spoken
    name: "POST /mcp answers its newest version to one whose transport it does not follow",
    world: world(),
    request: request("POST", "/mcp", rpc("initialize", { protocolVersion: "2025-03-26" })),
  },
  {
    // the transport's rule after initialization: an unsupported version is a 400, with no id
    name: "POST /mcp refuses a request carrying an MCP-Protocol-Version it does not speak",
    world: world(),
    request: {
      ...request("POST", "/mcp", rpc("ping")),
      headers: { Authorization: "Bearer tok", "MCP-Protocol-Version": "2024-11-05" },
    },
  },
  {
    name: "POST /mcp answers a request carrying a version it speaks",
    world: world(),
    request: {
      ...request("POST", "/mcp", rpc("ping")),
      headers: { Authorization: "Bearer tok", "MCP-Protocol-Version": "2025-06-18" },
    },
  },
  {
    name: "POST /mcp answers a ping",
    world: world(),
    request: request("POST", "/mcp", rpc("ping")),
  },
  {
    name: "POST /mcp says a method it does not have is not found",
    world: world(),
    request: request("POST", "/mcp", rpc("resources/list")),
  },
  {
    name: "POST /mcp refuses a message that is not JSON-RPC",
    world: world(),
    request: request("POST", "/mcp", { id: 1, method: "ping" }),
  },
  {
    name: "POST /mcp wants the API's token",
    world: world(),
    request: request("POST", "/mcp", rpc("tools/list"), { anonymous: true }),
  },
  {
    name: "GET /mcp offers no stream",
    world: world(),
    request: request("GET", "/mcp"),
  },
  {
    name: "POST /mcp says a tool it does not have is unknown",
    world: world(),
    request: request("POST", "/mcp", rpc("tools/call", { name: "close_position", arguments: { id: "pos-1" } })),
  },
  {
    // the live book, in session: one Provider call, its answer the route's own
    name: "POST /mcp reads the holdings as GET /positions/values serves them",
    world: world({ tables: held, provider: { quotes: BOOK } }),
    request: request("POST", "/mcp", tool("holdings")),
  },
  {
    name: "POST /mcp reads the watchlist as GET /quotes serves it",
    world: world({ tables: held, provider: { quotes: BOOK } }),
    request: request("POST", "/mcp", tool("watchlist")),
  },
  {
    // a Provider that is down is a tool error in the service's own words, not a protocol error
    name: "POST /mcp says the watchlist cannot be read while the Provider is down",
    world: world({ tables: held, provider: { down: DOWN } }),
    request: request("POST", "/mcp", tool("watchlist")),
  },
  {
    // closed trades are the recorded positions with a close day: asking no Provider
    name: "POST /mcp reads every position recorded, the closed ones with what they made",
    world: world({
      tables: {
        positions: [
          position({ id: "pos-1" }),
          position({ id: "pos-2", name: "nov-condor", entry: 5.5, closed_on: "2026-11-06", exit: 1.25 }),
        ],
      },
      provider: { down: DOWN },
    }),
    request: request("POST", "/mcp", tool("positions")),
  },
  {
    name: "POST /mcp reads a holding's history",
    world: world({
      tables: {
        positions: [opened],
        position_samples: [day("2026-11-06", 42, [14, 13.5, 19, 20]), day("2026-11-07", 41, [14.5, 14, 19.5, 20.5])],
      },
      provider: { down: DOWN },
    }),
    request: request("POST", "/mcp", tool("holding_history", { id: "pos-1" })),
  },
  {
    // looked up as an id and as a name: neither, said in words, with the tool that lists them
    name: "POST /mcp says a holding that does not exist is not found",
    world: world({ tables: held }),
    request: request("POST", "/mcp", tool("holding_history", { id: "pos-9" })),
  },
  {
    // the history tools take a NAME as well as an id (decided 2026-11-18): one call, not a 404, a
    // watchlist search and a retry. The answer's source names the id it resolved to.
    name: "POST /mcp reads a holding's history by its name",
    world: world({
      tables: {
        positions: [opened],
        position_samples: [day("2026-11-06", 42, [14, 13.5, 19, 20])],
      },
      provider: { down: DOWN },
    }),
    request: request("POST", "/mcp", tool("holding_history", { id: " dec-condor " })),
  },
  {
    // a closed trade keeps its name, and /positions lists it: found as an open one is
    name: "POST /mcp reads a closed holding's history by its name",
    world: world({
      tables: {
        positions: [
          position({ id: "pos-1" }),
          position({ id: "pos-2", name: "nov-condor", entry: 5.5, opened_at: "2026-11-06", closed_on: "2026-11-07", exit: 1.25 }),
        ],
        position_samples: [{ ...day("2026-11-06", 42, [14, 13.5, 19, 20]), position_id: "pos-2" }],
      },
      provider: { down: DOWN },
    }),
    request: request("POST", "/mcp", tool("holding_history", { id: "nov-condor" })),
  },
  {
    // control characters and more than 64 characters are refused before the API is asked anything
    name: "POST /mcp refuses an id that is not an id, asking nothing",
    world: world({ tables: held, provider: { quotes: BOOK } }),
    request: request("POST", "/mcp", tool("holding_history", { id: "dec-condor\n" })),
  },
  {
    // a name is looked up in the list, never put in a path: one like a path is simply not found
    name: "POST /mcp looks a path-like name up rather than following it",
    world: world({ tables: held, provider: { quotes: BOOK } }),
    request: request("POST", "/mcp", tool("monitor_history", { id: "../quotes" })),
  },
  {
    name: "POST /mcp refuses an argument a tool does not take",
    world: world({ tables: held, provider: { quotes: BOOK } }),
    request: request("POST", "/mcp", tool("watchlist", { fresh: true })),
  },
  {
    name: "POST /mcp reads a rule's history",
    world: world({
      tables: {
        monitors: [combo({ id: "mon-2" })],
        watch_samples: [
          watchDay([C7300, C7350], {
            observed_on: "2026-11-05", dte: 43, observed_at: "2026-11-05 21:14:00.000000", spx: 6812.5,
            legs_mid: { [C7300]: 3, [C7350]: 2 }, legs_iv: { [C7300]: 14.5, [C7350]: 14.25 },
            legs_delta: { [C7300]: 0.22, [C7350]: 0.16 }, contract_size: 100,
          }),
        ],
      },
      provider: { down: DOWN },
    }),
    request: request("POST", "/mcp", tool("monitor_history", { id: "mon-2" })),
  },
  {
    name: "POST /mcp reads a rule's history by its combo name",
    world: RULES,
    request: request("POST", "/mcp", tool("monitor_history", { id: "1218-6800" })),
  },
  {
    // the one rule on the put: its code as stored, `US.SPXW…`
    name: "POST /mcp reads a rule's history by its contract's code",
    world: RULES,
    request: request("POST", "/mcp", tool("monitor_history", { id: "US.SPXW261218P6400000" })),
  },
  {
    // and the contract as the page and the bot write it, read by /unwatch's own parser
    name: "POST /mcp reads a rule's history by its contract as the page writes it",
    world: RULES,
    request: request("POST", "/mcp", tool("monitor_history", { id: "20261218 P6400" })),
  },
  {
    // the short call is watched for its Δ and for its price: each is listed, to call again by id
    name: "POST /mcp lists the rules a contract names when it names several",
    world: RULES,
    request: request("POST", "/mcp", tool("monitor_history", { id: "20261218 C7300" })),
  },
  {
    name: "POST /mcp says what it tried when nothing has the name",
    world: RULES,
    request: request("POST", "/mcp", tool("monitor_history", { id: "261218 C9999" })),
  },
  {
    name: "POST /mcp reads each rule's last close",
    world: world({
      tables: {
        monitors: [combo({ id: "mon-2" })],
        watch_samples: [
          watchDay([C7300, C7350], {
            observed_on: "2026-11-06", dte: 42, observed_at: "2026-11-06 21:14:00.000000",
            legs_mid: { [C7300]: 3.1, [C7350]: 2.05 },
          }),
        ],
      },
      provider: { down: DOWN },
    }),
    request: request("POST", "/mcp", tool("monitor_closes")),
  },
  {
    name: "POST /mcp reads the References",
    world: world({ tables: references, provider: { quotes: { "US.SPY": SPY } } }),
    request: request("POST", "/mcp", tool("references")),
  },
  {
    name: "POST /mcp reads the service's health",
    world: world({ tables: { sweep_interval: [chosenInterval(5)] }, sweeps: [{ at: at(-10), down: null }] }),
    request: request("POST", "/mcp", tool("health")),
  },
  // --- GET /spreads/quote: any SPX structure, priced in one bounded call (#452, ADR 0027) ------
  {
    // three structures, one Provider call carrying every distinct leg once; the call spread written
    // with a raw `+`, which a query string delivers as a space, and the put spread with %2B
    name: "GET /spreads/quote prices every structure in one call carrying each leg once",
    world: world({ provider: { quotes: PREMIUM_BOOK } }),
    request: request("GET", `/spreads/quote?spread=${QUOTE_CALLS}&spread=${QUOTE_PUTS}%401.5&spread=20261218%3A-C7300`),
  },
  {
    // a ratio: its long leg counted twice in the value, the natural fill and every greek
    name: "GET /spreads/quote values a 1x2 its long leg counted twice",
    world: world({ provider: { quotes: BOOK } }),
    request: request("GET", "/spreads/quote?spread=2026-12-18%3A-C7300%2C%2BC7350x2"),
  },
  {
    // Saturday: moomoo quotes 0/0, so no leg has a mid and nothing is summed but the greeks; each
    // leg's last regular-session close is said beside it, never summed, and the payoff is the shape
    name: "GET /spreads/quote out of hours dashes every price, sums the greeks and says each leg's last close",
    world: world({
      clock: SATURDAY,
      provider: { quotes: OUT_OF_HOURS },
      tables: {
        watch_samples: [
          watchDay([C7300, C7350], {
            observed_on: "2026-11-13", dte: 35, observed_at: "2026-11-13 21:14:00.000000",
            legs_mid: { [C7300]: 3.1, [C7350]: 2.05 },
          }),
          // a later row read after the close is no close, and an older one is older
          watchDay([C7300], {
            observed_on: "2026-11-12", dte: 36, observed_at: "2026-11-12 21:14:00.000000",
            legs_mid: { [C7300]: 2.9 },
          }),
        ],
      },
    }),
    request: request("GET", `/spreads/quote?spread=${QUOTE_CALLS}&spread=${QUOTE_PUTS}%401.5`),
  },
  {
    // GTH: SPX options trade and moomoo quotes them live, so a quoted structure is priced as in the
    // session, and SPX is said to be the last close's level beside its price
    name: "GET /spreads/quote overnight prices what is quoted live",
    world: world({ clock: GTH, provider: { quotes: PREMIUM_BOOK } }),
    request: request("GET", `/spreads/quote?spread=${QUOTE_CALLS}`),
  },
  {
    name: "GET /spreads/quote fails only the structure holding a contract the Provider does not know",
    world: world({ provider: { quotes: BOOK, unknown: [C7500] } }),
    request: request("GET", `/spreads/quote?spread=${QUOTE_PUTS}&spread=20261218%3A-C7350%2C%2BC7500%40-0.5`),
  },
  {
    name: "GET /spreads/quote answers 502 naming the Provider when it is down",
    world: world({ provider: { down: DOWN } }),
    request: request("GET", `/spreads/quote?spread=${QUOTE_CALLS}`),
  },
  {
    name: "GET /spreads/quote refuses a request naming no spread",
    world: world({ provider: { quotes: BOOK } }),
    request: request("GET", "/spreads/quote"),
  },
  {
    name: "GET /spreads/quote refuses a structure that is not the grammar, asking nothing",
    world: world({ provider: { quotes: BOOK } }),
    request: request("GET", "/spreads/quote?spread=20261218%3A-C7300%2C%2BQ7350"),
  },
  {
    // POST /spreads' own refusals, in its words (the owner's decision on #452)
    name: "GET /spreads/quote refuses a contract named twice in one structure, asking nothing",
    world: world({ provider: { quotes: BOOK } }),
    request: request("GET", "/spreads/quote?spread=20261218%3A-C7300%2C%2BC7350%2C-C7300"),
  },
  {
    name: "GET /spreads/quote refuses a contract both short and long in one structure, asking nothing",
    world: world({ provider: { quotes: BOOK } }),
    request: request("GET", `/spreads/quote?spread=${QUOTE_PUTS}&spread=20261218%3A-C7300%2C%2BC7300`),
  },
  {
    // a strike past six digits is no SPX strike, and unbounded it built a code no Provider has
    name: "GET /spreads/quote refuses a strike of more than six digits, asking nothing",
    world: world({ provider: { quotes: BOOK } }),
    request: request("GET", "/spreads/quote?spread=20261218%3A-P1000000000000000000000"),
  },
  {
    name: "GET /spreads/quote refuses a quantity above ten, asking nothing",
    world: world({ provider: { quotes: BOOK } }),
    request: request("GET", "/spreads/quote?spread=20261218%3A-C7300x11"),
  },
  {
    name: "GET /spreads/quote refuses an expiry already past, asking nothing",
    world: world({ provider: { quotes: BOOK } }),
    request: request("GET", "/spreads/quote?spread=20261106%3A-P6400"),
  },
  {
    name: "GET /spreads/quote refuses seven legs in one structure, asking nothing",
    world: world({ provider: { quotes: BOOK } }),
    request: request("GET", "/spreads/quote?spread=20261218%3A-P6400%2C%2BP6350%2C-P6300%2C%2BP6250%2C-P6200%2C%2BP6150%2C-P6100"),
  },
  {
    name: "GET /spreads/quote refuses 33 legs in all, asking nothing",
    world: world({ provider: { quotes: BOOK } }),
    request: request("GET", `/spreads/quote?${[...Array(5).fill(SIX_QUOTED), "20261218%3A-P6400%2C%2BP6350%2C-P6300"]
      .map((sp) => `spread=${sp}`).join("&")}`),
  },
  {
    // the same structures asked 3s ago, the other way round: answered from that call, asking nothing
    name: "GET /spreads/quote answers the same structures again within 5s from the same call",
    world: world({ provider: { quotes: PREMIUM_BOOK } }),
    earlier: [{ at: at(-3), request: request("GET", `/spreads/quote?spread=${QUOTE_CALLS}&spread=${QUOTE_PUTS}`) }],
    request: request("GET", `/spreads/quote?spread=${QUOTE_PUTS}&spread=20261218%3A%2BC7350%2C-C7300`),
  },
  {
    // the batch is keyed on the contracts alone (the owner's decision on #452): the put spread at
    // another entry, its legs as two structures beside it, is answered from the call 3s ago — the cap
    // at 1 spent once — and each structure's payoff is drawn at its own entry
    name: "GET /spreads/quote answers the same contracts at another entry from the same call, spending nothing",
    world: world({ settings: { SPREAD_QUOTE_CALLS_PER_30S: "1" }, provider: { quotes: BOOK } }),
    earlier: [{ at: at(-3), request: request("GET", `/spreads/quote?spread=${QUOTE_PUTS}%401.5`) }],
    request: request("GET", `/spreads/quote?spread=${QUOTE_PUTS}%402&spread=20261218%3A-P6400&spread=20261218%3A%2BP6350`),
  },
  {
    // the cap at 2 calls in 30 seconds, both spent 10s and 20s ago on other structures: the next is
    // allowed when the older is 30s old
    name: "GET /spreads/quote refuses a call over the cap saying when the next is allowed",
    world: world({ settings: { SPREAD_QUOTE_CALLS_PER_30S: "2" }, provider: { quotes: BOOK } }),
    earlier: [
      { at: at(-20), request: request("GET", `/spreads/quote?spread=${QUOTE_PUTS}`) },
      { at: at(-10), request: request("GET", "/spreads/quote?spread=20261218%3A-C7300") },
    ],
    request: request("GET", `/spreads/quote?spread=${QUOTE_CALLS}`),
  },
  {
    name: "GET /spreads/quote wants the API's token",
    world: world({ provider: { quotes: BOOK } }),
    request: request("GET", `/spreads/quote?spread=${QUOTE_CALLS}`, null, { anonymous: true }),
  },
  {
    // the MCP door writes the structures as the route's query and GETs it (ADR 0027)
    name: "POST /mcp prices any structure through GET /spreads/quote",
    world: world({ provider: { quotes: PREMIUM_BOOK } }),
    request: request("POST", "/mcp", tool("price_spreads", {
      structures: [
        { expiry: "20261218", legs: [{ side: "short", option_type: "CALL", strike: 7300 }, { side: "long", option_type: "CALL", strike: 7350 }] },
        {
          expiry: "2026-12-18", entry: 1.5,
          legs: [{ side: "short", option_type: "PUT", strike: 6400 }, { side: "long", option_type: "PUT", strike: 6350, qty: 2 }],
        },
      ],
    })),
  },
  {
    name: "POST /mcp carries the route's refusal of a structure as a tool error",
    world: world({ provider: { quotes: BOOK } }),
    request: request("POST", "/mcp", tool("price_spreads", {
      structures: [{ expiry: "20261106", legs: [{ side: "short", option_type: "PUT", strike: 6400 }] }],
    })),
  },
  {
    name: "POST /mcp refuses a structure it cannot write as a query, asking nothing",
    world: world({ provider: { quotes: BOOK } }),
    request: request("POST", "/mcp", tool("price_spreads", {
      structures: [{ expiry: "20261218", legs: [{ side: "sold", option_type: "PUT", strike: 6400 }] }],
    })),
  },
  {
    name: "POST /mcp says how long to wait when spread quotes are capped",
    world: world({ settings: { SPREAD_QUOTE_CALLS_PER_30S: "1" }, provider: { quotes: BOOK } }),
    earlier: [{ at: at(-12), request: request("GET", `/spreads/quote?spread=${QUOTE_PUTS}`) }],
    request: request("POST", "/mcp", tool("price_spreads", {
      structures: [{ expiry: "20261218", legs: [{ side: "short", option_type: "CALL", strike: 7300 }] }],
    })),
  },
  // --- the MCP door's figures, rounded by key (#454) -----------------------------------------
  {
    // a put spread whose mids sum to -4.100000000000001 and whose gammas to -0.0000403: the value
    // is written -4.1, and the gamma, at six places, survives as -0.00004 rather than reading 0
    name: "POST /mcp writes a spread's figures rounded, its gamma to six places",
    world: world({ provider: { quotes: NOISY_PUTS } }),
    request: request("POST", "/mcp", tool("price_spreads", {
      structures: [{
        expiry: "20261218",
        legs: [{ side: "short", option_type: "PUT", strike: 6800 }, { side: "long", option_type: "PUT", strike: 6750 }],
      }],
    })),
  },
  {
    // a rule on Δ: its figure, threshold and distance to four places, by the rule's field
    name: "POST /mcp writes a rule on delta's figures to four places",
    world: world({
      tables: { monitors: [monitor({ id: "mon-1", threshold: 0.31234 })] },
      provider: { quotes: { [C7300]: quote("SPXW 261218 7300C", 2.75, 0.123456789) } },
    }),
    request: request("POST", "/mcp", tool("watchlist")),
  },
  {
    // the watchlist's quote is moomoo's whole record (review of #455): every RECORD_FIELDS key, each
    // figure with float noise and each count a count, so the walk over the scenarios covers them all;
    // the rule is on ρ, which the by-field table places at four
    name: "POST /mcp writes every figure of moomoo's quote record rounded",
    world: world({
      tables: { monitors: [monitor({ id: "mon-1", field: "option_rho", threshold: 0.31234 })] },
      provider: { quotes: { [C7300]: FULL_RECORD } },
    }),
    request: request("POST", "/mcp", tool("watchlist")),
  },
  {
    // a rule on a combo's price: its figure, threshold and distance to two places, by its field;
    // 4.125 is an exact half, so it goes away from zero, and 3.0249999999999995 is not one
    name: "POST /mcp writes a rule on price's figures to two places",
    world: world({
      tables: { monitors: [combo({ id: "mon-2", threshold: 4.125 })] },
      provider: { quotes: { [C7300]: quote("SPXW 261218 7300C", 2.7, 0.21), [C7350]: quote("SPXW 261218 7350C", 1.6, 0.15) } },
    }),
    request: request("POST", "/mcp", tool("watchlist")),
  },
  // --- an agent's writes over MCP (#456, ADR 0028) -------------------------------------------
  // add_rule and edit_rule, behind MCP_WRITES: off by default, not listed and refused; on, each a
  // write of the route the dashboard writes through, said to the owner's phone in one line
  {
    name: "POST /mcp lists the two writes after the reads while writes are on",
    world: world({ settings: WRITING }),
    request: request("POST", "/mcp", rpc("tools/list")),
  },
  {
    name: "POST /mcp says in its instructions that writes are on, and their cap",
    world: world({ settings: { ...WRITING, MCP_WRITES_PER_10_MIN: "4" } }),
    request: request("POST", "/mcp", rpc("initialize", { protocolVersion: "2025-11-25" })),
  },
  {
    name: "POST /mcp refuses add_rule while writes are off, asking nothing",
    world: world({ provider: { quotes: BOOK } }),
    request: request("POST", "/mcp", tool("add_rule", PUT_SPREAD_RULE)),
  },
  {
    name: "POST /mcp refuses edit_rule while writes are off, reading nothing",
    world: world({ tables: { monitors: [combo({ id: "mon-2", code: "1218-6800" })] } }),
    request: request("POST", "/mcp", tool("edit_rule", { id: "1218-6800", threshold: 4.8 })),
  },
  {
    // the route's own probe of both legs, its row, and one line on the owner's phone
    name: "POST /mcp adds a rule on a put spread, and tells the owner",
    world: world({ settings: WRITING, provider: { quotes: BOOK } }),
    request: request("POST", "/mcp", tool("add_rule", PUT_SPREAD_RULE)),
  },
  {
    // one leg is a rule on that contract: its side means nothing, and the route's defaults apply
    name: "POST /mcp adds a rule on one contract with the route's defaults",
    world: world({ settings: WRITING, provider: { quotes: BOOK } }),
    request: request("POST", "/mcp", tool("add_rule", {
      expiry: "2026-12-18", threshold: 0.25, legs: [{ side: "short", option_type: "CALL", strike: 7300, qty: 1 }],
    })),
  },
  {
    name: "POST /mcp refuses add_rule with a quantity, asking nothing",
    world: world({ settings: WRITING, provider: { quotes: BOOK } }),
    request: request("POST", "/mcp", tool("add_rule", {
      ...PUT_SPREAD_RULE, legs: [PUT_SPREAD_RULE.legs[0], { ...PUT_SPREAD_RULE.legs[1], qty: 2 }],
    })),
  },
  {
    name: "POST /mcp refuses add_rule on a combo with no name, asking nothing",
    world: world({ settings: WRITING, provider: { quotes: BOOK } }),
    request: request("POST", "/mcp", tool("add_rule", { expiry: "20261218", threshold: 2.25, legs: PUT_SPREAD_RULE.legs })),
  },
  {
    name: "POST /mcp carries the route's refusal of a contract the Provider does not know",
    world: world({ settings: WRITING, provider: { quotes: BOOK, unknown: [P6350] } }),
    request: request("POST", "/mcp", tool("add_rule", PUT_SPREAD_RULE)),
  },
  {
    // ten writes reached the route in the last ten minutes — each refused there, which writes no
    // row and still counts, since its probe asked the Provider — so the eleventh is not made; the
    // first, 500s ago, leaves the window in 100s
    name: "POST /mcp refuses the eleventh write in ten minutes, the route's refusals counted",
    world: world({ settings: WRITING, provider: { quotes: BOOK, unknown: [P6350] } }),
    earlier: Array.from({ length: 10 }, (_, i) => ({
      at: at(-500 + 10 * i), request: request("POST", "/mcp", tool("add_rule", PUT_SPREAD_RULE)),
    })),
    request: request("POST", "/mcp", tool("add_rule", { ...PUT_SPREAD_RULE, legs: [PUT_SPREAD_RULE.legs[0]], name: undefined })),
  },
  {
    name: "POST /mcp edits a rule's threshold by its combo name, and tells the owner",
    world: world({ settings: WRITING, tables: { monitors: [combo({ id: "mon-2", code: "1218-6800", threshold: 4.5 })] } }),
    request: request("POST", "/mcp", tool("edit_rule", { id: "1218-6800", threshold: 4.8 })),
  },
  {
    name: "POST /mcp mutes a rule as the owner would by hand",
    world: world({ settings: WRITING, tables: { monitors: [monitor({ id: "mon-1" })] } }),
    request: request("POST", "/mcp", tool("edit_rule", { id: "20261218 C7300", enabled: false })),
  },
  {
    name: "POST /mcp unmutes a rule muted by hand",
    world: world({
      settings: WRITING, tables: { monitors: [monitor({ id: "mon-1", enabled: 0, disabled_reason: "manual" })] },
    }),
    request: request("POST", "/mcp", tool("edit_rule", { id: "mon-1", enabled: true })),
  },
  {
    // only the owner unmutes what the service switched off: refused with the reason, nothing written
    name: "POST /mcp refuses to unmute a quarantined rule, writing nothing",
    world: world({
      settings: WRITING, tables: { monitors: [monitor({ id: "mon-1", enabled: 0, disabled_reason: "no-figure" })] },
    }),
    request: request("POST", "/mcp", tool("edit_rule", { id: "mon-1", enabled: true })),
  },
  {
    // review of #457: muting a quarantined rule would have rewritten its reason to "manual" and let
    // the unmute through. The mute is refused first (an earlier request, which writes nothing), and the
    // unmute after it still finds the service's reason
    name: "POST /mcp refuses to mute a quarantined rule and then to unmute it, writing nothing",
    world: world({
      settings: WRITING, tables: { monitors: [monitor({ id: "mon-1", enabled: 0, disabled_reason: "no-figure" })] },
    }),
    earlier: [{ at: at(-5), request: request("POST", "/mcp", tool("edit_rule", { id: "mon-1", enabled: false })) }],
    request: request("POST", "/mcp", tool("edit_rule", { id: "mon-1", enabled: true })),
  },
  {
    name: "POST /mcp refuses to mute a rule the service switched off",
    world: world({
      settings: WRITING, tables: { monitors: [monitor({ id: "mon-1", enabled: 0, disabled_reason: "expired" })] },
    }),
    request: request("POST", "/mcp", tool("edit_rule", { id: "mon-1", enabled: false })),
  },
  {
    // an edit that leaves enabled alone is the route's, and keeps the service's reason
    name: "POST /mcp moves a quarantined rule's threshold, keeping it off for the service's reason",
    world: world({
      settings: WRITING, tables: { monitors: [monitor({ id: "mon-1", enabled: 0, disabled_reason: "no-figure" })] },
    }),
    request: request("POST", "/mcp", tool("edit_rule", { id: "mon-1", threshold: 0.35 })),
  },
  {
    name: "POST /mcp refuses to change the figure a rule watches",
    world: world({ settings: WRITING, tables: { monitors: [monitor({ id: "mon-1" })] } }),
    request: request("POST", "/mcp", tool("edit_rule", { id: "mon-1", field: "mid_price" })),
  },
  {
    name: "POST /mcp carries the route's refusal of an edit in its words",
    world: world({ settings: WRITING, tables: { monitors: [monitor({ id: "mon-1" })] } }),
    request: request("POST", "/mcp", tool("edit_rule", { id: "mon-1", name: "renamed" })),
  },
  {
    // the write stands, and no notice is sent: the log says so
    name: "POST /mcp adds a rule with Telegram not configured, sending nothing",
    world: world({ settings: { ...WRITING, TELEGRAM_BOT_TOKEN: "" }, provider: { quotes: BOOK } }),
    request: request("POST", "/mcp", tool("add_rule", PUT_SPREAD_RULE)),
  },
  {
    name: "POST /mcp adds a rule while Telegram refuses, the write standing",
    world: world({ settings: WRITING, telegram: "down", provider: { quotes: BOOK } }),
    request: request("POST", "/mcp", tool("add_rule", PUT_SPREAD_RULE)),
  },
  // --- /openapi.json and /docs --------------------------------------------------------------
  // The service's description of itself, held word for word (decided 2026-11-10): the Python
  // serves what `make scenarios` writes to schema/api/, with its own root path put in. Asked
  // without the token, which every world here has: the page cannot hand one to its own fetch.
  {
    name: "GET /openapi.json describes every route, without a token",
    world: world(),
    request: request("GET", "/openapi.json", null, { anonymous: true }),
  },
  {
    // behind the path-stripping proxy the browser sees /opt/api/...: "Try it" has to be told
    name: "GET /openapi.json names the path the browser sees behind the proxy",
    world: world({ settings: { ROOT_PATH: "/opt/api" } }),
    request: request("GET", "/openapi.json", null, { anonymous: true }),
  },
  {
    name: "GET /docs is the reference page, without a token",
    world: world(),
    request: request("GET", "/docs", null, { anonymous: true }),
  },
  {
    name: "GET /docs loads the description from the path the browser sees behind the proxy",
    world: world({ settings: { ROOT_PATH: "/opt/api" } }),
    request: request("GET", "/docs", null, { anonymous: true }),
  },
];
