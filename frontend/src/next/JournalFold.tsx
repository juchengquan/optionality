/** The closed trades folded at the bottom of the book (#373, ADR 0023 amended 2026-11-13), on the
 *  desk and the phone alike: the last thing in the book, after the watchlist, drawn at every hour,
 *  in session and out of it.
 *
 *  - **Shut on every load, and until first opened it mounts nothing**: no row, and so nothing
 *    asked. The page holds whether it is open, and reads the journal only once it has been opened
 *    (`useJournal`'s `on`, which latches: shutting it and opening it again asks nothing more).
 *  - **Once opened, kept mounted and hidden while shut**, as `HistoryOnDemand` is: the trade open
 *    in it and a correction half typed survive a shut. The desk's keys and Escape leave the fold
 *    alone (`desk/keys.ts`), so a form left in it holds nothing of the table's.
 *  - **A button heading, not a `<details>`**, as `HistoryOnDemand` is: `toggle` fires after paint,
 *    so a `<details>` would draw its rows a frame before it said it was open.
 *  - **Opened by a press, it brings its rows into view** once they are there (`ready`: the read
 *    answered, rows or not): at the bottom of a long book they would otherwise open below the
 *    screen, and brought into view at the press itself, before the first read answers, the page
 *    is still too short to scroll to them. To the top of the screen, as far as the page allows —
 *    and only if the page is where it was at the press: a reader who scrolled on is left there.
 */
import { useEffect, useId, useRef, useState } from "react";
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
  // once opened, the journal stays mounted, hidden while shut: a correction half typed and the
  // trade it is typed into are still there on opening it again, and nothing is read for them
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  const section = useRef<HTMLElement>(null);
  // a press that opened it, never a load: it is shut on every load, and a switch of arrangement
  // that redraws it open must not scroll the page to the bottom. Kept as where the page was at the
  // press: a reader who scrolled away while the read was out is left where they went
  const pressed = useRef<number | null>(null);
  useEffect(() => {
    if (!open || !ready || pressed.current === null) return;
    const at = pressed.current;
    pressed.current = null;
    if (Math.abs(window.scrollY - at) > 1) return;
    section.current?.scrollIntoView?.({ block: "start" });
  }, [open, ready]);
  return (
    <section ref={section} className="nx-journal nxj-fold" aria-label="closed trades"
             data-open={open ? "" : undefined}>
      <h2>
        <button type="button" className="nxj-fold-toggle" aria-expanded={open} aria-controls={body}
                onClick={() => { pressed.current = open ? null : window.scrollY; onToggle(); }}>
          <ChevronRight aria-hidden="true" className="nxj-fold-mark" />
          Closed trades
        </button>
      </h2>
      <div id={body} className="nxj-fold-body" hidden={!open}>
        {mounted ? children : null}
      </div>
    </section>
  );
}
