/** A Pace gap in words (CONTEXT.md: Pace gap; ADR 0011), for every place the page shows one.
 *
 *  "Said in words wherever it is shown, because 'behind' is bad while a positive P&L is good and a
 *  bare sign beside one invites reading the other." The rule is the old page's `PaceLine`, exactly:
 *  positive is BEHIND — costing more to buy back than time alone accounts for — and anything else
 *  is ahead, to two places. One home here, since `PaceLine` went with that page (#301).
 */
import { DASH } from "../shared/format";

export function paceWords(gap: number | null | undefined): string {
  if (gap === null || gap === undefined) return DASH;
  return `${gap > 0 ? "behind" : "ahead"} by ${Math.abs(gap).toFixed(2)}`;
}

/** The outcome colour a gap is drawn in: behind is a loss, ahead a gain, and none for no gap or a
 *  gap of exactly zero — the colour the desk's column already gave the signed figure. */
export function paceOutcome(gap: number | null | undefined): "loss" | "gain" | undefined {
  return gap ? (gap > 0 ? "loss" : "gain") : undefined;
}
