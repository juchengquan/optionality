/** What the API accepts for a monitor (ADR 0009, phase 5).
 *
 *  Optional fields are written `.optional()` with their defaults applied where the value is used,
 *  rather than `.default()` — see validate.ts for why that is forced by how `hc` types a request.
 *  The defaults themselves are named here so they are still declared once.
 */
import { z } from "zod";

import { normalizeStrikeDate } from "optionality/domain/contract";
import { thresholdFault } from "optionality/domain/monitor";

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
 *  "unreadable" is the third Quarantine, for a row the engine cannot hydrate at all — corrupt
 *  `legs`, or a `strike_date` the domain refuses. It cannot be evaluated and it cannot be drawn, so
 *  it is disabled with a notice rather than allowed to fail the sweep for everything else.
 *
 *  "unknown-contract" and "no-figure" are the two Quarantines — the service's own doing, because
 *  the rule cannot be evaluated — and "manual" is the owner's. "holding-closed" is the owner's too,
 *  one step removed: closing a holding switches off the rules that watched it, because a rule left
 *  on would go on alarming about contracts no longer held (ADR 0022). It is written by the
 *  `/positions/{id}/close` route, never by the engine, and it sends no notice — the owner did it,
 *  and the close's own answer says which rules it took. The dashboard groups its muted
 *  tables BY this string, and a reason it has no group for renders in no group at all: the row
 *  disappears from the page while sitting disabled in the database. So the list is published here
 *  and the dashboard is held to it.
 */
export const DISABLED_REASONS =
  ["unknown-contract", "no-figure", "unreadable", "expired", "manual", "holding-closed"] as const;
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
  // one literal of two values rather than a union of two literals, which answered a 2 here with
  // "Invalid input" and nothing about what it would have taken
  sign: z.literal([1, -1]),
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

/** Either shape, as the request is DOCUMENTED and typed: what `/openapi.json` and `hc` describe,
 *  and what the dashboard's tests parse its bodies with. The route does not validate with it —
 *  see `monitorCreateMember`. */
export const MonitorCreateIn = z.union([ComboMonitorIn, MonitorIn]);

/** The member a body is meant for, by its shape: a combo carries `legs`, the same test `isCombo`
 *  puts to a parsed one. The route validates against this member alone.
 *
 *  A union refused by both members answers "Invalid input" and nothing else, because it cannot
 *  know whose complaint applies: an unreadable strike date, a missing threshold and an empty body
 *  all read the same, and the dashboard prints that `detail` verbatim. The shape can know. It also
 *  stops a body carrying `legs` but no `name` being taken as a single-leg rule with its legs
 *  dropped, which the union did because the second member accepted what the first refused.
 */
export function monitorCreateMember(body: unknown): typeof ComboMonitorIn | typeof MonitorIn {
  return typeof body === "object" && body !== null && "legs" in body ? ComboMonitorIn : MonitorIn;
}

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

type ComboMonitorInput = z.output<typeof ComboMonitorIn>;

export function isCombo(payload: z.output<typeof MonitorCreateIn>): payload is ComboMonitorInput {
  return "legs" in payload;
}
