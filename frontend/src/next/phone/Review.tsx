/** REVIEW on the phone (ADR 0023): one holding per screen, paged by a swipe or by the arrows, with
 *  its figures. Its burndown becomes the page's main chart in a later slice (#291). */
import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import type { Entry, Monitor } from "../../api";
import { DASH } from "../../format";
import { Money } from "../Book";
import type { PlacedHolding } from "../placement";
import { LevelChip, RuleLine } from "./Cards";
import { expiryWords, holdingLegs, percent, points, shortDeltas, shortDeltaWords } from "./figures";

export function ReviewPager({ placed, quotes, monitors, privacy, onOpen }: {
  placed: PlacedHolding[]; quotes: Entry[]; monitors: Monitor[]; privacy: boolean;
  onOpen: (id: string) => void;
}) {
  const [index, setIndex] = useState(0);
  const at = Math.min(index, Math.max(0, placed.length - 1));
  const track = useRef<HTMLDivElement>(null);
  // where a press of an arrow is taking the track: the scroll events on the way there are not
  // the reader swiping, and must not move the index back to a page being scrolled past
  const heading = useRef<number | null>(null);

  useEffect(() => {
    const el = track.current;
    if (!el || el.clientWidth === 0) return;
    const left = at * el.clientWidth;
    if (Math.abs(el.scrollLeft - left) < 2) return;
    heading.current = left;
    const still = matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo?.({ left, behavior: still ? "auto" : "smooth" });
  }, [at]);

  const onScroll = () => {
    const el = track.current;
    if (!el || el.clientWidth === 0) return;
    if (heading.current !== null) {
      if (Math.abs(el.scrollLeft - heading.current) >= 2) return;
      heading.current = null;
    }
    const i = Math.round(el.scrollLeft / el.clientWidth);
    if (i !== at) setIndex(i);
  };

  if (placed.length === 0) return null;
  return (
    <div className="nxp-pager">
      <div className="nxp-track" ref={track} onScroll={onScroll}>
        {placed.map(({ holding, rules }, i) => {
          const s = holding.schedule;
          return (
            <article key={holding.id} className="nxp-page" data-page="" data-ref={holding.id}
                     aria-label={`${holding.name}, ${i + 1} of ${placed.length}`}>
              <div className="nxp-card">
                <header className="nxp-head">
                  <span className="nxp-name">{holding.name}</span>
                  <span className="nxp-legs">{holdingLegs(holding)}</span>
                  <span className="nxp-pill">{`${holding.dte} DTE`}</span>
                </header>
                <p className="nxp-meta">{`×${holding.contracts} · ${expiryWords(holding.strike_date)} · opened ${holding.opened_at ?? DASH}`}</p>
                <div className="nxp-hero">
                  <Money value={holding.pnl} privacy={privacy} />
                  <span className="nxp-hero-sub">unrealised</span>
                  <LevelChip holding={holding} />
                </div>
                <dl className="nxp-facts">
                  <div><dt>captured</dt><dd>{percent(holding.captured)}</dd></div>
                  <div><dt>cost to close</dt><dd>{points(holding.cost_to_close)}</dd></div>
                  <div><dt>entry</dt><dd>{points(holding.entry)}</dd></div>
                  <div><dt>pace gap</dt><dd>{points(s?.pace_gap)}</dd></div>
                  <div><dt>manage-by</dt><dd>{s ? `at ${s.manage_by_dte} DTE` : DASH}</dd></div>
                  <div><dt>short Δ</dt><dd>{shortDeltaWords(shortDeltas(holding, quotes, monitors))}</dd></div>
                </dl>
                {s ? null : <p className="nxp-meta">no schedule — Opened not recorded</p>}
                {rules.length > 0
                  ? <ul className="nxp-rules">{rules.map((r) => <RuleLine key={r.id} entry={r} />)}</ul> : null}
                <button type="button" className="nxp-more" onClick={() => onOpen(holding.id)}>
                  detail and Monitors
                </button>
              </div>
            </article>
          );
        })}
      </div>
      <div className="nxp-pager-nav">
        <button type="button" aria-label="previous holding" disabled={at === 0}
                onClick={() => setIndex(at - 1)}><ChevronLeft aria-hidden="true" /></button>
        <span className="nxp-meta" aria-live="polite">{`${at + 1} of ${placed.length}`}</span>
        <button type="button" aria-label="next holding" disabled={at === placed.length - 1}
                onClick={() => setIndex(at + 1)}><ChevronRight aria-hidden="true" /></button>
      </div>
    </div>
  );
}
