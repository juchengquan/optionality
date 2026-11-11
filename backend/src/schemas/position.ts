/** What the API accepts for a position (ADR 0009, phase 5).
 *
 *  Optional fields are `.optional()` with their defaults applied where used — see validate.ts.
 */
import { z } from "zod";

import { normalizeStrikeDate } from "optionality/domain/contract";

export const DEFAULT_CONTRACTS = 1;

const StrikeDate = z.string().transform((value, ctx) => {
  try {
    return normalizeStrikeDate(value);
  } catch {
    ctx.addIssue({
      code: "custom",
      message: `invalid strike_date '${value}': use YYYY-MM-DD or YYYYMMDD`,
    });
    return z.NEVER;
  }
});

export const LegIn = z.object({
  side: z.enum(["short", "long"]),
  option_type: z.enum(["CALL", "PUT"]),
  strike: z.number(),
});

export const PositionIn = z.object({
  name: z.string(),
  strike_date: StrikeDate,
  /** a single held option is a position too */
  legs: z.array(LegIn).min(1),
  /** unknown for a Position migrated from a combo; P&L then reads unknown rather than inventing one */
  entry: z.number().nullish(),
  contracts: z.int().min(1).optional(),
  strategy: z.string().nullish(),
  /** the day it was PUT ON, which is not the day it is recorded here. Null means no exit
   *  schedule: the decay shape needs a DTE at entry and will not guess one (ADR 0011). */
  opened_at: StrikeDate.nullish(),
});

/** Draft legs and an Entry, for the payoff at expiry they would have (#291): what the add form
 *  previews before anything is saved, and what a watched spread is drawn with at its current value.
 *  A Position's legs and count, without a name or an expiry — the payoff at expiry needs neither —
 *  and an Entry that is REQUIRED, because a curve is drawn at a credit and there is no other. */
export const PayoffIn = z.object({
  /** a Position's legs, with a strike above zero: the payoff's left end is SPX at zero, and a
   *  strike there is no contract. Its own rule, so PositionIn's legs are untouched — those are
   *  probed against the Provider, which refuses a strike that does not exist anyway. */
  legs: z.array(LegIn.extend({ strike: z.number().positive() })).min(1),
  /** points per contract, signed as a Position's: a credit received positive, a debit negative */
  entry: z.number(),
  contracts: z.int().min(1).optional(),
});

/** Legs are never edited here — a different structure is a different holding. */
export const PositionPatch = z.object({
  entry: z.number().optional(),
  contracts: z.int().min(1).optional(),
  strategy: z.string().optional(),
  /** settable after the fact, which is the only way the Positions recorded before this existed
   *  can get one — created_at is right for some of them and wrong for the rest */
  opened_at: StrikeDate.optional(),
  /** a CLOSED holding's exit and close day, correctable after the fact (ADR 0022) — a mistyped
   *  close was otherwise fixable only by deleting, which loses the samples. Refused on a holding
   *  still held. A null exit CLEARS it back to blank, as a close may leave it: the one PATCH field
   *  that takes a null, because blank is a real answer here — "I do not know what I paid". */
  exit: z.number().nullish(),
  closed_on: StrikeDate.optional(),
});

/** Closing a holding: what was paid, and when. Both optional.
 *
 *  `exit` is per contract, in points, like Entry, and may be left out or null — the owner may not
 *  know it, and a blank is kept as a blank rather than guessed (ADR 0022). The dashboard prefills
 *  it from the live Cost to close it is already showing; the service makes no market call here.
 *
 *  `closed_on` is a New York market date, spelled either way, like Opened. Left out, it is today's
 *  market date — or the expiry, if that is earlier, since nothing is held past one. */
export const ClosePositionIn = z.object({
  exit: z.number().nullish(),
  closed_on: StrikeDate.optional(),
});
