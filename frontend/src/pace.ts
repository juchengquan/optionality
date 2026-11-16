/** A Pace gap in words (CONTEXT.md: Pace gap; ADR 0011), for every place the page shows one.
 *
 *  "Said in words wherever it is shown, because 'behind' is bad while a positive P&L is good and a
 *  bare sign beside one invites reading the other." The rule is the old page's `PaceLine`, exactly:
 *  positive is BEHIND — costing more to buy back than time alone accounts for — and anything else
 *  is ahead, to two places. One home here, since `PaceLine` went with that page (#301).
 */
import type { Holding } from "./shared/api";
import { DASH } from "./shared/format";
import { points } from "./shared/numbers";

/** A gap that is nothing to the two places it is written in: said "on pace", in no colour — never
 *  "ahead by 0.00", which named a side the figure did not show (review of #415). */
const none = (gap: number) => Math.abs(gap).toFixed(2) === "0.00";

export function paceWords(gap: number | null | undefined): string {
  if (gap === null || gap === undefined) return DASH;
  if (none(gap)) return "on pace";
  return `${gap > 0 ? "behind" : "ahead"} by ${Math.abs(gap).toFixed(2)}`;
}

/** The gap as a signed figure, for the desk's column alone, where the words would not fit beside
 *  the market's columns (the owner, #379). The sign is the service's — cost to close less on pace —
 *  so `+` is BEHIND, the bad way, and drawn in the loss colour; `−` (the true minus) is ahead. Its
 *  words go beside it, to a pointer and to a reader: never shown alone without them. */
export function paceSigned(gap: number | null | undefined): string {
  if (gap === null || gap === undefined) return DASH;
  const figure = Math.abs(gap).toFixed(2);
  if (none(gap)) return figure;
  return gap > 0 ? `+${figure}` : `\u2212${figure}`;
}

/** The outcome colour a gap is drawn in: behind is a loss, ahead a gain, and none for no gap or a
 *  gap of exactly zero — the colour the desk's column already gave the signed figure. */
export function paceOutcome(gap: number | null | undefined): "loss" | "gain" | undefined {
  return gap && !none(gap) ? (gap > 0 ? "loss" : "gain") : undefined;
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
  const cost = points(h.cost_to_close);
  const g = h.schedule?.pace_gap;
  if (g === null || g === undefined) return { cost, gap: null, text: cost, words: cost };
  const said = none(g) ? "on pace" : `pace gap ${paceWords(g)}`;
  return { cost, gap: paceSigned(g), text: `${cost} ${paceSigned(g)}`, words: `${cost}, ${said}` };
}

/** Manage-by as days left, "in 24d", or "due" once reached — the same words on the desk's column,
 *  its inspector, the phone's sheet and the picture (the owner's standard, part F) — with the
 *  threshold it counts to as detail, "at 21 DTE". A dash with no schedule. */
export function manageBy(h: Pick<Holding, "dte" | "schedule">): { text: string; detail: string | null } {
  const s = h.schedule;
  if (!s) return { text: DASH, detail: null };
  return { text: s.manage_by_due ? "due" : `in ${h.dte - s.manage_by_dte}d`, detail: `at ${s.manage_by_dte} DTE` };
}
