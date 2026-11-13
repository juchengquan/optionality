/** What the API accepts for adding spreads in one step (#293, ADR 0023).
 *
 *  A spread is legs on one expiry, and it is added either HELD — a Position, with its Entry and
 *  Opened — or only WATCHED; either way with the Monitors it starts with. The expiry is given once
 *  for the whole request, because a condor entered as two spreads shares it and typing it twice
 *  was the old form's commonest chore.
 *
 *  A Monitor here is written in terms of its spread rather than as `POST /monitors` takes one: with
 *  no leg named it watches the spread's VALUE, a combo over its legs (minus is short, ADR 0013);
 *  naming a leg's type and strike watches that one contract. Optional fields are `.optional()`
 *  with their defaults applied where used — see validate.ts.
 */
import { z } from "zod";

import { Compare, Direction, StrikeDate } from "./monitor.ts";
import { LegIn } from "./position.ts";

export const SpreadMonitorIn = z.object({
  /** the leg watched, by type and strike — both, or neither for the spread's value */
  option_type: z.enum(["CALL", "PUT"]).optional(),
  strike: z.number().optional(),
  /** `mid_price` for the value, `option_delta` for a leg, when not given */
  field: z.string().optional(),
  threshold: z.number(),
  direction: Direction.optional(),
  compare: Compare.optional(),
});

export const SpreadIn = z.object({
  /** the holding's name when held, and the value Monitor's code either way */
  name: z.string().min(1),
  /** six at most, as the old dashboard's combo builder took (#334); the request's legs in all are
   *  held to `MAX_PROBE_LEGS` by `create-spread.ts`, so the one probe stays small */
  legs: z.array(LegIn).min(1).max(6),
  /** true records a Position; false records only the Monitors */
  held: z.boolean(),
  /** a holding's, as POST /positions takes them; refused on a spread that is only watched */
  entry: z.number().nullish(),
  contracts: z.int().min(1).optional(),
  opened_at: StrikeDate.nullish(),
  /** the Monitors it starts with: a default switched off is simply not sent */
  monitors: z.array(SpreadMonitorIn),
});

/** The most legs one request may carry in all: what its ONE probe asks for at most. 32 is the bound
 *  #322's review set, eight spreads of four legs; six legs to a spread (#334) did not move it, so
 *  eight six-leg spreads are refused rather than asked of the Provider as 48 codes. */
export const MAX_PROBE_LEGS = 32;

export const SpreadsIn = z.object({
  strike_date: StrikeDate,
  /** at most eight, so the request's ONE probe is bounded in size as well as in number */
  spreads: z.array(SpreadIn).min(1).max(8),
});
