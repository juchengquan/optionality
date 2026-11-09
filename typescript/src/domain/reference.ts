/** What a Reference reads from its quote (ADR 0018, amended by 0019).
 *
 *  A Reference is a Security kept on the page to read the market by: it never alarms, need not be
 *  held, and no rule reads one.
 *
 *  There is no arithmetic left. `scale` was here for SPY×10 standing in for SPX, and ADR 0019
 *  dropped it: a scaled stand-in is a simulation rather than a reading, and the index turned out
 *  to be obtainable from a vendor that will quote it. What remains is the part that was always
 *  the decision — WHICH FIELD IS TRUE — and it was reasoned the wrong way round before it was
 *  measured: on 2026-11-02 SPY's last
 *  trade read 755.72 while its own book gave 758.73, stale from the previous session while the
 *  book was current pre-market. So the mid leads and the last is the fallback — which is also what
 *  every other figure on this dashboard is, so a Reference reading the last by preference would be
 *  the one stale number on the screen.
 *
 *  Here rather than in `routes/` because it is pure and it is a decision: `domain/` is where both
 *  belong since ADR 0017, and the alternative — arithmetic in a route, to dodge the golden-case
 *  guard — is exactly what that guard exists to catch.
 */
import { round4, type Quote } from "./quote.ts";

/** What the strip draws: one figure, the field it came from, and the day's move.
 *
 *  `field` is published rather than kept private so the page can say which number it is showing.
 *  A mid and a last are different claims — one is where the book is, the other where someone
 *  last traded — and a figure whose provenance is invisible is a figure that cannot be checked
 *  against a broker screen.
 */
export interface ReferenceReading {
  /** the figure, rounded, or null where neither field arrived */
  figure: number | null;
  /** "mid_price" | "last_price", or null when there is no figure */
  field: string | null;
  /** the move against the previous close, as a FRACTION of it, or null.
   *
   *  Taken from the SAME field the figure came from, which is the only shape where the two can
   *  disagree: a mid that is present and zero would otherwise report −100% beside a figure that
   *  moved a point. Left unrounded, where the figure is rounded to 4 places — a ratio is about
   *  0.004 and four places would throw away the digits that make it readable as a percent. */
  change: number | null;
}

const NOTHING: ReferenceReading = { figure: null, field: null, change: null };

/** The fields a Reference's figure may come from, in the order of preference. */
const FIELDS = ["mid_price", "last_price"] as const;

/** A quoted price, or null for anything that is not one.
 *
 *  POSITIVE, not merely finite. An empty book quotes 0 on both sides and `(0 + 0) / 2` is a mid,
 *  so a Security nobody is quoting yet arrives with `mid_price: 0` — and 0 prints as a price.
 *  A genuinely worthless far wing therefore reads as a dash
 *  instead of as zero, which is the cheaper of the two mistakes: a dash is not a claim.
 *
 *  `typeof` as well as finite, because moomoo is a wire format with no published schema and a
 *  field can arrive as a string (domain/vol.ts has the same guard, for the same reason).
 */
function price(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** One Reference's reading, or nothing at all. */
export function referenceFigure(quote: Quote | null): ReferenceReading {
  if (!quote) return NOTHING;
  for (const field of FIELDS) {
    const raw = price(quote[field]);
    if (raw === null) continue;
    const previous = price(quote.prev_close_price);
    return {
      figure: round4(raw),
      field,
      // the same field on both sides of the subtraction: a figure taken from the book and a change
      // measured from the last trade would be a pair of numbers that cannot both be true
      change: previous === null ? null : (raw - previous) / previous,
    };
  }
  return NOTHING;
}
