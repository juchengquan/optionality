/** The closed trades folded at the bottom of the book (#373, ADR 0023 amended 2026-11-13), on the
 *  desk and the phone alike: the last thing in the book, after the watchlist, drawn at every hour
 *  and in either mode.
 *
 *  - **Shut on every load, and shut it mounts nothing**: no row, and so nothing asked. The page
 *    holds whether it is open, and reads the journal only once it has been opened (`useJournal`'s
 *    `on`, which latches: shutting it and opening it again asks nothing more).
 *  - **A button heading, not a `<details>`**, as `HistoryOnDemand` is: `toggle` fires after paint,
 *    so a `<details>` would draw its rows a frame before it said it was open.
 *  - **Opened by a press, it brings its rows into view** once they are there (`ready`: the read
 *    answered, rows or not): at the bottom of a long book they would otherwise open below the
 *    screen, and brought into view at the press itself, before the first read answers, the page
 *    is still too short to scroll to them. To the top of the screen, as far as the page allows.
 */
import { useEffect, useId, useRef } from "react";
import { ChevronRight } from "lucide-react";

import "./journal.css";

export function JournalFold({ open, ready, onToggle, children }: {
  open: boolean;
  /** the journal has an answer to draw — its rows, none, or why they could not be read */
  ready: boolean;
  onToggle: () => void;
  /** the arrangement's journal, mounted only while the fold is open */
  children: React.ReactNode;
}) {
  const body = useId();
  const section = useRef<HTMLElement>(null);
  // a press that opened it, never a load: it is shut on every load, and a switch of arrangement
  // that redraws it open must not scroll the page to the bottom
  const pressed = useRef(false);
  useEffect(() => {
    if (!open || !ready || !pressed.current) return;
    pressed.current = false;
    section.current?.scrollIntoView?.({ block: "start" });
  }, [open, ready]);
  return (
    <section ref={section} className="nx-journal nxj-fold" aria-label="closed trades"
             data-open={open ? "" : undefined}>
      <h2>
        <button type="button" className="nxj-fold-toggle" aria-expanded={open} aria-controls={body}
                onClick={() => { pressed.current = !open; onToggle(); }}>
          <ChevronRight aria-hidden="true" className="nxj-fold-mark" />
          Closed trades
        </button>
      </h2>
      <div id={body} className="nxj-fold-body" hidden={!open}>
        {open ? children : null}
      </div>
    </section>
  );
}
