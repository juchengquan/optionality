/** REVIEW's closed trades on the phone (#296, ADR 0023's arrangement B): a list of cards, newest
 *  first, each ONE target that opens its trade on a screen of its own — a bottom sheet, closed by
 *  Back, as every detail on the phone is — with its charts to the close and the correction.
 *
 *  What is open is held as an id and looked up in each render's journal, so the sheet shows the
 *  trade as the service has it after a correction, and closes itself if the trade is gone.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { readUp, type EntryStyle } from "../../prefs";
import { useDismissOnBack } from "../../useDismissOnBack";
import { ClosedTradeDetail, tradeLegs } from "../ClosedTrade";
import { madeWords, storedWords, type ClosedTrade, type Journal } from "../journal";

export function PhoneJournal({ journal, privacy, entryStyle, onCorrected, onDeleted }: {
  journal: Journal; privacy: boolean; entryStyle: EntryStyle; onCorrected: () => void;
  onDeleted: (id: string) => void;
}) {
  const { trades, error } = journal;
  const [openId, setOpenId] = useState<string | null>(null);
  const close = useCallback(() => setOpenId(null), []);
  const trade = openId === null ? null : trades?.find((t) => t.id === openId) ?? null;
  // closed other than by the reader — the trade deleted, here or elsewhere — the sheet forgets it,
  // so no later read can open it again unasked
  const gone = openId !== null && trade === null;
  useEffect(() => { if (gone) setOpenId(null); }, [gone]);

  return (
    <section className="nx-journal nxj-phone" aria-label="closed trades">
      <h2>Closed trades</h2>
      {/* said BESIDE the rows a re-read failed to replace, which stay, as the open trade does */}
      {error !== null ? <p className="nx-hold-error" role="alert">{`the closed trades could not be read — ${error}`}</p> : null}
      {trades === null ? (error === null ? <p className="nxp-meta">reading the closed trades…</p> : null)
          : trades.length === 0 ? <p className="nxp-meta">nothing closed yet: a holding closed is kept here, with its samples</p>
            : (
              <ul className="nxp-cards">
                {trades.map((t) => (
                  <li key={t.id}>
                    <article className="nxp-card nxj-card" data-closed={t.id}>
                      <button type="button" className="nxp-open" aria-label={`details of ${t.name}`}
                              onClick={() => setOpenId(t.id)} />
                      <header className="nxp-head">
                        <span className="nxp-name">{t.name}</span>
                        <span className="nxp-legs">{tradeLegs(t)}</span>
                      </header>
                      <div className="nxj-made">
                        <span data-fig="made" data-outcome={t.realized_points === null ? undefined
                          : t.realized_points > 0 ? "gain" : t.realized_points < 0 ? "loss" : "flat"}>
                          {madeWords(t.realized_points, privacy)}
                        </span>
                        <span className="nxp-meta">made</span>
                      </div>
                      <dl className="nxp-facts">
                        <div><dt>opened</dt><dd data-fig="opened">{t.opened_at ?? "not recorded"}</dd></div>
                        <div><dt>closed</dt><dd data-fig="closed">{t.closed_on}</dd></div>
                        <div><dt>entry</dt><dd data-fig="entry">{storedWords(t.entry)}</dd></div>
                        <div><dt>exit</dt><dd data-fig="exit">{storedWords(t.exit)}</dd></div>
                      </dl>
                    </article>
                  </li>
                ))}
              </ul>
            )}
      <TradeSheet trade={trade} privacy={privacy} entryStyle={entryStyle} onClose={close} onCorrected={onCorrected}
                  onDeleted={onDeleted} />
    </section>
  );
}

function TradeSheet({ trade, privacy, entryStyle, onClose, onCorrected, onDeleted }: {
  trade: ClosedTrade | null; privacy: boolean; entryStyle: EntryStyle; onClose: () => void; onCorrected: () => void;
  onDeleted: (id: string) => void;
}) {
  const open = trade !== null;
  useDismissOnBack(open, onClose);
  // Unmounted while open — REVIEW left for LIVE, or the phone turned into the desk — it takes its
  // Back entry with it, as the book's detail sheet does (Detail.tsx)
  const openNow = useRef(open);
  openNow.current = open;
  useEffect(() => () => {
    if (openNow.current && window.history.state?.panel) window.history.back();
  }, []);
  // the sheet animates out after it closes, and must still have something to draw while it does
  const last = useRef<ClosedTrade | null>(null);
  if (trade) last.current = trade;
  const shown = trade ?? last.current;
  const title = useRef<HTMLHeadingElement>(null);
  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      {/* drawn in a portal OUTSIDE .nx, so it carries the page's colour tokens itself (next.css) */}
      {/* opened on its title, never on the first box: a box focused on a phone brings the keyboard
          up over the trade, and a focus inside the correction form holds the page's poll */}
      <SheetContent side="bottom" className="nx-tokens nxp-sheet" data-up={readUp()} data-entry={entryStyle}
                    initialFocus={title}>
        <SheetHeader>
          <SheetTitle ref={title} tabIndex={-1}>{shown?.name ?? ""}</SheetTitle>
          <SheetDescription>{shown ? `closed on ${shown.closed_on} · ${tradeLegs(shown)}` : ""}</SheetDescription>
        </SheetHeader>
        <div className="nxp-sheet-body">
          {shown ? <ClosedTradeDetail trade={shown} privacy={privacy} onCorrected={onCorrected}
                                      onDeleted={onDeleted} /> : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
