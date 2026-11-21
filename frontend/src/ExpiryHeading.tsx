/** An expiry's heading in the book, "20261218 · 28 DTE", as the button that folds its group (the
 *  owner, 2026-11-21) — the desk's and the phone's, one drawing.
 *
 *  - **A button heading, not a `<details>`**, as the closed trades' fold is (`JournalFold.tsx`):
 *    `toggle` fires after paint, so a `<details>` would draw its rows a frame before it said it was
 *    open. The button says whether it is open (`aria-expanded`) and what it folds (`aria-controls`,
 *    the group's rows, which stay mounted and hidden while folded); it is a `<button>`, so Enter and
 *    Space press it.
 *  - **Folded, it keeps its date and DTE** and adds the group's row count and a chip per kind of
 *    attention in it, counted — "20261218 · 28 DTE · 4 rows · 4 entry signals", or "3 cards" on the
 *    phone — in the chips' own words and colours (`foldedSummary`). Open, it says the date and DTE
 *    alone, as it always did.
 */
import { Fragment } from "react";
import { ChevronRight } from "lucide-react";

import { AttentionChip } from "./AttentionChip";
import { foldedSummary } from "./folds";
import type { ExpiryBook } from "./placement";
import { writtenDate } from "./shared/times";

import "./fold.css";

export function ExpiryHeading({ g, folded, controls, onToggle, className, dteClassName, counts }: {
  g: ExpiryBook;
  folded: boolean;
  /** the id of the group's rows */
  controls: string;
  /** given the heading's button, which the desk hands the focus back to (DeskBook's `foldGroup`) */
  onToggle: (button: HTMLButtonElement) => void;
  className: string;
  /** the DTE's own weight, where the arrangement draws it apart from the date */
  dteClassName?: string;
  /** what the arrangement draws, which a folded heading counts: the desk's rows, the phone's cards */
  counts: "rows" | "cards";
}) {
  const summary = folded ? foldedSummary(g, counts) : null;
  return (
    <h3 className={className}>
      <button type="button" className="nx-expiry-toggle" aria-expanded={!folded} aria-controls={controls}
              onClick={(e) => onToggle(e.currentTarget)}>
        <ChevronRight aria-hidden="true" className="nx-expiry-mark" />
        <span className="nx-expiry-words">
          {/* each piece whole with the dot before it, the spaces between them where a narrow
              screen wraps the heading */}
          {`${writtenDate(g.expiry)} `}
          <span className={`nx-expiry-piece ${dteClassName ?? ""}`.trim()}>{`· ${g.dte} DTE`}</span>
          {summary ? (
            <>
              {" "}<span className="nx-expiry-piece">{`· ${summary.rows}`}</span>
              {summary.needs.map((n) => (
                <Fragment key={n.kind}>
                  {" "}<span className="nx-expiry-piece">{"· "}<AttentionChip kind={n.kind} words={n.words} /></span>
                </Fragment>
              ))}
            </>
          ) : null}
        </span>
      </button>
    </h3>
  );
}
