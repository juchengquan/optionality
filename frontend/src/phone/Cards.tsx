/** The phone's cards (ADR 0023, arrangement B): one per held spread, one per watched spread, and
 *  the rules that are switched off. Each card is ONE target — a tap anywhere opens its detail
 *  sheet — and carries `data-ref`, as each rule inside it does, so a needs-you banner can lead to
 *  it (NeedsLine.tsx: `reveal`). */
import { Fragment } from "react";
import { OctagonAlert } from "lucide-react";

import type { Entry, Holding, Monitor } from "../shared/api";
import { heldLeg, signedLeg } from "../shared/format";
import { Leg, Legs } from "../shared/Legs";
import { Chip, Money } from "../Book";
import { levelWords } from "../levels";
import { costAndPace, paceOutcome } from "../pace";
import { Glyph } from "../NeedsLine";
import { entryName, fieldWords, monitorName } from "../needs";
import { reasonWhy } from "../shared/groups";
import { RuleWords } from "../RuleWords";
import { alsoWords, drawnUnder, ownRule, type Elsewhere, type PlacedHolding } from "../placement";
import { mutedWords, shortDeltas, shortDeltaWords } from "./figures";
import { percent } from "../shared/numbers";
import { SHORT_DELTA } from "../shared/words";
import { ruleState } from "./state";
import { HoldingStrip, StrikeStrip } from "../StrikeStrip";
import { MonitorControls } from "../MonitorEdit";
import { ruleOfMonitor } from "../edit";
import { stripOfEntry } from "../strip";
import { HELD, moreSerious, ruleCells, rowState } from "../desk/columns";

/** Whether a card's value is a held spread's cost to close, as its desk row reads it (`heldSpread`). */
const heldSpreadValue = (e: Entry, overlap: string | null) => Boolean(e.legs) && e.held && !overlap;

/** The button that makes a whole card one target. It is drawn over the card, so the card's text
 *  stays text to a screen reader and the button says what a tap does. */
function OpenCard({ name, onOpen }: { name: string; onOpen: () => void }) {
  return <button type="button" className="nxp-open" aria-label={`details of ${name}`} onClick={onOpen} />;
}

/** A Level reached is attention, drawn as attention is: a filled chip with a glyph — outside the
 *  session saying which valuation it is from (`levelWords`, #354, #371). */
export function LevelChip({ holding, session }: { holding: Holding; session: boolean }) {
  const level = holding.schedule?.reached ?? null;
  if (!level) return null;
  const kind = level === "stop" ? "stop" : "target";
  return (
    <span className="nx-chip" data-kind={kind}><Glyph kind={kind} />{levelWords(kind, holding, session)}</span>
  );
}

/** One rule as a line: what it watches in its own sentence, and its state's chip when it has one. */
export function RuleLine({ entry, marked = true, own = false, within, children }: {
  entry: Entry;
  /** the name of the card or sheet the line sits in: a rule's name is not drawn where it is that
   *  name — "1231_8050" under 1231_8050's own heading (2026-11-17) — and stays where it is a leg's */
  within?: string;
  /** the rule a sheet is OF: its chip and its fault are the sheet's level section's, said once
   *  (review of #420) */
  own?: boolean;
  /** drawn under the rule: the sheet's controls for it (#292) */
  children?: React.ReactNode;
  /** whether a banner may lead here: on the page yes, in the sheet no, or a banner tapped while
   *  the sheet is open would find the copy in the sheet rather than the card */
  marked?: boolean;
}) {
  const state = ruleState(entry);
  return (
    <li className="nxp-rule" data-ref={marked ? entry.id : undefined} data-state={state ?? "calm"}>
      {entryName(entry) === within ? null : <span className="nxp-rule-name">{entryName(entry)}</span>}
      <span className="nxp-sentence"><RuleWords entry={entry} /></span>
      {state && !own ? <Chip state={state} /> : null}
      {entry.error && !own ? <span className="nxp-error">{entry.error}</span> : null}
      {children}
    </li>
  );
}

export function HoldingCard({ placed, quotes, monitors, privacy, session, onOpen, spxSaid = false }: {
  placed: PlacedHolding; quotes: Entry[]; monitors: Monitor[]; privacy: boolean; session: boolean;
  onOpen: () => void;
  /** the book says why SPX is not current, once (`SpxNote`): the strip marks it rather than says it */
  spxSaid?: boolean;
}) {
  const { holding, rules } = placed;
  // its own rule first, then the rest drawn here: one drawn under an earlier holding is a note
  const own = ownRule(holding, rules);
  const lines = [...(own ? [own] : []), ...drawnUnder(rules, placed.elsewhere, own)];
  // the most serious of its Level, its own rule and every other rule drawn on the card (the owner,
  // 2026-11-17): the card is all of them at once, where the desk gives each other rule its own row
  const state = lines.reduce((worst, r) => moreSerious(worst, ruleState(r) ?? "calm"),
    rowState({ kind: "holding", holding, rules }));
  return (
    <article className="nxp-card nxp-holding" data-ref={holding.id} data-state={state}>
      {/* "held" in its name, to a reader as on screen: the one book draws watches beside it (2026-11-17) */}
      <OpenCard name={`${holding.name} ${HELD}`} onOpen={onOpen} />
      <header className="nxp-head">
        <span className="nxp-name">{holding.name}{" "}<span className="nx-held" data-held="">{HELD}</span></span>
        <span className="nxp-legs"><Legs legs={holding.legs.map(heldLeg)} /></span>
        {/* no DTE here: its expiry's heading says it, once (part K) */}
      </header>
      <div className="nxp-hero">
        <Money value={holding.pnl} privacy={privacy} />
        <span className="nxp-hero-sub">{`captured ${percent(holding.captured)}`}</span>
        {/* its chip by the session (#371) */}
        <LevelChip holding={holding} session={session} />
      </div>
      <dl className="nxp-facts">
        {/* the Cost to close with its pace gap beside it, one field as the desk's value column draws
            it (the owner, 2026-11-16) — the gap on the card since #374, said in words to a reader */}
        <div><dt>cost to close</dt><dd><CostAndPace holding={holding} /></dd></div>
        <div><dt>{SHORT_DELTA}</dt><dd><ShortDeltaWords holding={holding} quotes={quotes} monitors={monitors} /></dd></div>
      </dl>
      <HoldingStrip holding={holding} reasonSaid={spxSaid} />
      {lines.length > 0 ? <ul className="nxp-rules">{lines.map((r) => <RuleLine key={r.id} entry={r} within={holding.name} />)}</ul> : null}
      <AlsoNotes elsewhere={placed.elsewhere} />
    </article>
  );
}

/** "3.05 −1.57": the Cost to close, and its pace gap signed and in its outcome's colour, said in
 *  words to a pointer and a reader ("3.05, pace gap behind by 1.57"). */
function CostAndPace({ holding }: { holding: Holding }) {
  const v = costAndPace(holding);
  if (v.gap === null) return <>{v.text}</>;
  return (
    <>
      <span className="sr-only">{v.words}</span>
      <span title={v.words} aria-hidden="true">
        {v.cost}{" "}<span data-outcome={paceOutcome(holding.schedule?.pace_gap)}>{v.gap}</span>
      </span>
    </>
  );
}

/** A watched spread — or a single contract, or a rule on something held that no drawn holding
 *  owns — with its value and Δ as its desk row writes them (part K; out of the session a watchlist
 *  row's value is its last in-session price and when, #400), its rule's sentence with its arrowed
 *  distance and the rules that sit under it, and, for a spread that only partly overlaps a holding, what it
 *  shares and with whom (#346). */
export function RuleCard({ entry, under, overlap = null, elsewhere, onOpen, spxSaid = false }: {
  entry: Entry; under: Entry[]; overlap?: string | null; onOpen: () => void;
  /** leg rules drawn under an earlier spread: a note each, no line (2026-11-17) */
  elsewhere?: Elsewhere[];
  /** as `HoldingCard`'s */
  spxSaid?: boolean;
}) {
  const state = ruleState(entry);
  const cells = ruleCells(entry, overlap);
  return (
    <article className="nxp-card nxp-watch" data-ref={entry.id} data-state={state ?? "calm"}>
      <OpenCard name={entryName(entry)} onOpen={onOpen} />
      <header className="nxp-head">
        <span className="nxp-name">{entryName(entry)}</span>
        {entry.legs ? <span className="nxp-legs"><Legs legs={entry.legs.map(signedLeg)} /></span> : null}
        {state ? <Chip state={state} /> : null}
      </header>
      {overlap ? <p className="nxp-meta nxp-overlap" data-overlap="">{overlap}</p> : null}
      <dl className="nxp-facts nxp-watch-figs">
        <div data-value=""><dt>{heldSpreadValue(entry, overlap) ? "cost to close" : "value"}</dt><dd>{cells.value}</dd></div>
        <div data-delta=""><dt>Δ</dt><dd>{cells.delta}</dd></div>
      </dl>
      <p className="nxp-sentence"><RuleWords entry={entry} /></p>
      {entry.error ? <p className="nxp-error">{entry.error}</p> : null}
      {entry.legs ? <StrikeStrip strip={stripOfEntry(entry)!} reasonSaid={spxSaid} /> : null}
      {drawnUnder(under, elsewhere).length > 0
        ? <ul className="nxp-rules">{drawnUnder(under, elsewhere).map((r) => <RuleLine key={r.id} entry={r} within={entryName(entry)} />)}</ul> : null}
      <AlsoNotes elsewhere={elsewhere} />
    </article>
  );
}

/** A rule met again on a second card (the owner, 2026-11-17): a quiet note naming where its line
 *  is, never a second line — no `data-ref`, so a banner leads to the one place it is drawn. */
function AlsoNotes({ elsewhere }: { elsewhere: Elsewhere[] | undefined }) {
  if (!elsewhere?.length) return null;
  return <>{elsewhere.map((e) => <p key={e.entry.id} className="nxp-meta nxp-also" data-also="">{alsoWords(e)}</p>)}</>;
}

/** The rules that are off: a quarantine is a fault the service declared, so it carries the fault
 *  chip; a muted rule is somebody's choice or the calendar, so it is drawn quietly. */
export function OffList({ quarantined, muted }: { quarantined: Monitor[]; muted: Monitor[] }) {
  return (
    <ul className="nxp-off">
      {quarantined.map((m) => (
        <li key={m.id} className="nxp-card" data-monitor={m.id} data-state="quarantined">
          <span className="nxp-name">{monitorName(m)}</span>
          <span className="nxp-sentence">{fieldWords(m.field)}</span>
          <span className="nx-chip" data-attention="fault"><OctagonAlert aria-hidden="true" />quarantined</span>
          <span className="nxp-meta">{reasonWhy(m.disabled_reason)}</span>
          <MonitorControls rule={ruleOfMonitor(m)} served={null} />
        </li>
      ))}
      {muted.map((m) => (
        <li key={m.id} className="nxp-card" data-monitor={m.id} data-state="muted">
          <span className="nxp-name">{monitorName(m)}</span>
          <span className="nxp-sentence">{fieldWords(m.field)}</span>
          <span className="nxp-meta">{mutedWords(m.disabled_reason)}</span>
          <MonitorControls rule={ruleOfMonitor(m)} served={null} expiredSaid={m.disabled_reason === "expired"} />
        </li>
      ))}
    </ul>
  );
}

/** Each short leg's delta, the leg named in its type's colour and bold as a short leg is (#391),
 *  where a holding has more than one; the one figure alone where it has one. */
export function ShortDeltaWords({ holding, quotes, monitors }: { holding: Holding; quotes: Entry[]; monitors: Monitor[] }) {
  const said = shortDeltaWords(shortDeltas(holding, quotes, monitors));
  if (typeof said === "string") return <>{said}</>;
  return (
    <>
      {said.map((d, i) => (
        <Fragment key={`${d.leg.option_type}${d.leg.strike}`}>
          {i > 0 ? " · " : null}<Leg leg={{ ...d.leg, short: true }} form="name" />{d.words}
        </Fragment>
      ))}
    </>
  );
}
