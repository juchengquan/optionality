import { BellRing, OctagonAlert, Sparkles } from "lucide-react";

import type { Entry, Holding } from "../api";
import { DASH, legSummary } from "../format";
import type { Mode } from "./mode";
import { entryName, isEntrySignal, sentence } from "./needs";

/** The book as a plain list: holdings first, each with the rules about it, then the watchlist,
 *  both by expiry (ADR 0023: the spread is the unit, grouped by expiry).
 *
 *  Deliberately plain. This is the first path through every layer — the service's new figures, the
 *  page that reads them, both arrangements around it — and the desk table (#289) and the phone
 *  cards (#290) replace this list. What it settles now is WHICH rule sits where:
 *  - a rule about a holding sits under that holding, because it is a risk on something owned;
 *  - a rule on nothing held is the watchlist, an entry signal on a candidate spread;
 *  - a single-leg rule whose contract is a leg of a watched spread (`in_combos`, a link the
 *    service discovers) sits under that spread, which is how a short leg's delta joins its spread.
 */
export function Book({ quotes, holdings, holdingsError, holdingsAt, mode, privacy }: {
  quotes: Entry[];
  /** null while not valued, and after a valuation failed: the error is said INSTEAD of figures
   *  nobody can vouch for, as at `/opt` */
  holdings: Holding[] | null;
  holdingsError: string | null;
  /** when this screen last valued them, said in REVIEW, where they are not polled */
  holdingsAt: string | null;
  mode: Mode;
  privacy: boolean;
}) {
  const watchlist = quotes.filter(isEntrySignal);
  // a rule on something held whose holding is not drawn — the valuation failed or has not arrived,
  // or two holdings share its contract — is still a risk rule, and still shown
  const drawn = new Set((holdings ?? []).map((h) => h.id));
  const unplaced = quotes.filter((e) => !isEntrySignal(e) && !e.positions.some((p) => drawn.has(p.id)));
  const ids = new Set(watchlist.map((e) => e.id));
  // a leg rule that has a spread on the watchlist to sit under; one whose spreads are all held or
  // gone stands alone rather than disappearing
  const nested = (e: Entry) => !e.legs && e.in_combos.some((id) => ids.has(id));
  const top = watchlist.filter((e) => !nested(e));
  const under = (combo: Entry) => watchlist.filter((e) => !e.legs && e.in_combos.includes(combo.id));

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
        {byExpiry(holdings ?? []).map(([expiry, group]) => (
          <div key={expiry} className="nx-expiry">
            <h3>{expiry}</h3>
            <ul>
              {group.map((h) => (
                <HoldingItem key={h.id} holding={h} mode={mode} privacy={privacy}
                             rules={quotes.filter((e) => e.positions.some((p) => p.id === h.id))} />
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
        {watchlist.length === 0 ? <p className="nx-meta">nothing watched</p> : null}
        {byExpiry(top).map(([expiry, group]) => (
          <div key={expiry} className="nx-expiry">
            <h3>{expiry}</h3>
            <ul>
              {group.map((e) => (
                <li key={e.id} className="nx-item">
                  <Rule entry={e} />
                  {e.legs && under(e).length > 0 ? (
                    <ul className="nx-under">
                      {under(e).map((leg) => <li key={leg.id}><Rule entry={leg} /></li>)}
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

function byExpiry<T extends { strike_date: string }>(rows: T[]): [string, T[]][] {
  const groups = new Map<string, T[]>();
  for (const r of [...rows].sort((a, b) => a.strike_date.localeCompare(b.strike_date))) {
    groups.set(r.strike_date, [...(groups.get(r.strike_date) ?? []), r]);
  }
  return [...groups];
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
            {s ? ` · pace gap ${points(s.pace_gap)} · ${holding.dte} DTE, manage-by at ${s.manage_by_dte}`
              : ` · ${holding.dte} DTE · no schedule (Opened not recorded)`}
          </span>
        )}
        {level ? <span className="nx-level" data-level={level}>{`at ${level}`}</span> : null}
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
  return holding.legs
    .map((l) => `${l.side === "short" ? "-" : "+"}${l.option_type[0]}${l.strike}`)
    .join(" ");
}
