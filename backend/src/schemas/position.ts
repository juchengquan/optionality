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
  side: z.enum(["sold", "bought"]),
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
});

/** Legs are never edited here — a different structure is a different holding. */
export const PositionPatch = z.object({
  entry: z.number().optional(),
  contracts: z.int().min(1).optional(),
  strategy: z.string().optional(),
});
