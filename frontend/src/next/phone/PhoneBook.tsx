import { useCallback, useState } from "react";

import "./phone.css";
import type { BookProps } from "../Book";
import { Money } from "../Book";
import { placeBook, type BookModel, type PlacedHolding } from "../placement";
import { HoldingCard, OffList, RuleCard } from "./Cards";
import { DetailSheet, type Subject } from "./Detail";
import { expiryWords } from "./figures";
import { ReviewPager } from "./Review";

/** The phone's book, arrangement B (ADR 0023, #290): cards, the detail sheet, and REVIEW's one
 *  holding per screen.
 *
 *  It DRAWS `placeBook` and decides nothing about where a rule sits, so the phone cannot group the
 *  owner's book differently from the desk. What is open in the sheet is held as an id and looked
 *  up in each render's figures, so the sheet follows the poll rather than freezing the moment it
 *  was opened, and closes itself if what it shows is gone.
 */
export function PhoneBook({ quotes, monitors, holdings, holdingsError, holdingsAt, mode, privacy, entryStyle }: BookProps) {
  const placed = placeBook(quotes, holdings, monitors);
  const [openId, setOpenId] = useState<string | null>(null);
  const close = useCallback(() => setOpenId(null), []);
  const subject = openId === null ? null : find(placed, openId);
  const flat = placed.holdings.flatMap((g) => g.rows.flat());

  const status = (
    <>
      {holdingsError !== null ? <p className="nxp-meta">{`the holdings could not be valued — ${holdingsError}`}</p> : null}
      {holdings === null && holdingsError === null ? <p className="nxp-meta">valuing…</p> : null}
      {holdings !== null && holdings.length === 0 ? <p className="nxp-meta">nothing held</p> : null}
    </>
  );

  const unplaced = placed.unplaced.length > 0 ? (
    <section className="nxp-expiry" data-testid="unplaced">
      <h3>rules on held contracts</h3>
      <p className="nxp-meta">
        {holdings === null
          ? "the holdings are not valued, so the rules about them are listed on their own"
          : "each watches a held contract that no single holding owns, as on a roll day"}
      </p>
      <ul className="nxp-cards">
        {placed.unplaced.map((e) => (
          <li key={e.id}><RuleCard entry={e} under={[]} onOpen={() => setOpenId(e.id)} /></li>
        ))}
      </ul>
    </section>
  ) : null;

  return (
    <div className="nx-book nxp-book">
      {mode === "live" ? (
        <section aria-labelledby="nxp-holdings">
          <h2 id="nxp-holdings">Holdings</h2>
          {status}
          {placed.holdings.map(({ expiry, rows }) => (
            <section key={expiry} className="nxp-expiry" data-expiry={expiry}>
              <ExpiryHead expiry={expiry} dte={rows[0]![0]!.holding.dte} />
              <ul className="nxp-cards">
                {rows.map((row) => (
                  <li key={row.map((p) => p.holding.id).join("+")}>
                    {row.length === 2 ? (
                      <Condor row={row} privacy={privacy}>
                        {row.map((p) => (
                          <HoldingCard key={p.holding.id} placed={p} quotes={quotes} monitors={monitors}
                                       privacy={privacy} onOpen={() => setOpenId(p.holding.id)} />
                        ))}
                      </Condor>
                    ) : row.map((p) => (
                      <HoldingCard key={p.holding.id} placed={p} quotes={quotes} monitors={monitors}
                                   privacy={privacy} onOpen={() => setOpenId(p.holding.id)} />
                    ))}
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {unplaced}
        </section>
      ) : (
        <section aria-labelledby="nxp-review">
          <h2 id="nxp-review">Review</h2>
          {status}
          {holdings !== null && holdingsAt ? <p className="nxp-meta">{`valued at ${holdingsAt}`}</p> : null}
          <ReviewPager placed={flat} quotes={quotes} monitors={monitors} privacy={privacy} onOpen={setOpenId} />
          {unplaced}
        </section>
      )}

      <section aria-labelledby="nxp-watchlist">
        <h2 id="nxp-watchlist">Watchlist</h2>
        {placed.watchlist.length === 0 ? <p className="nxp-meta">nothing watched</p> : null}
        {placed.watchlist.map(({ expiry, items }) => (
          <section key={expiry} className="nxp-expiry" data-expiry={expiry}>
            <ExpiryHead expiry={expiry} dte={items[0]!.entry.dte} />
            <ul className="nxp-cards">
              {items.map(({ entry, under }) => (
                <li key={entry.id}>
                  <RuleCard entry={entry} under={under} onOpen={() => setOpenId(entry.id)} />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </section>

      {placed.quarantined.length + placed.muted.length > 0 ? (
        <section aria-labelledby="nxp-off">
          <h2 id="nxp-off">Switched off</h2>
          <OffList quarantined={placed.quarantined} muted={placed.muted} />
        </section>
      ) : null}

      <DetailSheet subject={subject} onClose={close} quotes={quotes} monitors={monitors}
                   privacy={privacy} entryStyle={entryStyle} />
    </div>
  );
}

function ExpiryHead({ expiry, dte }: { expiry: string; dte: number }) {
  return (
    <h3 className="nxp-expiry-head">
      <span>{expiryWords(expiry)}</span>
      <span className="nxp-meta">{`${dte} DTE`}</span>
    </h3>
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
  for (const g of placed.holdings) {
    for (const p of g.rows.flat()) if (p.holding.id === id) return { kind: "holding", ...p };
  }
  for (const g of placed.watchlist) {
    for (const item of g.items) if (item.entry.id === id) return { kind: "rule", ...item };
  }
  const lone = placed.unplaced.find((e) => e.id === id);
  return lone ? { kind: "rule", entry: lone, under: [] } : null;
}
