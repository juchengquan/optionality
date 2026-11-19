/** `/spreads` — a spread and its Monitors added in one step, all or nothing (#293, ADR 0023); and
 *  `/spreads/quote`, any SPX structure priced live in one bounded call (#452, ADR 0027).
 *
 *  Not a resource of its own: what it writes are Positions and Monitors, which their own routes
 *  list, edit and delete. It exists because a condor and the rules that watch it are one decision
 *  for the owner and were four requests for the dashboard, and a refusal half way through left
 *  half a condor behind. What it decides, and in what order, is `create-spread.ts`'s.
 */
import { Hono } from "hono";
import { z } from "zod";

import { createSpreads, isSpreadFault } from "../../../create-spread.ts";
import { SpreadPricer } from "../../../price-spreads.ts";
import { SpreadsIn } from "../../../schemas/spread.ts";
import type { Deps } from "../deps.ts";
import { httpError, providerFailed } from "../errors.ts";
import { documented } from "../openapi.ts";
import { valid } from "../validate.ts";
import { LastCloseOut, StrikeDistanceOut } from "./monitors.ts";
import { PayoffOut } from "./positions.ts";

/** What was added, by id and name: the page reads the book afresh rather than an echo of it. */
const AddedOut = z.object({
  positions: z.array(z.object({ id: z.string(), name: z.string() })),
  monitors: z.array(z.object({ id: z.string(), code: z.string(), field: z.string() })),
  /** the watch rules a held spread replaced: deleted, with the holding's own made in their place */
  replaced: z.array(z.object({ id: z.string(), code: z.string(), field: z.string() })),
});

const create = documented(
  "Add spreads, each held or watched, with their Monitors: all of it or none", { 201: AddedOut }, [409],
);

/** `spread`, once per structure: Hono hands one as a string and several as a list. Checked by hand
 *  (`parseSpreads`) rather than here, so a refusal is said in the same words by both backends. */
const SpreadsQuery = z.object({
  spread: z.union([z.string(), z.array(z.string())]).optional().meta({
    description: "a structure as <expiry>:<legs>[@<entry>], once per structure: the expiry YYYYMMDD or "
      + "YYYY-MM-DD; each leg - (short) or + (long, %2B in a URL), C or P, the strike, and an optional "
      + "x<qty> 1-10; the entry in points per contract, a credit positive. 20261218:-P6800,%2BP6750@1.25",
  }),
});

const figure = z.number().nullable();

/** One leg as priced: as asked, the quote's figures, its mid by `midPrice`'s one rule, why it has
 *  none, and its last stored regular-session close beside it — never summed into anything. */
const LegQuoteOut = z.object({
  side: z.enum(["short", "long"]),
  option_type: z.enum(["CALL", "PUT"]),
  strike: z.number(),
  qty: z.number(),
  code: z.string(),
  bid_price: figure,
  ask_price: figure,
  mid_price: figure,
  option_implied_volatility: figure,
  option_delta: figure,
  option_gamma: figure,
  option_theta: figure,
  option_vega: figure,
  option_contract_size: figure,
  fetched_at: z.string().nullable(),
  /** unknown contract, no quote returned, or no two-sided quote; null where the leg has a mid */
  error: z.string().nullable(),
  last_known: LastCloseOut,
});

/** One structure, priced from the request's one batch (ADR 0027). */
const StructureQuoteOut = z.object({
  expiry: z.string(),
  dte: z.number(),
  /** the Entry given, points per contract, a credit positive; null where none was */
  entry: z.number().nullable(),
  legs: z.array(LegQuoteOut),
  /** the signed mid sum under the legs' signs and quantities; null where any leg has no mid */
  value: z.number().nullable(),
  /** the worst fill each way, signed as `value`: `ask` to open, `bid` to close; null where any leg
   *  has no two-sided quote */
  natural: z.object({ bid: z.number(), ask: z.number() }).nullable(),
  /** signed sums, never IV; each null where any leg lacks it */
  greeks: z.object({ option_delta: figure, option_gamma: figure, option_theta: figure, option_vega: figure }),
  spx: z.number().nullable(),
  spx_reason: z.string().nullable(),
  short_strikes: z.array(StrikeDistanceOut),
  /** at expiry, one contract; for the `shape` alone its breakevens and maximums are null */
  payoff: PayoffOut.extend({ breakevens: z.array(z.number()).nullable() }).nullable(),
  payoff_basis: z.enum(["entry", "mid", "shape"]).nullable(),
  /** why the structure has no figures: a contract the Provider does not know */
  error: z.string().nullable(),
});

const SpreadsQuoteOut = z.object({
  phase: z.enum(["regular", "curb", "overnight", "closed"]),
  fetched_at: z.string().nullable(),
  spreads: z.array(StructureQuoteOut),
});

const quote = documented(
  "Price any SPX structures live, in one bounded Provider call, capped service-wide",
  { 200: SpreadsQuoteOut }, [429, 502],
);

export function spreadRoutes(deps: Deps) {
  const adding = { db: deps.db, fetchQuotes: deps.provider.fetchQuotes, now: deps.now, newId: deps.newId };
  // one per app, so every caller — the page's fetch, an agent's GET, the MCP door's — shares its
  // batches and its cap (ADR 0027)
  const pricer = new SpreadPricer({
    db: deps.db, fetchQuotes: deps.provider.fetchQuotes, now: deps.now, displayTz: deps.settings.displayTz,
    callsPer30s: deps.settings.spreadQuoteCallsPer30s,
  });
  return new Hono()
    .post("/", create, valid("json", SpreadsIn), async (c) => {
      const result = await createSpreads(adding, c.req.valid("json"));
      if (isSpreadFault(result)) throw httpError(result.status, result.message);
      return create.reply(c, 201, result);
    })
    .get("/quote", quote, valid("query", SpreadsQuery), async (c) => {
      const { spread } = c.req.valid("query");
      const priced = await pricer.price(spread === undefined ? [] : Array.isArray(spread) ? spread : [spread]);
      if ("refused" in priced) throw httpError(priced.refused.status, priced.refused.message);
      if ("failed" in priced) throw providerFailed(deps.provider.name, priced.failed);
      return quote.reply(c, 200, priced.answer);
    });
}
