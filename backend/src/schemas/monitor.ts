/** What the API accepts for a monitor (ADR 0009, phase 5).
 *
 *  Optional fields are written `.optional()` with their defaults applied where the value is used,
 *  rather than `.default()` — see validate.ts for why that is forced by how `hc` types a request.
 *  The defaults themselves are named here so they are still declared once.
 */
import { z } from "zod";

import { normalizeStrikeDate } from "../domain/contract.ts";

export const DEFAULT_SINGLE_FIELD = "option_delta";
export const DEFAULT_COMBO_FIELD = "mid_price";
export const DEFAULT_DIRECTION = "above";
export const DEFAULT_COMPARE = "abs";
export const DEFAULT_ENABLED = true;

/** Accepts both spellings and always stores the dashed one, as the Python does. */
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

const Direction = z.enum(["above", "below"]);
const Compare = z.enum(["abs", "signed"]);

/** Why this threshold cannot be compared this way, or null.
 *
 *  Both rules exist because the alarm flips truthfully AT the threshold, with no value hysteresis
 *  (CLAUDE.md). A non-positive absolute threshold would be breached by everything, and a signed
 *  threshold of zero is a band of zero width that a value can sit exactly on.
 */
export function thresholdError(compare: string, threshold: number): string | null {
  if (compare === "abs" && threshold <= 0) {
    return "threshold must be positive when compare='abs' (values are compared as absolutes)";
  }
  if (compare === "signed" && threshold === 0) {
    return "signed threshold cannot be 0 (zero-width hysteresis band); use e.g. ±0.01";
  }
  return null;
}

/** The shorter wording the PATCH route uses, kept because the dashboard shows these verbatim. */
export function patchThresholdError(compare: string, threshold: number): string | null {
  if (compare === "abs" && threshold <= 0) return "threshold must be positive when compare='abs'";
  if (compare === "signed" && threshold === 0) return "signed threshold cannot be 0; use e.g. ±0.01";
  return null;
}

export const MonitorIn = z.object({
  strike_date: StrikeDate,
  option_type: z.enum(["CALL", "PUT"]),
  strike: z.number(),
  field: z.string().optional(),
  threshold: z.number(),
  direction: Direction.optional(),
  compare: Compare.optional(),
  enabled: z.boolean().optional(),
});

export const ComboLegIn = z.object({
  /** MINUS IS SHORT: −1 is a leg you sold, +1 a leg you bought. The combo's value is the signed
   *  sum under those signs, so a credit structure's value is the NEGATIVE of its cost to close —
   *  which `compare: abs` is indifferent to, and which is why a position-backed row switches to
   *  `cost_to_close` on the dashboard.
   *
   *  This comment said the opposite until 2026-10-06 ("+ on sold legs watches the cost to close",
   *  ported from the Python's OpenAPI example). Both readings are arithmetically legal and nothing
   *  failed, because the sign is otherwise just a multiplier. It is not harmless: the add-combo
   *  form derives a holding's SIDES from these signs, and the wrong reading inverts every P&L
   *  rather than failing. The relationship is pinned in domain/position.test.ts — "the sign
   *  convention, so neither vocabulary can drift from the other" — rather than left to prose. */
  sign: z.union([z.literal(1), z.literal(-1)]),
  option_type: z.enum(["CALL", "PUT"]),
  strike: z.number(),
});

export const ComboMonitorIn = z.object({
  /** a combo's code IS the name the trader chose; there is no contract to derive one from */
  name: z.string(),
  strike_date: StrikeDate,
  legs: z.array(ComboLegIn).min(2),
  field: z.string().optional(),
  threshold: z.number(),
  direction: Direction.optional(),
  compare: Compare.optional(),
  enabled: z.boolean().optional(),
});

/** Combo first: a combo payload carries `name` and `legs` and no `option_type`, and a single-leg one
 *  the reverse, so the two are disjoint and the order only decides which error text a malformed
 *  payload gets. */
export const MonitorCreateIn = z.union([ComboMonitorIn, MonitorIn]);

export const MonitorPatch = z.object({
  /** combos only: the name IS the code; single-leg codes are contract-derived */
  name: z.string().optional(),
  threshold: z.number().optional(),
  direction: Direction.optional(),
  field: z.string().optional(),
  compare: Compare.optional(),
  enabled: z.boolean().optional(),
});

export const TotalEntryIn = z.object({ entry: z.number() });

export type MonitorInput = z.output<typeof MonitorIn>;
export type ComboMonitorInput = z.output<typeof ComboMonitorIn>;

export function isCombo(payload: z.output<typeof MonitorCreateIn>): payload is ComboMonitorInput {
  return "legs" in payload;
}
