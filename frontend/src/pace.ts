/** A Pace gap in words (CONTEXT.md: Pace gap; ADR 0011), for every place the page shows one.
 *
 *  "Said in words wherever it is shown, because 'behind' is bad while a positive P&L is good and a
 *  bare sign beside one invites reading the other." The rule is the old page's `PaceLine`, exactly:
 *  positive is BEHIND — costing more to buy back than time alone accounts for — and anything else
 *  is ahead, to two places. One home here, since `PaceLine` went with that page (#301).
 */
import type { Holding } from "./shared/api";
import { DASH } from "./shared/format";

export function paceWords(gap: number | null | undefined): string {
  if (gap === null || gap === undefined) return DASH;
  return `${gap > 0 ? "behind" : "ahead"} by ${Math.abs(gap).toFixed(2)}`;
}

/** The gap as a signed figure, for the desk's column alone, where the words would not fit beside
 *  the market's columns (the owner, #379). The sign is the service's — cost to close less on pace —
 *  so `+` is BEHIND, the bad way, and drawn in the loss colour; `−` (the true minus) is ahead. Its
 *  words go beside it, to a pointer and to a reader: never shown alone without them. */
export function paceSigned(gap: number | null | undefined): string {
  if (gap === null || gap === undefined) return DASH;
  const figure = Math.abs(gap).toFixed(2);
  return gap > 0 ? `+${figure}` : gap < 0 ? `\u2212${figure}` : figure;
}

/** The outcome colour a gap is drawn in: behind is a loss, ahead a gain, and none for no gap or a
 *  gap of exactly zero — the colour the desk's column already gave the signed figure. */
export function paceOutcome(gap: number | null | undefined): "loss" | "gain" | undefined {
  return gap ? (gap > 0 ? "loss" : "gain") : undefined;
}

/** A holding's Cost to close with its pace gap beside it, as the desk's value column and the
 *  phone's card draw them in one field (the owner, 2026-11-16): `text`, "3.05 −1.57", the gap in
 *  `paceSigned`'s compact form; `words`, the same said in full, "3.05, pace gap behind by 1.57", for
 *  a pointer and a reader. No gap, the cost alone; no cost, a dash — a gap without the figure it is
 *  measured on would read as the cost. */
export function costAndPace(h: Pick<Holding, "cost_to_close" | "schedule">): {
  cost: string; gap: string | null; text: string; words: string;
} {
  if (h.cost_to_close === null || h.cost_to_close === undefined) return { cost: DASH, gap: null, text: DASH, words: DASH };
  const cost = h.cost_to_close.toFixed(2);
  const g = h.schedule?.pace_gap;
  if (g === null || g === undefined) return { cost, gap: null, text: cost, words: cost };
  return { cost, gap: paceSigned(g), text: `${cost} ${paceSigned(g)}`, words: `${cost}, pace gap ${paceWords(g)}` };
}
