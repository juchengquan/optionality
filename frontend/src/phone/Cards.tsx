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
import { entryName, fieldWords, monitorName, QUARANTINED } from "../needs";
import { RuleWords } from "../RuleWords";
import type { PlacedHolding } from "../placement";
import { mutedWords, shortDeltas, shortDeltaWords } from "./figures";
import { percent } from "../shared/numbers";
import { SHORT_DELTA } from "../shared/words";
import { ruleState } from "./state";
import { HoldingStrip, StrikeStrip } from "../StrikeStrip";
import { MonitorControls } from "../MonitorEdit";
import { ruleOfMonitor } from "../edit";
import { stripOfEntry } from "../strip";

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
export function RuleLine({ entry, marked = true, children }: {
  entry: Entry;
  /** drawn under the rule: the sheet's controls for it (#292) */
  children?: React.ReactNode;
  /** whether a banner may lead here: on the page yes, in the sheet no, or a banner tapped while
   *  the sheet is open would find the copy in the sheet rather than the card */
  marked?: boolean;
}) {
  const state = ruleState(entry);
  return (
    <li className="nxp-rule" data-ref={marked ? entry.id : undefined} data-state={state ?? "calm"}>
      <span className="nxp-rule-name">{entryName(entry)}</span>
      <span className="nxp-sentence"><RuleWords entry={entry} /></span>
      {state ? <Chip state={state} /> : null}
      {entry.error ? <span className="nxp-error">{entry.error}</span> : null}
      {children}
    </li>
  );
}

export function HoldingCard({ placed, quotes, monitors, privacy, session, onOpen }: {
  placed: PlacedHolding; quotes: Entry[]; monitors: Monitor[]; privacy: boolean; session: boolean;
  onOpen: () => void;
}) {
  const { holding, rules } = placed;
  const hot = holding.schedule?.reached === "stop" || rules.some((r) => ruleState(r) === "alarm");
  return (
    <article className="nxp-card nxp-holding" data-ref={holding.id} data-state={hot ? "alarm" : "calm"}>
      <OpenCard name={holding.name} onOpen={onOpen} />
      <header className="nxp-head">
        <span className="nxp-name">{holding.name}</span>
        <span className="nxp-legs"><Legs legs={holding.legs.map(heldLeg)} /></span>
        <span className="nxp-pill">{`${holding.dte} DTE`}</span>
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
      <HoldingStrip holding={holding} />
      {rules.length > 0 ? <ul className="nxp-rules">{rules.map((r) => <RuleLine key={r.id} entry={r} />)}</ul> : null}
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

/** How far a rule's figure has come toward its threshold, coloured by the rule's state. With NO
 *  figure there is no bar at all: an empty bar would read as "far from it", and the sentence
 *  beside it already says "no figure". */
export function Progress({ entry }: { entry: Entry }) {
  if (entry.fill === null || entry.fill === undefined) return null;
  const fill = Math.max(0, Math.min(100, entry.fill));
  return (
    <div className="nxp-progress" role="progressbar" aria-label="toward its threshold"
         aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fill)}
         data-state={ruleState(entry) ?? "calm"}>
      <span style={{ width: `${fill}%` }} />
    </div>
  );
}

/** A watched spread — or a single contract, or a rule on something held that no drawn holding
 *  owns — with its progress toward the threshold and the rules that sit under it, and, for a
 *  spread that only partly overlaps a holding, what it shares and with whom (#346). A watchlist
 *  card out of the session says its last in-session price and when (#400), `value`; in the session
 *  it says none, as before. */
export function RuleCard({ entry, under, overlap = null, value, onOpen }: {
  entry: Entry; under: Entry[]; overlap?: string | null; value?: string; onOpen: () => void;
}) {
  const state = ruleState(entry);
  return (
    <article className="nxp-card nxp-watch" data-ref={entry.id} data-state={state ?? "calm"}>
      <OpenCard name={entryName(entry)} onOpen={onOpen} />
      <header className="nxp-head">
        <span className="nxp-name">{entryName(entry)}</span>
        {entry.legs ? <span className="nxp-legs"><Legs legs={entry.legs.map(signedLeg)} /></span> : null}
        {state ? <Chip state={state} /> : null}
      </header>
      {overlap ? <p className="nxp-meta nxp-overlap" data-overlap="">{overlap}</p> : null}
      {value !== undefined ? <p className="nxp-meta" data-value="">{`value ${value}`}</p> : null}
      <Progress entry={entry} />
      <p className="nxp-sentence"><RuleWords entry={entry} /></p>
      {entry.error ? <p className="nxp-error">{entry.error}</p> : null}
      {entry.legs ? <StrikeStrip strip={stripOfEntry(entry)!} /> : null}
      {under.length > 0 ? <ul className="nxp-rules">{under.map((r) => <RuleLine key={r.id} entry={r} />)}</ul> : null}
    </article>
  );
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
          <span className="nxp-meta">{QUARANTINED[m.disabled_reason ?? ""] ?? m.disabled_reason}</span>
          <MonitorControls rule={ruleOfMonitor(m)} served={null} />
        </li>
      ))}
      {muted.map((m) => (
        <li key={m.id} className="nxp-card" data-monitor={m.id} data-state="muted">
          <span className="nxp-name">{monitorName(m)}</span>
          <span className="nxp-sentence">{fieldWords(m.field)}</span>
          <span className="nxp-meta">{mutedWords(m.disabled_reason)}</span>
          <MonitorControls rule={ruleOfMonitor(m)} served={null} />
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
