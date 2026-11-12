/** One closed trade, opened from REVIEW's journal (#296): its figures, its burndown and IV through
 *  `/positions/{id}/samples` — which serves no day after the close (ADR 0022), so the charts end
 *  there — the correction a mistyped close takes, the same form a close's account offers
 *  (`ClosedResult.tsx`), and the delete a trade recorded by mistake takes, behind the question a
 *  held holding's delete asks (ADR 0022: the closed list carries both remedies). Drawn under the
 *  desk's journal and in the phone's sheet alike.
 *
 *  The figures are the journal's, read from `GET /positions` as the service has them NOW: a
 *  correction asks the page to read the journal again rather than drawing what was typed, and the
 *  charts are keyed by the close day, so a day moved is a day read again — the samples it hides
 *  are the service's to say.
 */
import { useEffect, useId, useRef, useState } from "react";

import "./journal.css";
import { Correction } from "./ClosedResult";
import { DeleteAsk } from "./HoldingActions";
import { HoldingHistory } from "./History";
import { madeWords, storedWords, type ClosedTrade } from "./journal";
import { contractsWords } from "./phone/figures";

/** `-P6000 +P5950`: the legs as the book writes a holding's, short as minus. */
export function tradeLegs(trade: ClosedTrade): string {
  return trade.legs.map((l) => `${l.side === "short" ? "-" : "+"}${l.option_type[0]}${l.strike}`).join(" ");
}

export function ClosedTradeDetail({ id, trade, privacy, onCorrected, onDeleted, heading = false }: {
  /** the element's id, for the row that opens it to name in `aria-controls` */
  id?: string;
  trade: ClosedTrade;
  privacy: boolean;
  /** the page reads the journal again: what was corrected is drawn as the service now has it */
  onCorrected: () => void;
  /** deleted: the journal takes it out, and whatever showed it closes */
  onDeleted: (id: string) => void;
  /** the desk's: a heading of its own, brought into view with the focus on it when a row opens it —
   *  beneath a long table it would otherwise open off the screen. The phone's sheet has a title. */
  heading?: boolean;
}) {
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!heading) return;
    title.current?.scrollIntoView?.({ block: "nearest" });
    title.current?.focus({ preventScroll: true });
  }, [heading, trade.id]);
  return (
    <section id={id} className="nx-trade" aria-label={`closed trade ${trade.name}`}>
      {heading ? <h3 ref={title} tabIndex={-1} className="nx-trade-h">{trade.name}</h3> : null}
      <dl className="nx-trade-facts">
        <div><dt>legs</dt><dd>{tradeLegs(trade)}</dd></div>
        <div><dt>expiry</dt><dd>{trade.strike_date}</dd></div>
        {/* the count goes under privacy: contracts × points × 100 is the dollars it hides */}
        <div><dt>contracts</dt><dd data-fig="contracts">{contractsWords(trade.contracts, privacy)}</dd></div>
        <div><dt>opened</dt><dd data-fig="opened">{trade.opened_at ?? "not recorded"}</dd></div>
        <div><dt>closed on</dt><dd data-fig="closed">{trade.closed_on}</dd></div>
        <div><dt>entry</dt><dd data-fig="entry">{storedWords(trade.entry)}</dd></div>
        <div><dt>exit</dt><dd data-fig="exit">{storedWords(trade.exit)}</dd></div>
        <div><dt>made</dt><dd data-fig="made"><strong>{madeWords(trade.realized_points, privacy)}</strong></dd></div>
      </dl>
      <p className="nx-meta">
        {trade.realized_points === null
          ? "What it made is unknown: its Exit or its Entry was not recorded. Correct the Exit below if you know it."
          : "Points, Entry less Exit across the contracts held: a closed holding has no quote to give it a dollar size."}
      </p>
      <HoldingHistory key={`${trade.id}:${trade.closed_on}`} holding={trade} privacy={privacy} />
      <Correction key={trade.id} id={trade.id} name={trade.name} closedOn={trade.closed_on} exit={trade.exit}
                  onSaved={onCorrected} />
      <DeleteTrade key={`delete-${trade.id}`} trade={trade} onDeleted={() => onDeleted(trade.id)} />
    </section>
  );
}

/** The other remedy (ADR 0022): a trade recorded by mistake is deleted, its samples with it, behind
 *  the question a held holding's delete asks (`DeleteAsk`). Closed, it has no Monitor to keep. */
function DeleteTrade({ trade, onDeleted }: { trade: ClosedTrade; onDeleted: () => void }) {
  const [asking, setAsking] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();
  const cancel = () => { setAsking(false); button.current?.focus(); };
  return (
    <div className="nx-hold" onKeyDown={(e) => {
      if (e.key !== "Escape" || !asking) return;
      // the question's, not the sheet's nor the page's
      e.preventDefault();
      e.stopPropagation();
      cancel();
    }}>
      <div className="nx-hold-actions">
        <button ref={button} type="button" className="nx-hold-danger" aria-expanded={asking}
                aria-controls={asking ? id : undefined} onClick={() => setAsking((a) => !a)}>Delete…</button>
      </div>
      {asking ? <DeleteAsk id={id} holding={trade} watching={0} onCancel={cancel} onDeleted={onDeleted} /> : null}
    </div>
  );
}
