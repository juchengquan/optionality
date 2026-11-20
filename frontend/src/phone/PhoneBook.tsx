import { useCallback, useEffect, useId, useMemo, useState } from "react";

import "./phone.css";
import type { BookProps } from "../Book";
import { Money } from "../Book";
import { ClosedLine } from "../ClosedLine";
import { NOTHING, placeBook, type BookModel, type ExpiryBook, type PlacedHolding } from "../placement";
import { keptHolding } from "../kept";
import { HoldingCard, OffList, RuleCard } from "./Cards";
import { DetailSheet, type Subject } from "./Detail";
import { ExpiryHeading } from "../ExpiryHeading";
import { useFolds, type SectionKind } from "../folds";
import { ErrorWords } from "../shared/ErrorWords";
import { SpxNote } from "../StrikeStrip";
import { bookSpxReasons } from "../strip";

/** The phone's book, arrangement B (ADR 0023, #290): cards and the detail sheet — ONE book, by
 *  expiry, holdings and watches together (2026-11-17), the same cards in session and out of it (#374; ADR 0023 amended 2026-11-13), with no pager: a
 *  holding's history is in its sheet, open from the start outside the session.
 *
 *  It DRAWS `placeBook` and decides nothing about where a rule sits, so the phone cannot group the
 *  owner's book differently from the desk. What is open in the sheet is held as an id and looked
 *  up in each render's figures, so the sheet follows the poll rather than freezing the moment it
 *  was opened, and closes itself if what it shows is gone.
 */
export function PhoneBook({
  quotes, monitors, holdings, holdingsKept, holdingsError, holdingsAt, holdingsServed, session, phase, privacy,
  entryStyle, writes,
  journal,
}: BookProps) {
  const placed = useMemo(() => placeBook(quotes, holdings, monitors), [quotes, holdings, monitors]);
  // which expiry groups the viewer folded (the owner, 2026-11-21), the desk's cookie
  const folds = useFolds(placed, holdings !== null);
  const [openId, setOpenId] = useState<string | null>(null);
  const close = useCallback(() => setOpenId(null), []);
  const live = openId === null ? null : find(placed, openId);
  // a holding out of the book only because a valuation failed stays open, on its last valued
  // figures, with whatever was typed into its forms (`kept.ts`)
  const kept = live ? null : keptHolding(openId, quotes, holdings, holdingsKept, monitors);
  const subject: Subject | null = live ?? (kept ? { kind: "holding", ...kept } : null);
  // Gone — closed, deleted, or a rule deleted — the sheet has closed and given its Back
  // entry up, so it is forgotten: the next poll that brings the row back must not reopen a sheet
  // nobody asked for, pushing a second entry as it does.
  const gone = openId !== null && subject === null;
  useEffect(() => { if (gone) setOpenId(null); }, [gone]);

  const empty = placed.book.length === 0 && placed.unplaced.length === 0 && placed.quarantined.length === 0;
  // why SPX is not current, said once for the book rather than on every card's strip (2026-11-17)
  const spxReasons = bookSpxReasons(holdings, quotes);
  const spxSaid = spxReasons.length > 0;
  const status = (
    <>
      {/* outside the session (#371): when the service valued what is drawn; the header's refresh
          values it again (#410). In the Curb and GTH, that the quotes are live and thin (#416) */}
      {(phase ?? (session ? "regular" : "closed")) !== "regular"
        ? <ClosedLine at={holdings !== null ? holdingsAt : null} served={holdingsServed} holdings={holdings}
                      phase={phase ?? "closed"} className="nxp-meta" /> : null}
      <SpxNote reasons={spxReasons} className="nxp-meta" />
      {holdingsError !== null
        ? <div className="nxp-meta">{"the holdings could not be valued — "}<ErrorWords raw={holdingsError} again="refresh to try again" /></div> : null}
      {holdings === null && holdingsError === null ? <p className="nxp-meta">valuing…</p> : null}
      {/* one line for an empty book, whichever half is missing (2026-11-17) */}
      {holdings !== null && empty ? <p className="nxp-meta">{NOTHING}</p> : null}
    </>
  );

  const unplaced = placed.unplaced.length > 0 ? (
    <section className="nxp-expiry" data-testid="unplaced">
      <h3>Rules on held contracts</h3>
      <p className="nxp-meta">
        {holdings === null
          ? "the holdings are not valued, so the rules about them are listed on their own"
          : "each watches a held contract that no single holding owns, as on a roll day"}
      </p>
      <ul className="nxp-cards">
        {placed.unplaced.map((e) => (
          <li key={e.id}><RuleCard entry={e} onOpen={() => setOpenId(e.id)} spxSaid={spxSaid} /></li>
        ))}
      </ul>
    </section>
  ) : null;

  return (
    <div className="nx-book nxp-book">
      {/* the book in two sections (2026-11-17): Spreads, then Contracts, each by expiry */}
      <section aria-labelledby="nxp-book">
        <h2 id="nxp-book" className="sr-only">Book</h2>
        {status}
        {placed.sections.map((s) => (
          <section key={s.kind} className="nxp-part" data-section={s.kind} aria-labelledby={`nxp-part-${s.kind}`}>
            <h2 id={`nxp-part-${s.kind}`}>{s.title}</h2>
            {s.expiries.map((g) => (
              <Expiry key={g.expiry} g={g} kind={s.kind} folded={folds.folded(s.kind, g.expiry)} onToggle={folds.toggle}>
                {g.held.map((row) => (
                  <li key={row.map((p) => p.holding.id).join("+")}>
                    {row.length === 2 ? (
                      <Condor row={row} privacy={privacy}>
                        {row.map((p) => (
                          <HoldingCard key={p.holding.id} placed={p} quotes={quotes} monitors={monitors}
                                       privacy={privacy} session={session} onOpen={() => setOpenId(p.holding.id)} spxSaid={spxSaid} />
                        ))}
                      </Condor>
                    ) : row.map((p) => (
                      <HoldingCard key={p.holding.id} placed={p} quotes={quotes} monitors={monitors}
                                   privacy={privacy} session={session} onOpen={() => setOpenId(p.holding.id)} spxSaid={spxSaid} />
                    ))}
                  </li>
                ))}
                {[...g.spreads, ...g.contracts].map(({ entry, overlap }) => (
                  <li key={entry.id}>
                    <RuleCard entry={entry} overlap={overlap} onOpen={() => setOpenId(entry.id)} spxSaid={spxSaid} />
                  </li>
                ))}
              </Expiry>
            ))}
          </section>
        ))}
        {unplaced}
      </section>

      {placed.quarantined.length + placed.muted.length > 0 ? (
        <section aria-labelledby="nxp-off">
          <h2 id="nxp-off">Switched off</h2>
          <OffList quarantined={placed.quarantined} muted={placed.muted} />
        </section>
      ) : null}

      {/* the closed trades' fold (#373): the last thing in the book, at every hour */}
      {journal}

      <DetailSheet subject={subject} onClose={close} quotes={quotes} monitors={monitors}
                   privacy={privacy} entryStyle={entryStyle} writes={writes} session={session} stale={kept !== null} />
    </div>
  );
}

/** One expiry of a section: its heading — "20261231 · 45 DTE", as the desk's group heading writes it
 *  (2026-11-17), the DTE in the meta weight — and its cards, which the heading folds (the owner,
 *  2026-11-21); folded, they stay mounted, hidden. */
function Expiry({ g, kind, folded, onToggle, children }: {
  g: ExpiryBook; kind: SectionKind; folded: boolean; onToggle: (kind: SectionKind, expiry: string) => void;
  children: React.ReactNode;
}) {
  const body = useId();
  return (
    <section className="nxp-expiry" data-expiry={g.expiry} data-folded={folded ? "" : undefined}>
      <ExpiryHeading g={g} folded={folded} controls={body} onToggle={() => onToggle(kind, g.expiry)}
                     className="nxp-expiry-head" dteClassName="nxp-meta" />
      <ul id={body} className="nxp-cards nx-expiry-body" hidden={folded}>{children}</ul>
    </section>
  );
}

/** A condor held as two spreads: its two cards together, under one line with their summed P&L —
 *  summed only when both are known, as a combo never sums a partial (CLAUDE.md: Combos). */
function Condor({ row, privacy, children }: { row: PlacedHolding[]; privacy: boolean; children: React.ReactNode }) {
  const pnls = row.map((p) => p.holding.pnl);
  const total = pnls.every((v): v is number => v !== null) ? pnls.reduce((a, b) => a + b, 0) : null;
  return (
    <div className="nxp-condor" role="group" aria-label="iron condor, two spreads">
      <p className="nxp-condor-head">
        <span>iron condor · two spreads</span>
        <Money value={total} privacy={privacy} />
      </p>
      {children}
    </div>
  );
}

/** What the sheet shows for an id, from THIS render's book: a holding, or a rule wherever it sits. */
function find(placed: BookModel, id: string): Subject | null {
  for (const g of placed.book) {
    for (const p of g.held.flat()) if (p.holding.id === id) return { kind: "holding", ...p };
    for (const item of [...g.spreads, ...g.contracts]) if (item.entry.id === id) return { kind: "rule", ...item };
  }
  const lone = placed.unplaced.find((e) => e.id === id);
  return lone ? { kind: "rule", entry: lone } : null;
}
