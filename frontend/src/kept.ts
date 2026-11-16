import type { Entry, Holding, Monitor } from "./shared/api";
import { placeBook, type PlacedHolding } from "./placement";

/** The holding open in the desk's inspector or the phone's sheet, kept through a failed valuation.
 *
 *  A valuation that fails takes the holdings out of the book (`holdings` is null, the error said
 *  instead): nobody can vouch for their figures, and the needs-you line must not go on reading a
 *  Level from them. But the one holding the owner has OPEN is not the book: closing it there threw
 *  away whatever was half typed into its Edit, Close or Delete, over one poll the Provider missed.
 *  So while the absence is a failure's — `holdings` null, and `kept` the last valuation that
 *  succeeded (`useBook`'s `holdingsKept`, without what was closed or deleted here) — the open
 *  holding is drawn from that last valuation, placed with its rules as the book would place it,
 *  and said to be stale by whoever draws it. A SUCCESSFUL answer that lacks it is the only thing
 *  that closes it: closed here, or by another device.
 *
 *  Only for what is already open: the book itself never draws `kept`.
 *
 *  @returns the holding with its rules, or null where it is in the book, or gone for good
 */
export function keptHolding(
  id: string | null, quotes: Entry[], holdings: Holding[] | null, kept: Holding[] | null | undefined,
  monitors: Monitor[],
): PlacedHolding | null {
  if (id === null || holdings !== null || !kept?.some((h) => h.id === id)) return null;
  for (const g of placeBook(quotes, kept, monitors).holdings) {
    for (const p of g.rows.flat()) if (p.holding.id === id) return p;
  }
  return null;
}

/** What a holding drawn from `kept` says, at the top of the inspector or the sheet, beside its
 *  figures: the book under a sheet, which says the valuation failed, is covered by it. */
export const STALE_WORDS = "as last valued — the holdings could not be valued since";
