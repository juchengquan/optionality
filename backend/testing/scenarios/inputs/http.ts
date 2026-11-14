/** The HTTP door's scenarios, as inputs: a world and one request each (ADR 0021).
 *
 *  `coverage.test.ts` holds this list to `/openapi.json`: every status every documented endpoint
 *  can answer has at least one scenario here. Beyond that, a scenario earns its place by a branch
 *  the code takes — the order a refusal is decided in, a call that must NOT be made, a write that
 *  reaches a second table.
 */
import type { HttpRequest, World } from "../format.ts";
import {
  BOOK, C7300, C7350, C7500, P6350, P6400, EXPIRY, PREMIUM_BOOK, at, combo, except, link, monitor,
  position, quote,
  reference, request, sample, world,
} from "./fixtures.ts";

export interface HttpInput {
  name: string;
  world: World;
  request: HttpRequest;
}

const DOWN = "connect ECONNREFUSED 127.0.0.1:33333";

/** The book as it stands: the condor held, its short call watched on delta, its call spread
 *  watched as a combo, both rules linked to the holding. */
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
const dayAt = (observed_on: string, dte: number, cost: number, ivs: number[], vegas: number[],
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
    // infinite reading reaches the row. JSON cannot write one: it is served as no figure and no
    // distance, the bar and the bell are decided on it as the sweep decides — full, and ringing —
    // and every other row is answered as usual
    name: "GET /quotes rings on an infinite reading it cannot serve, and answers every other row",
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
    name: "GET /positions/values answers 502 naming the Provider when it is down",
    world: world({ tables: held, provider: { down: DOWN } }),
    request: request("GET", "/positions/values"),
  },
  {
    // the refusal's words are the reply, so both backends must say them alike (#266). Under the
    // Provider's name, as every failure of this route is: the read sits inside its one guard
    name: "GET /positions/values answers 502 naming a holding that cannot be read",
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
    // F6's fallback: a trade recorded in New York's evening has no close yet, only its first row,
    // taken after the close — valued from that, and said to be from after the close
    name: "GET /positions/values outside the session values from a reading after the close where no close has a cost",
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
    // ...and where no holding has a close, every one is a dash with the reason, as out of hours it
    // would be with the Provider up: a 200, not the 502 the session still answers
    name: "GET /positions/values outside the session with the Provider down and no close dashes every holding",
    world: world({ clock: SATURDAY, tables: held, provider: { down: DOWN } }),
    request: request("GET", "/positions/values"),
  },
  {
    // #387: a fallback row priced in the hours on a Saturday is no close, and says so — by the session
    // closeSample asks, not by the hour
    name: "GET /positions/values outside the session says a weekend reading it values from is no close",
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
    // the 7th is missing: the chain is broken and the reason names the two days around it; the
    // 8th's row from 16:05 New York is that day's close
    name: "GET /positions/{id}/vol names a missing day, and still covers the gap at the last close",
    world: world({
      tables: {
        positions: [opened],
        position_samples: [
          dayAt("2026-11-06", 42, 6.4, [14.5, 14, 19.25, 20], VEGAS, "2026-11-06 21:05:00.000000"),
          dayAt("2026-11-08", 40, 6.25, [15, 14.25, 19, 20], VEGAS, "2026-11-08 21:05:00.000000"),
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
        positions: [{ ...opened, qty_corrected_at: "2026-11-09 14:00:00.000000" }],
        position_samples: [
          dayAt("2026-11-06", 42, 6.4, [14.5, 14, 19.25, 20], VEGAS, "2026-11-06 21:05:00.000000"),
          dayAt("2026-11-07", 41, 6.1, [14.75, 14, 19.5, 20.25], VEGAS, "2026-11-07 21:05:00.000000"),
          dayAt("2026-11-08", 40, 6.25, [15, 14.25, 19, 20], VEGAS, "2026-11-08 21:05:00.000000"),
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
