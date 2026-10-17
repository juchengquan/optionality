/** What the API accepts for a position (ADR 0009, phase 5).
 *
 *  Optional fields are `.optional()` with their defaults applied where used — see validate.ts.
 */
import { z } from "zod";

import { normalizeStrikeDate } from "../domain/contract.ts";

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

/** Legs are never edited here — a different structure is a different holding. */
export const PositionPatch = z.object({
  entry: z.number().optional(),
  contracts: z.int().min(1).optional(),
  strategy: z.string().optional(),
  /** settable after the fact, which is the only way the Positions recorded before this existed
   *  can get one — created_at is right for some of them and wrong for the rest */
  opened_at: StrikeDate.optional(),
});
