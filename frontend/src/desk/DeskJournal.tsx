/** The closed trades on the desk (#296, ADR 0023's arrangement A): the body of the fold at the
 *  bottom of the book (`JournalFold`, #373), one row per trade, newest first, and the trade a row
 *  opens drawn beneath it — its figures, its charts to the close, the correction and the delete.
 *  Rows of their own rather than rows of the book's table: the table is what is held and watched,
 *  and a closed trade is neither (ADR 0022).
 *
 *  Only what is selected is kept, as an id, and looked up in each render's journal, so a
 *  correction's re-read is what the open trade shows.
 */
import { useEffect, useId, useState } from "react";

import { ClosedTradeDetail, TradeLegs } from "../ClosedTrade";
import { madeWords, storedWords, type Journal } from "../journal";

export function DeskJournal({ journal, privacy, onCorrected, onDeleted }: {
  journal: Journal; privacy: boolean; onCorrected: () => void; onDeleted: (id: string) => void;
}) {
  const { trades, error } = journal;
  const [selected, setSelected] = useState<string | null>(null);
  const current = selected === null ? null : trades?.find((t) => t.id === selected) ?? null;
  // a trade that leaves the journal — deleted, here or elsewhere — takes the selection with it, so
  // a later read can never open it again unasked
  useEffect(() => { if (selected !== null && !current) setSelected(null); }, [selected, current]);
  const detailId = useId();

  return (
    <div className="nxj-desk">
      {/* said BESIDE the rows a re-read failed to replace, which stay: they are the last the
          service said, and the trade open on them stays open */}
      {error !== null ? <p className="nx-hold-error" role="alert">{`the closed trades could not be read — ${error}`}</p> : null}
      {trades === null ? (error === null ? <p className="nx-meta">reading the closed trades…</p> : null)
          : trades.length === 0 ? <p className="nx-meta">nothing closed yet: a holding closed is kept here, with its samples</p>
            : (
              <table className="nxj-table">
                <caption className="nx-meta">newest first · made: Entry less Exit across the contracts held, in points</caption>
                <thead>
                  <tr>
                    <th scope="col">name</th><th scope="col">legs</th><th scope="col">opened</th>
                    <th scope="col">closed</th><th scope="col" data-align="end">entry</th>
                    <th scope="col" data-align="end">exit</th><th scope="col" data-align="end">made</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.map((t) => (
                    <tr key={t.id} data-closed={t.id} data-open={t.id === selected ? "" : undefined}>
                      <th scope="row">
                        <button type="button" aria-expanded={t.id === selected}
                                aria-controls={t.id === selected ? detailId : undefined}
                                onClick={() => setSelected((s) => (s === t.id ? null : t.id))}>{t.name}</button>
                      </th>
                      <td><TradeLegs trade={t} /></td>
                      <td data-fig="opened">{t.opened_at ?? "not recorded"}</td>
                      <td data-fig="closed">{t.closed_on}</td>
                      <td data-fig="entry" data-align="end">{storedWords(t.entry)}</td>
                      <td data-fig="exit" data-align="end">{storedWords(t.exit)}</td>
                      <td data-fig="made" data-align="end"
                          // a gain or a loss in colour, as Money keeps under privacy: a sign says no size
                          data-outcome={t.realized_points === null ? undefined
                            : t.realized_points > 0 ? "gain" : t.realized_points < 0 ? "loss" : "flat"}>
                        {madeWords(t.realized_points, privacy)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
      {current ? <ClosedTradeDetail id={detailId} trade={current} privacy={privacy} onCorrected={onCorrected}
                                    onDeleted={onDeleted} heading /> : null}
    </div>
  );
}
