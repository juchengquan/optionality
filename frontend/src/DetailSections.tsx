/** A holding's or a rule's detail, section by section in the ONE order `sections.ts` gives, drawn by
 *  the desk's inspector and the phone's sheet alike (the owner's standard of 2026-11-16, part J; ADR
 *  0023). Each surface passes only what is its own — its chip, its strip, how it draws a rule line —
 *  and its class names; the sections, their order, their headings and their words are here, once.
 *
 *  Every section is drawn inside a `data-section` wrapper with its key, which is what
 *  `NextDetailOrder.test.tsx` reads on both surfaces.
 */
import type { ReactNode } from "react";

import type { Entry, Holding, Monitor } from "./shared/api";
import { heldLeg, shortFirst, signedLeg, type WrittenLeg } from "./shared/format";
import { Leg } from "./shared/Legs";
import { Money } from "./Book";
import { HoldingActions, type HoldingWrites } from "./HoldingActions";
import { HoldingPayoff, WatchedPayoff } from "./Payoff";
import { PaceExplained } from "./PaceExplained";
import { manageBy, paceOutcome, paceWords } from "./pace";
import { fieldWords } from "./needs";
import { RuleFigures } from "./RuleFigures";
import { HistoryOnDemand } from "./HistoryOnDemand";
import { ShortDeltaWords } from "./phone/Cards";
import { StrikeStrip } from "./StrikeStrip";
import { stripOfEntry, stripOfHolding } from "./strip";
import { figureOf, percent, points } from "./shared/numbers";
import { POSITION_GREEKS, SHORT_DELTA } from "./shared/words";
import { dateWords } from "./shared/times";
import { AttentionChip } from "./AttentionChip";
import { attentionOf, chipWords, type DeskRow } from "./desk/columns";
import { ruleState } from "./phone/state";
import { RawDetails } from "./shared/ErrorWords";
import { rawReason } from "./shared/errors";
import { HOLDING_SECTIONS, RULE_SECTIONS, SECTION_HEADINGS, type HoldingSection, type RuleSection } from "./sections";

export type Surface = "desk" | "phone";

/** The class names each surface draws its parts in, so each looks like the rest of it. */
const CLASSES: Record<Surface, { facts: string; meta: string; heading: string; hero: string; heroSub: string; rules: string }> = {
  desk: { facts: "nxd-kv", meta: "nx-meta", heading: "nxd-h", hero: "nxd-hero", heroSub: "nxd-hero-sub", rules: "nxd-rules" },
  phone: { facts: "nxp-facts", meta: "nxp-meta", heading: "nxp-h", hero: "nxp-hero", heroSub: "nxp-hero-sub", rules: "nxp-rules" },
};

/** The line under a holding's name: its expiry in prose, its DTE once, and the day it was opened in
 *  prose (part F) — never ISO. */
export function holdingMeta(h: Pick<Holding, "strike_date" | "dte" | "opened_at">): string {
  return `${dateWords(h.strike_date)} · ${h.dte} DTE · ${h.opened_at ? `opened ${dateWords(h.opened_at)}` : "Opened not recorded"}`;
}

/** The line under a rule's name: its expiry in prose and its DTE. */
export function ruleMeta(e: Pick<Entry, "strike_date" | "dte">): string {
  return `${dateWords(e.strike_date)} · ${e.dte} DTE`;
}

/** A structure's legs in words, short first, `short 2× CALL 8150`, each type in its colour (#391). */
export function LegList({ legs }: { legs: WrittenLeg[] }) {
  return (
    <ul className="nx-leglist" aria-label="legs">
      {shortFirst(legs).map((l, i) => <li key={`${i}:${l.option_type}${l.strike}`}><Leg leg={l} form="words" /></li>)}
    </ul>
  );
}

/** A figure: its label, what it says, and the outcome its value is drawn in, if any. */
type Fact = [string, ReactNode, ("loss" | "gain")?];

function Facts({ surface, items, label }: { surface: Surface; items: Fact[]; label?: string }) {
  return (
    <dl className={CLASSES[surface].facts} aria-label={label}>
      {items.map(([k, v, outcome]) => <div key={k}><dt>{k}</dt><dd data-outcome={outcome}>{v}</dd></div>)}
    </dl>
  );
}

function Heading({ surface, of }: { surface: Surface; of: HoldingSection | RuleSection }) {
  const words = SECTION_HEADINGS[of];
  return words ? <h4 className={CLASSES[surface].heading}>{words}</h4> : null;
}

/** The sections drawn, in the list's order, each in its marked wrapper; one with nothing is left out. */
function inOrder<K extends string>(order: readonly K[], drawn: Record<K, ReactNode>): ReactNode {
  return order.map((k) => (drawn[k] === null || drawn[k] === undefined || drawn[k] === false ? null
    : <div key={k} className="nx-section" data-section={k}>{drawn[k]}</div>));
}

export function HoldingSections({
  surface, holding, rules, quotes, monitors, privacy, session, strip, ruleLine, writes, extra,
}: {
  surface: Surface;
  holding: Holding;
  /** the enabled rules placed under it */
  rules: Entry[];
  quotes: Entry[];
  monitors: Monitor[];
  privacy: boolean;
  session: boolean;
  /** its strike strip, as the surface draws it (the desk's joins a bracketed partner's) */
  strip: ReactNode;
  /** a rule line with its controls, as the surface draws one, with how far it has come toward its
   *  threshold. `own` is the rule the detail is OF, whose chip and fault its level section says
   *  once (review of #420) */
  ruleLine: (e: Entry, own: boolean) => ReactNode;
  writes?: HoldingWrites;
  /** drawn at the end of the legs section: the desk's link to a condor's other spread */
  extra?: ReactNode;
}) {
  const c = CLASSES[surface];
  const s = holding.schedule;
  const g = holding.greeks;
  const manage = manageBy(holding);
  // its Level or its Manage-by: one chip, one reading of it, on both surfaces (review of #420)
  const row: DeskRow = { kind: "holding", holding, rules };
  const attention = attentionOf(row);
  const chip = attention ? <AttentionChip kind={attention} words={chipWords(row, session)} /> : null;
  const drawn: Record<HoldingSection, ReactNode> = {
    level: (
      <div className={c.hero}>
        <Money value={holding.pnl} privacy={privacy} />
        <span className={c.heroSub}>{`captured ${percent(holding.captured)}`}</span>
        {chip}
      </div>
    ),
    legs: <><LegList legs={holding.legs.map(heldLeg)} />{extra}</>,
    strip,
    payoff: <HoldingPayoff holding={holding} privacy={privacy} spxSaid={stripOfHolding(holding) !== null} />,
    figures: (
      <Facts surface={surface} label="figures" items={[
        ["cost to close", points(holding.cost_to_close)],
        ["entry", points(holding.entry)],
        // privacy hides the count too: contracts × points × the contract size is the money it hides
        ["contracts", privacy ? "×•••" : `×${holding.contracts}`],
        [SHORT_DELTA, <ShortDeltaWords holding={holding} quotes={quotes} monitors={monitors} />],
        ...POSITION_GREEKS.map(([k, label]): Fact => [label, figureOf(k, g[k])]),
      ]} />
    ),
    schedule: (
      <>
        <Heading surface={surface} of="schedule" />
        {s ? (
          <Facts surface={surface} label="exit schedule" items={[
            ["target", points(s.target)],
            ["stop", points(s.stop)],
            ["on pace", points(s.on_pace)],
            ["pace gap", paceWords(s.pace_gap), paceOutcome(s.pace_gap)],
            ["manage-by", <>{manage.text}{manage.detail ? <span className="nx-detail">{` ${manage.detail}`}</span> : null}</>],
          ]} />
        ) : <p className={c.meta}>no schedule — Opened not recorded</p>}
      </>
    ),
    pace: s ? <PaceExplained holding={holding} /> : null,
    rules: (
      <>
        <Heading surface={surface} of="rules" />
        {rules.length > 0
          ? <ul className={c.rules}>{rules.map((r) => ruleLine(r, false))}</ul>
          : <p className={c.meta}>no rule on it</p>}
      </>
    ),
    actions: writes ? (
      <HoldingActions key={holding.id} holding={holding} monitors={monitors} rules={rules} privacy={privacy} writes={writes} />
    ) : null,
    // open from the start outside the session and shut in it (#372, #374): read when the detail
    // opens, which is keyed by the holding, so the session decides how the NEXT one opens
    history: <HistoryOnDemand holding={holding} privacy={privacy} defaultOpen={!session} />,
  };
  return <>{inOrder(HOLDING_SECTIONS, drawn)}</>;
}

export function RuleSections({
  surface, entry, under, overlap, privacy, session, ruleLine,
}: {
  surface: Surface;
  entry: Entry;
  /** the rules on its legs, drawn under it */
  under: Entry[];
  /** what a watchlist spread shares with a holding it partly overlaps (#346) */
  overlap: string | null;
  privacy: boolean;
  session: boolean;
  ruleLine: (e: Entry, own: boolean) => ReactNode;
}) {
  const c = CLASSES[surface];
  const state = ruleState(entry);
  // a combo drawn in the watchlist because it names a contract its holding does not hold is a
  // watched spread here too (#346): its note says what it shares, in place of "on something held"
  const watched = !entry.held || Boolean(overlap);
  const drawn: Record<RuleSection, ReactNode> = {
    level: (
      <>
        {state ? <p><AttentionChip kind={state} /></p> : null}
        {overlap ? null : <p className={c.meta}>{entry.held ? "on something held" : "watch only"}</p>}
        {overlap ? <p className={`${c.meta} nx-overlap`} data-overlap="">{overlap}</p> : null}
        {/* the fault in plain words, what was served one tap away (part N) */}
        {entry.error ? <div className="nx-why">{entry.error}<RawDetails plain={entry.error} raw={rawReason(entry, "error")} /></div> : null}
      </>
    ),
    legs: entry.legs ? <LegList legs={entry.legs.map(signedLeg)} /> : null,
    strip: entry.legs ? <StrikeStrip strip={stripOfEntry(entry)!} /> : null,
    payoff: entry.legs && watched ? <WatchedPayoff entry={entry} session={session} spxSaid /> : null,
    figures: (
      <>
        {/* what it watches, the line both surfaces open its figures with (part J) */}
        <Facts surface={surface} label="watches" items={[
          ["watches", fieldWords(entry.field)],
          ["compare", entry.compare === "abs" ? "its size" : "signed"],
        ]} />
        {/* every figure of its contract or combo, the reason beside each dash (#332) */}
        <RuleFigures entry={entry} held={entry.held && !overlap} className={c.facts} />
      </>
    ),
    rules: (
      <>
        <Heading surface={surface} of="rules" />
        <ul className={c.rules}>{[entry, ...under].map((r) => ruleLine(r, r.id === entry.id))}</ul>
      </>
    ),
    // a watched row's daily closes (#402), opened as a holding's history is (#372)
    history: watched ? <HistoryOnDemand watched={entry} privacy={privacy} defaultOpen={!session} /> : null,
  };
  return <>{inOrder(RULE_SECTIONS, drawn)}</>;
}
