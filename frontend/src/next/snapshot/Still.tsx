/** The page as it goes into the saved image (#300): a SECOND React tree, mounted off screen only
 *  while the picture is taken, at a width of its own — as the old page's SnapshotView was.
 *
 *  Not a copy of the screen, and that is the design. The desk's table fits its columns to the room
 *  it has (ADR 0008), so with the inspector open, or in a narrow window, the screen is a subset;
 *  drawn again here it carries every column the viewer ticked. The phone's cards are drawn at the
 *  picture's width rather than the device's, so one book gives one picture from any phone.
 *
 *  Drawn from the figures the page already holds — no chart that reads samples, no payoff, no
 *  price map — and with NOTHING that can be pressed: no buttons, no pickers, no inspector, no
 *  sheet. Privacy goes in with the figures: every cell is the same text the screen draws, with
 *  the same setting, so what the screen hides the picture hides.
 *
 *  Which drawing goes in follows the arrangement the press came from: A's table from the desk,
 *  B's cards from the phone.
 */
import { OctagonAlert } from "lucide-react";

import "./still.css";
import type { Entry, Health, Holding, Monitor, Reference } from "../../shared/api";
import { DASH, shortDate } from "../../shared/format";
import { Freshness } from "../../shared/Freshness";
import { readHidden } from "../../shared/prefs";
import { ReferenceStrip } from "../../shared/ReferenceStrip";
import type { Arrangement } from "../arrangement";
import { Money, type BookProps } from "../Book";
import { AttentionChip, Cell, Fill, OverlapNote, tableRows } from "../desk/DeskBook";
import {
  attentionOf, charsOf, chipWords, COLUMNS, PINNED, rowId, rowName, type DeskColumn, type DeskRow,
} from "../desk/columns";
import { ClosedLine } from "../ClosedLine";
import { NeedsLine } from "../NeedsLine";
import { paceOutcome, paceWords } from "../pace";
import { fieldWords, monitorName, QUARANTINED, type Need } from "../needs";
import { HoldingCard, LevelChip, RuleCard, RuleLine } from "../phone/Cards";
import {
  contractsWords, expiryWords, holdingLegs, percent, points, shortDeltas, shortDeltaWords,
} from "../phone/figures";
import { Condor, ExpiryHead } from "../phone/PhoneBook";
import { placeBook, type BookModel, type PlacedHolding } from "../placement";
import { STILL } from "./useSaveImage";

export interface StillProps extends BookProps {
  arrangement: Arrangement;
  /** the needs-you line as the page draws it now */
  needs: Need[];
  health: Health | null;
  polledAt: string | null;
  /** why the figures may be stale, when they may */
  error: string | null;
  /** the market beside the strikes, as the page draws it: outside the session with the time each
   *  reading was read, and never without it (#371) */
  references: Reference[];
}

export function Still(props: StillProps) {
  const { arrangement, needs, health, polledAt, error, mode, session, entryStyle, references } = props;
  return (
    <div className={STILL} data-arrangement={arrangement}>
      <header className="nx-still-head">
        <h1>optionality</h1>
        <span className="nx-meta">{mode === "live" ? "live" : "review"}</span>
      </header>
      {error ? <div className="nx-banner">{error}</div> : null}
      {/* the one thing that dates the picture; a screenshot with no time is worthless a week on */}
      <Freshness fetchedAt={health?.monitor.fetched_at ?? null} polledAt={polledAt}
                 sweepSeconds={health?.settings.sweep_seconds ?? null} />
      {/* the desk's one-line form in both: the phone's banners are buttons */}
      <NeedsLine items={needs} arrangement="desk" entryStyle={entryStyle} />
      {/* as the page draws it, whichever mode: the one place the picture states the market's level.
          Outside the session each reading carries the time it was read, as on screen (#371): a
          picture is looked at long after, and a figure with no time would be taken for current.
          the old page's picture had none. */}
      <ReferenceStrip references={references} stamped={!session} />
      {arrangement === "desk" ? <StillDesk {...props} /> : <StillCards {...props} />}
    </div>
  );
}

// ---- A: the table, every ticked column

/** Characters of room added to each column beyond what `charsOf` counts: a picture cannot be
 *  widened to read what an ellipsis took, so it errs wide. */
const SLACK_CH = 1;

function StillDesk({ quotes, monitors, holdings, holdingsError, holdingsAt, mode, session, privacy }: BookProps) {
  const placed = placeBook(quotes, holdings, monitors);
  const rows = tableRows(placed);
  // the viewer's column choice, as the table on screen reads it; the room on screen, not at all
  const hidden = readHidden();
  const columns = COLUMNS[mode].filter((c) => c.key === PINNED || !hidden.has(c.key));
  const flexible = columns.some((c) => c.key === "alarm") ? "alarm" : "name";
  // in `ch` of the table's own monospace, which is what the screen's fitting measures in pixels
  const template = columns.map((c) => {
    const w = `${Math.ceil(charsOf(c, rows, privacy, session)) + SLACK_CH}ch`;
    return c.key === flexible ? `minmax(${w}, 1fr)` : w;
  }).join(" ");

  return (
    <div className="nx-book nxd">
      <div className="nxd-table" style={{ "--nxd-cols": template } as React.CSSProperties}>
        <div className="nxd-head nxd-grid">
          {columns.map((c) => <span key={c.key} data-col={c.key} data-align={c.align}>{c.label}</span>)}
        </div>
        <section>
          <div className="nxd-section"><h2>Holdings</h2></div>
          <HoldingsStatus holdings={holdings} error={holdingsError} at={holdingsAt} session={session}
                          className="nx-meta nxd-note" />
          {placed.holdings.map(({ expiry, rows: brackets }) => (
            <div key={expiry} className="nxd-expiry">
              <h3 className="nxd-group">{`${shortDate(expiry)} · ${brackets[0]![0]!.holding.dte} DTE`}</h3>
              {brackets.map((bracket) => bracket.map(({ holding, rules }, i) => {
                const paired = bracket.length === 2;
                return (
                  <div key={holding.id} data-bracket={paired ? "condor" : undefined}>
                    <StillRow row={{ kind: "holding", holding, rules }} columns={columns} privacy={privacy}
                              bracket={paired ? (i === 0 ? "top" : "bottom") : undefined} session={session} />
                    {rules.map((e) => (
                      <StillRow key={e.id} row={{ kind: "rule", entry: e, nested: true }} columns={columns}
                                privacy={privacy} bracket={paired && i === 0 ? "through" : undefined}
                                session={session} />
                    ))}
                  </div>
                );
              }))}
            </div>
          ))}
          {placed.unplaced.length > 0 ? (
            <div className="nxd-expiry">
              <h3 className="nxd-group">rules on held contracts</h3>
              {placed.unplaced.map((e) => (
                <StillRow key={e.id} row={{ kind: "rule", entry: e, nested: false }} columns={columns}
                          privacy={privacy} session={session} />
              ))}
            </div>
          ) : null}
        </section>
        <section>
          <div className="nxd-section"><h2>Watchlist</h2></div>
          {placed.watchlist.length === 0 && placed.quarantined.length === 0
            ? <p className="nx-meta nxd-note">nothing watched</p> : null}
          {placed.watchlist.map(({ expiry, items }) => (
            <div key={expiry} className="nxd-expiry">
              <h3 className="nxd-group">{`${shortDate(expiry)} · ${items[0]!.entry.dte} DTE`}</h3>
              {items.map(({ entry, under, overlap }) => (
                <div key={entry.id}>
                  <StillRow row={{ kind: "rule", entry, nested: false, overlap }} columns={columns}
                            privacy={privacy} session={session} />
                  <OverlapNote overlap={overlap} />
                  {under.map((e) => (
                    <StillRow key={e.id} row={{ kind: "rule", entry: e, nested: true }} columns={columns}
                              privacy={privacy} session={session} />
                  ))}
                </div>
              ))}
            </div>
          ))}
          {placed.quarantined.length > 0 ? (
            <div className="nxd-quarantined">
              <h3 className="nxd-group">quarantined — switched off by the service</h3>
              {placed.quarantined.map((m) => (
                <StillRow key={m.id} row={{ kind: "quarantined", monitor: m }} columns={columns}
                          privacy={privacy} session={session} />
              ))}
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}

/** DeskBook's row with the pressing taken out: the name is words, not a button. */
function StillRow({ row, columns, privacy, bracket, session }: {
  row: DeskRow; columns: DeskColumn[]; privacy: boolean; bracket?: "top" | "through" | "bottom";
  /** a holding's Level says, outside the session, which valuation it is from (#354, #371) */
  session: boolean;
}) {
  const a = attentionOf(row);
  const barIn = columns.some((c) => c.key === "alarm") ? "alarm" : "name";
  return (
    <div className="nxd-row nxd-grid" data-ref={rowId(row)} data-kind={row.kind} data-state={a ?? "calm"}
         data-nested={row.kind === "rule" && row.nested ? "" : undefined}>
      {bracket ? <span className="nxd-bracket" data-part={bracket} aria-hidden="true" /> : null}
      {columns.map((c) => (
        <span key={c.key} data-col={c.key} data-align={c.align}>
          {c.key === "name" ? (
            <>
              <span className="nxd-name">{rowName(row)}</span>
              {a ? <AttentionChip kind={a} words={chipWords(row, session)} /> : null}
            </>
          ) : <Cell row={row} column={c} privacy={privacy} />}
          {barIn === c.key && row.kind === "rule" ? <Fill entry={row.entry} /> : null}
        </span>
      ))}
    </div>
  );
}

// ---- B: the cards

function StillCards({ quotes, monitors, holdings, holdingsError, holdingsAt, mode, session, privacy }: BookProps) {
  const placed: BookModel = placeBook(quotes, holdings, monitors);
  return (
    <div className="nx-book nxp-book">
      <section>
        <h2>{mode === "live" ? "Holdings" : "Review"}</h2>
        <HoldingsStatus holdings={holdings} error={holdingsError} at={holdingsAt} session={session}
                        className="nxp-meta" />
        {placed.holdings.map(({ expiry, rows }) => (
          <section key={expiry} className="nxp-expiry">
            <ExpiryHead expiry={expiry} dte={rows[0]![0]!.holding.dte} />
            <ul className="nxp-cards">
              {mode === "review" ? rows.flat().map((p) => (
                <li key={p.holding.id}>
                  <ReviewCard placed={p} quotes={quotes} monitors={monitors} privacy={privacy} session={session} />
                </li>
              )) : rows.map((row) => (
                <li key={row.map((p) => p.holding.id).join("+")}>
                  {row.length === 2 ? (
                    <Condor row={row} privacy={privacy}>
                      {row.map((p) => (
                        <HoldingCard key={p.holding.id} placed={p} quotes={quotes} monitors={monitors} privacy={privacy}
                                     session={session} />
                      ))}
                    </Condor>
                  ) : row.map((p) => (
                    <HoldingCard key={p.holding.id} placed={p} quotes={quotes} monitors={monitors} privacy={privacy}
                                 session={session} />
                  ))}
                </li>
              ))}
            </ul>
          </section>
        ))}
        {placed.unplaced.length > 0 ? (
          <section className="nxp-expiry">
            <h3>rules on held contracts</h3>
            <ul className="nxp-cards">
              {placed.unplaced.map((e) => <li key={e.id}><RuleCard entry={e} under={[]} /></li>)}
            </ul>
          </section>
        ) : null}
      </section>

      <section>
        <h2>Watchlist</h2>
        {placed.watchlist.length === 0 ? <p className="nxp-meta">nothing watched</p> : null}
        {placed.watchlist.map(({ expiry, items }) => (
          <section key={expiry} className="nxp-expiry">
            <ExpiryHead expiry={expiry} dte={items[0]!.entry.dte} />
            <ul className="nxp-cards">
              {items.map(({ entry, under, overlap }) => (
                <li key={entry.id}><RuleCard entry={entry} under={under} overlap={overlap} /></li>
              ))}
            </ul>
          </section>
        ))}
      </section>

      {placed.quarantined.length > 0 ? (
        <section>
          <h2>Quarantined</h2>
          <Quarantined monitors={placed.quarantined} />
        </section>
      ) : null}
    </div>
  );
}

/** REVIEW's page for one holding (phone/Review.tsx) with what a picture cannot carry left out: the
 *  charts, which read the samples, and the button to the detail. */
function ReviewCard({ placed: { holding, rules }, quotes, monitors, privacy, session }: {
  placed: PlacedHolding; quotes: Entry[]; monitors: Monitor[]; privacy: boolean; session: boolean;
}) {
  const s = holding.schedule;
  return (
    <article className="nxp-card" data-ref={holding.id}>
      <header className="nxp-head">
        <span className="nxp-name">{holding.name}</span>
        <span className="nxp-legs">{holdingLegs(holding)}</span>
        <span className="nxp-pill">{`${holding.dte} DTE`}</span>
      </header>
      <p className="nxp-meta">
        {`${contractsWords(holding.contracts, privacy)} · ${expiryWords(holding.strike_date)} · opened ${holding.opened_at ?? DASH}`}
      </p>
      <div className="nxp-hero">
        <Money value={holding.pnl} privacy={privacy} />
        <span className="nxp-hero-sub">unrealised</span>
        <LevelChip holding={holding} session={session} />
      </div>
      <dl className="nxp-facts">
        <div><dt>captured</dt><dd>{percent(holding.captured)}</dd></div>
        <div><dt>cost to close</dt><dd>{points(holding.cost_to_close)}</dd></div>
        <div><dt>entry</dt><dd>{points(holding.entry)}</dd></div>
        <div><dt>pace gap</dt><dd data-outcome={paceOutcome(s?.pace_gap)}>{paceWords(s?.pace_gap)}</dd></div>
        <div><dt>manage-by</dt><dd>{s ? `at ${s.manage_by_dte} DTE` : DASH}</dd></div>
        <div><dt>short Δ</dt><dd>{shortDeltaWords(shortDeltas(holding, quotes, monitors))}</dd></div>
      </dl>
      {s ? null : <p className="nxp-meta">no schedule — Opened not recorded</p>}
      {rules.length > 0 ? <ul className="nxp-rules">{rules.map((r) => <RuleLine key={r.id} entry={r} />)}</ul> : null}
    </article>
  );
}

/** The rules the service switched off: a fault, so in the picture; the muted ones are not news
 *  and are left out, as the desk folds them away. */
function Quarantined({ monitors }: { monitors: Monitor[] }) {
  return (
    <ul className="nxp-off">
      {monitors.map((m) => (
        <li key={m.id} className="nxp-card" data-monitor={m.id} data-state="quarantined">
          <span className="nxp-name">{monitorName(m)}</span>
          <span className="nxp-sentence">{fieldWords(m.field, Boolean(m.legs))}</span>
          <span className="nx-chip" data-attention="fault"><OctagonAlert aria-hidden="true" />quarantined</span>
          <span className="nxp-meta">{QUARANTINED[m.disabled_reason ?? ""] ?? m.disabled_reason}</span>
        </li>
      ))}
    </ul>
  );
}

/** Where the holdings stand, said as the page says it: outside the session the market-closed line
 *  with the service's time (#371), and no button, since nothing in a picture can be pressed; then
 *  why there are no figures, when there are none. */
function HoldingsStatus({ holdings, error, at, session, className }: {
  holdings: Holding[] | null; error: string | null; at: string | null; session: boolean; className: string;
}) {
  return (
    <>
      {!session ? <ClosedLine at={holdings !== null ? at : null} className={className} /> : null}
      {error !== null ? <p className={className}>{`the holdings could not be valued — ${error}`}</p>
        : holdings === null ? <p className={className}>valuing…</p>
          : holdings.length === 0 ? <p className={className}>nothing held</p> : null}
    </>
  );
}
