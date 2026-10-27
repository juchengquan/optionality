/** What the API accepts for a monitor (ADR 0009, phase 5).
 *
 *  Optional fields are written `.optional()` with their defaults applied where the value is used,
 *  rather than `.default()` — see validate.ts for why that is forced by how `hc` types a request.
 *  The defaults themselves are named here so they are still declared once.
 */
import { z } from "zod";

import { normalizeStrikeDate } from "../domain/contract.ts";
import { thresholdFault } from "../domain/monitor.ts";

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

/** Every reason the service writes into `disabled_reason`, named once.
 *
 *  "unknown-contract" and "no-figure" are the two Quarantines — the service's own doing, because
 *  the rule cannot be evaluated — and "manual" is the owner's. The dashboard groups its muted
 *  tables BY this string, and a reason it has no group for renders in no group at all: the row
 *  disappears from the page while sitting disabled in the database. So the list is published here
 *  and the dashboard is held to it.
 */
export const DISABLED_REASONS = ["unknown-contract", "no-figure", "expired", "manual"] as const;
export type DisabledReason = (typeof DISABLED_REASONS)[number];

const Direction = z.enum(["above", "below"]);
const Compare = z.enum(["abs", "signed"]);

/** The API's wording for a threshold the rule refuses, or null.
 *
 *  The rule itself is `thresholdFault` in domain/monitor.ts, beside the `isBreached` it protects.
 *  It was written out here, again for PATCH below, and a third time in the bot — twice under this
 *  same name with the arguments in opposite orders. Only the sentences differ, so only the
 *  sentences stay at the edges.
 */
export function thresholdError(compare: string, threshold: number): string | null {
  switch (thresholdFault(compare, threshold)) {
    case "abs-not-positive":
      return "threshold must be positive when compare='abs' (values are compared as absolutes)";
    case "signed-zero":
      return "signed threshold cannot be 0 (zero-width hysteresis band); use e.g. ±0.01";
    default:
      return null;
  }
}

/** The shorter wording the PATCH route uses, kept because the dashboard shows these verbatim. */
export function patchThresholdError(compare: string, threshold: number): string | null {
  switch (thresholdFault(compare, threshold)) {
    case "abs-not-positive": return "threshold must be positive when compare='abs'";
    case "signed-zero": return "signed threshold cannot be 0; use e.g. ±0.01";
    default: return null;
  }
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
  /** MINUS IS SHORT: −1 is a short leg, +1 a long one. The combo's value is the signed
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
