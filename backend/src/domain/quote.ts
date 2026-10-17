/** One contract's live figures, as the sweep caches them (ADR 0009).
 *
 *  Values are `unknown` rather than `string | number | null` because moomoo sends booleans too
 *  (`suspension`) and has no published schema — it is a wire format, not a type. Everything that
 *  reads a field coerces it explicitly, which is also what the Python does: `total += sign * value`
 *  on a bool gives 1 there as `Number(true)` does here.
 */
export type Quote = Record<string, unknown>;
export type ByCode = Record<string, Quote>;

/** A points figure derived from quotes, rounded for a human.
 *
 *  4dp: a credit is quoted in points to two or three places, and rounding is only to keep float
 *  noise (7.4999999999999964) out of a figure the owner reads back or that is stored as an entry.
 */
export function round4(value: number): number {
  return Number(value.toFixed(4));
}
