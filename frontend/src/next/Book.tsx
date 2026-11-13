import { BellRing, OctagonAlert, Sparkles } from "lucide-react";

import type { Entry, Holding, Monitor } from "../shared/api";
import type { EntryStyle } from "../shared/prefs";
import { DASH, heldLegs, legSummary } from "../shared/format";
import type { HoldingWrites } from "./HoldingActions";
import type { Mode } from "./mode";
import { Glyph } from "./NeedsLine";
import { paceWords } from "./pace";
import { placeBook } from "./placement";
import { entryName, isEntrySignal, sentence } from "./needs";

/** What every drawing of the book is handed: the polled figures and the viewer's settings. The
 *  desk's table (`desk/`, #289) and the phone's cards (`phone/`, #290) each take exactly this, and
 *  place the book with `placeBook` so the two cannot group it differently. */
export interface BookProps {
  quotes: Entry[];
  /** every rule, enabled or not: the muted and quarantined ones are only here */
  monitors: Monitor[];
  /** null while not valued, and after a valuation failed: the error is said INSTEAD of figures
   *  nobody can vouch for, as the old page did (#301) */
  holdings: Holding[] | null;
  holdingsError: string | null;
  /** when this screen last valued them, said in REVIEW, where they are not polled */
  holdingsAt: string | null;
  mode: Mode;
  privacy: boolean;
  entryStyle: EntryStyle;
  /** editing, closing and deleting a holding (#294); absent, its detail offers none of them */
  writes?: HoldingWrites;
  /** REVIEW's closed trades (#296), drawn by the phone's book under its holdings; the desk's is
   *  the page's own section under the table */
  journal?: React.ReactNode;
}

/** The book as a plain list: holdings first, each with the rules about it, then the watchlist,
 *  both by expiry (ADR 0023: the spread is the unit, grouped by expiry). Which rule sits where is
 *  `placeBook`'s; this only draws it, plainly, until the desk table (#289) and the phone cards
 *  (#290) replace it. */
export function Book({ quotes, monitors, holdings, holdingsError, holdingsAt, mode, privacy }: BookProps) {
  const placed = placeBook(quotes, holdings, monitors);
  const unplaced = placed.unplaced;

  return (
    <div className="nx-book">
      <section aria-labelledby="nx-holdings">
        <h2 id="nx-holdings">Holdings</h2>
        {holdingsError !== null
          ? <p className="nx-meta">{`the holdings could not be valued — ${holdingsError}`}</p>
          : null}
        {holdings === null && holdingsError === null ? <p className="nx-meta">valuing…</p> : null}
        {holdings !== null && holdings.length === 0 ? <p className="nx-meta">nothing held</p> : null}
        {mode === "review" && holdings !== null && holdingsAt
          ? <p className="nx-meta">{`valued at ${holdingsAt}`}</p> : null}
        {placed.holdings.map(({ expiry, rows }) => (
          <div key={expiry} className="nx-expiry">
            <h3>{expiry}</h3>
            <ul>
              {rows.flat().map(({ holding, rules }) => (
                <HoldingItem key={holding.id} holding={holding} mode={mode} privacy={privacy} rules={rules} />
              ))}
            </ul>
          </div>
        ))}
        {unplaced.length > 0 ? (
          <div className="nx-expiry" data-testid="unplaced">
            <h3>rules on held contracts</h3>
            <p className="nx-meta">
              {holdings === null
                ? "the holdings are not valued, so the rules about them are listed on their own"
                : "each watches a held contract that no single holding owns, as on a roll day"}
            </p>
            <ul>{unplaced.map((e) => <li key={e.id} className="nx-item"><Rule entry={e} /></li>)}</ul>
          </div>
        ) : null}
      </section>

      <section aria-labelledby="nx-watchlist">
        <h2 id="nx-watchlist">Watchlist</h2>
        {placed.watchlist.length === 0 ? <p className="nx-meta">nothing watched</p> : null}
        {placed.watchlist.map(({ expiry, items }) => (
          <div key={expiry} className="nx-expiry">
            <h3>{expiry}</h3>
            <ul>
              {items.map(({ entry: e, under }) => (
                <li key={e.id} className="nx-item">
                  <Rule entry={e} />
                  {under.length > 0 ? (
                    <ul className="nx-under">
                      {under.map((leg) => <li key={leg.id}><Rule entry={leg} /></li>)}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>
    </div>
  );
}

/** The state a rule is in, as one of the attention family's chips — or none while it is calm. */
function ruleState(e: Entry): "fault" | "entry" | "alarm" | null {
  if (e.error) return "fault";
  if (!e.triggered) return null;
  return isEntrySignal(e) ? "entry" : "alarm";
}

const CHIP = {
  fault: { Icon: OctagonAlert, words: "fault" },
  alarm: { Icon: BellRing, words: "ringing" },
  entry: { Icon: Sparkles, words: "entry signal" },
} as const;

/** A filled chip with a glyph (ADR 0023): attention is told apart from the "down" colour by its
 *  shape and lightness as well as its hue, so it reads the same whichever way up the viewer has
 *  set the colours, and to somebody who cannot tell the hues apart at all. */
export function Chip({ state }: { state: keyof typeof CHIP }) {
  const { Icon, words } = CHIP[state];
  return (
    <span className="nx-chip" data-attention={state}>
      <Icon aria-hidden="true" />{words}
    </span>
  );
}

function Rule({ entry }: { entry: Entry }) {
  const state = ruleState(entry);
  return (
    <div className="nx-rule" data-ref={entry.id} data-state={state ?? "calm"}>
      <span className="nx-name">{entryName(entry)}</span>
      {entry.legs ? <span className="nx-legs">{legSummary(entry.legs)}</span> : null}
      <span className="nx-sentence">{sentence(entry)}</span>
      {state ? <Chip state={state} /> : null}
      {entry.error ? <span className="nx-meta">{entry.error}</span> : null}
    </div>
  );
}

const MONEY = new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", maximumFractionDigits: 0, signDisplay: "exceptZero",
});

/** Money, or nothing a stranger can read. Privacy keeps %, Δ and DTE (ADR 0023): a share
 *  captured says how the trade is going without saying how big it is. */
export function Money({ value, privacy }: { value: number | null; privacy: boolean }) {
  if (value === null) return <span data-money="">{DASH}</span>;
  return (
    <span data-money="" data-outcome={value > 0 ? "gain" : value < 0 ? "loss" : "flat"}>
      {privacy ? "$•••" : MONEY.format(value)}
    </span>
  );
}

const percent = (share: number | null) => share === null ? DASH : `${Math.round(share * 100)}%`;
const points = (n: number | null) => n === null ? DASH : n.toFixed(2);

function HoldingItem({ holding, rules, mode, privacy }: {
  holding: Holding; rules: Entry[]; mode: Mode; privacy: boolean;
}) {
  const s = holding.schedule;
  const level = s?.reached ?? null;
  return (
    <li className="nx-item">
      <div className="nx-holding" data-ref={holding.id}>
        <span className="nx-name">{holding.name}</span>
        <span className="nx-legs">{holdingLegs(holding)}</span>
        {mode === "live" ? (
          <span className="nx-figures">
            {`cost to close ${points(holding.cost_to_close)} · P&L `}
            <Money value={holding.pnl} privacy={privacy} />
            {` · captured ${percent(holding.captured)} · ${holding.dte} DTE`}
          </span>
        ) : (
          <span className="nx-figures">
            {"P&L "}
            <Money value={holding.pnl} privacy={privacy} />
            {` · captured ${percent(holding.captured)}`}
            {s ? ` · pace gap: ${paceWords(s.pace_gap)} · ${holding.dte} DTE, manage-by at ${s.manage_by_dte}`
              : ` · ${holding.dte} DTE · no schedule (Opened not recorded)`}
          </span>
        )}
        {/* a Level reached is attention, so it is drawn as attention is: a filled chip with a
            glyph — text in the alarm colour on the dark ground fell below 4.5:1 */}
        {level ? (
          <span className="nx-chip" data-kind={level === "stop" ? "stop" : "target"}>
            <Glyph kind={level === "stop" ? "stop" : "target"} />{`at ${level}`}
          </span>
        ) : null}
      </div>
      {rules.length > 0 ? (
        <ul className="nx-under">
          {rules.map((e) => <li key={e.id}><Rule entry={e} /></li>)}
        </ul>
      ) : null}
    </li>
  );
}

/** `-P7150 +P7100`: a holding's legs as the watchlist writes a combo's, short as minus. */
function holdingLegs(holding: Holding): string {
  return heldLegs(holding.legs);
}
