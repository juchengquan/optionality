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

/** The book with a far call priced too, which nothing holds and no combo names. */
const WIDE = { ...BOOK, [C7500]: quote("SPXW 261218 7500C", 0.5, 0.06) };

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
    name: "GET /positions/{id}/vol on a holding that does not exist",
    world: world({ tables: held }),
    request: request("GET", "/positions/pos-9/vol"),
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
