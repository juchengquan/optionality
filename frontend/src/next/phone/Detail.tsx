/** The phone's detail sheet (ADR 0023): a bottom sheet over the cards, with a card's detail and
 *  its Monitors. Back closes it — a history entry, never a route (ADR 0005) — through the same
 *  `useDismissOnBack` today's sheet at `/opt` uses. */
import { useEffect, useRef } from "react";

import type { Entry, Holding, Monitor } from "../../api";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { DASH, legSummary } from "../../format";
import { readUp, type EntryStyle } from "../../prefs";
import { useDismissOnBack } from "../../useDismissOnBack";
import { Chip, Money } from "../Book";
import { HoldingActions, type HoldingWrites } from "../HoldingActions";
import { HoldingPayoff, WatchedPayoff } from "../Payoff";
import { PaceExplained } from "../PaceExplained";
import { paceOutcome, paceWords } from "../pace";
import { entryName, fieldWords, sentence } from "../needs";
import { LevelChip, Progress, RuleLine } from "./Cards";
import { contractsWords, delta, expiryWords, holdingLegs, percent, points, shortDeltas, shortDeltaWords } from "./figures";
import { ruleState } from "./state";
import { HoldingStrip, StrikeStrip } from "../StrikeStrip";
import { stripOfEntry } from "../strip";
import { MonitorControls } from "../MonitorEdit";
import { ruleOfEntry } from "../edit";
import { RuleFigures } from "../RuleFigures";

export type Subject =
  | { kind: "holding"; holding: Holding; rules: Entry[] }
  | { kind: "rule"; entry: Entry; under: Entry[] };

export function DetailSheet({ subject, onClose, quotes, monitors, privacy, entryStyle, writes }: {
  /** what is open, from the figures as they are NOW, or null for nothing */
  subject: Subject | null;
  onClose: () => void;
  quotes: Entry[];
  monitors: Monitor[];
  privacy: boolean;
  entryStyle: EntryStyle;
  /** editing, closing and deleting a holding (#294) */
  writes?: HoldingWrites;
}) {
  const open = subject !== null;
  useDismissOnBack(open, onClose);
  // Unmounted while open — the phone turned into the desk (a Pro Max in landscape is 932px) — the
  // hook's listener goes with it and its entry stays on the stack, so the next Back would do
  // nothing. Next.tsx keeps the desk's Settings mounted for this; the book cannot stay mounted
  // in the other arrangement, so it takes its entry back as it goes, if that entry is still
  // the one the page is on.
  const openNow = useRef(open);
  openNow.current = open;
  useEffect(() => () => {
    if (openNow.current && window.history.state?.panel) window.history.back();
  }, []);
  // the sheet animates out after it closes, and must still have something to draw while it does
  const last = useRef<Subject | null>(null);
  if (subject) last.current = subject;
  const shown = subject ?? last.current;

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      {/* drawn in a portal OUTSIDE .nx, so it carries the page's colour tokens itself (next.css:
          .nx-tokens) and the two settings they read */}
      <SheetContent side="bottom" className="nx-tokens nxp-sheet" data-up={readUp()} data-entry={entryStyle}>
        {shown?.kind === "holding" ? (
          <HoldingDetail holding={shown.holding} rules={shown.rules} quotes={quotes} monitors={monitors}
                         privacy={privacy} />
        ) : shown?.kind === "rule" ? <RuleDetail entry={shown.entry} under={shown.under} /> : null}
        {shown?.kind === "holding" && writes ? (
          <div className="nxp-sheet-body">
            <HoldingActions key={shown.holding.id} holding={shown.holding} monitors={monitors} rules={shown.rules}
                            privacy={privacy} writes={writes} />
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

const greek = (n: number | null | undefined, places: number) =>
  n === null || n === undefined ? DASH : n.toFixed(places);

function HoldingDetail({ holding, rules, quotes, monitors, privacy }: {
  holding: Holding; rules: Entry[]; quotes: Entry[]; monitors: Monitor[]; privacy: boolean;
}) {
  const s = holding.schedule;
  const g = holding.greeks;
  return (
    <>
      <SheetHeader>
        <SheetTitle>{holding.name}</SheetTitle>
        <SheetDescription>
          {`${holdingLegs(holding)} · ${contractsWords(holding.contracts, privacy)} · ${expiryWords(holding.strike_date)} · ${holding.dte} DTE`}
        </SheetDescription>
      </SheetHeader>
      <div className="nxp-sheet-body">
        <div className="nxp-hero">
          <Money value={holding.pnl} privacy={privacy} />
          <span className="nxp-hero-sub">{`captured ${percent(holding.captured)}`}</span>
          <LevelChip holding={holding} />
        </div>
        <HoldingStrip holding={holding} />
        <HoldingPayoff holding={holding} privacy={privacy} />
        <dl className="nxp-facts">
          <div><dt>cost to close</dt><dd>{points(holding.cost_to_close)}</dd></div>
          <div><dt>entry</dt><dd>{points(holding.entry)}</dd></div>
          <div><dt>short Δ</dt><dd>{shortDeltaWords(shortDeltas(holding, quotes, monitors))}</dd></div>
          <div><dt>opened</dt><dd>{holding.opened_at ?? DASH}</dd></div>
          <div><dt>Δ</dt><dd>{delta(g.option_delta)}</dd></div>
          <div><dt>γ</dt><dd>{greek(g.option_gamma, 4)}</dd></div>
          <div><dt>θ</dt><dd>{greek(g.option_theta, 2)}</dd></div>
          <div><dt>vega</dt><dd>{greek(g.option_vega, 2)}</dd></div>
        </dl>
        <h3 className="nxp-h">Exit schedule</h3>
        {s ? (
          <dl className="nxp-facts">
            <div><dt>target</dt><dd>{points(s.target)}</dd></div>
            <div><dt>stop</dt><dd>{points(s.stop)}</dd></div>
            <div><dt>on pace</dt><dd>{points(s.on_pace)}</dd></div>
            <div><dt>pace gap</dt><dd data-outcome={paceOutcome(s.pace_gap)}>{paceWords(s.pace_gap)}</dd></div>
            <div><dt>manage-by</dt><dd>{`${s.manage_by_dte} DTE`}</dd></div>
          </dl>
        ) : <p className="nxp-meta">no schedule — Opened not recorded</p>}
        <PaceExplained holding={holding} />
        <h3 className="nxp-h">Monitors</h3>
        {rules.length > 0
          ? <ul className="nxp-rules">{rules.map((r) => <EditableLine key={r.id} entry={r} />)}</ul>
          : <p className="nxp-meta">no Monitor is linked to this holding</p>}
      </div>
    </>
  );
}

function RuleDetail({ entry, under }: { entry: Entry; under: Entry[] }) {
  const state = ruleState(entry);
  return (
    <>
      <SheetHeader>
        <SheetTitle>{entryName(entry)}</SheetTitle>
        <SheetDescription>
          {`${entry.legs ? `${legSummary(entry.legs)} · ` : ""}${expiryWords(entry.strike_date)} · ${entry.dte} DTE`}
        </SheetDescription>
      </SheetHeader>
      <div className="nxp-sheet-body">
        {state ? <p><Chip state={state} /></p> : null}
        <Progress entry={entry} />
        <p className="nxp-sentence">{sentence(entry)}</p>
        {entry.error ? <p className="nxp-error">{entry.error}</p> : null}
        <MonitorControls rule={ruleOfEntry(entry)} served={entry} />
        {entry.legs ? <StrikeStrip strip={stripOfEntry(entry)!} /> : null}
        {entry.legs && !entry.held ? <WatchedPayoff entry={entry} /> : null}
        <dl className="nxp-facts">
          <div><dt>watches</dt><dd>{fieldWords(entry.field, Boolean(entry.legs))}</dd></div>
          <div><dt>compare</dt><dd>{entry.compare === "abs" ? "its size" : "signed"}</dd></div>
          <div><dt>expiry</dt><dd>{entry.strike_date}</dd></div>
        </dl>
        {/* every figure of its contract or combo, the reason beside each dash (#332) */}
        <RuleFigures entry={entry} className="nxp-facts" />
        {under.length > 0 ? (
          <>
            <h3 className="nxp-h">Monitors on its legs</h3>
            <ul className="nxp-rules">{under.map((r) => <EditableLine key={r.id} entry={r} />)}</ul>
          </>
        ) : null}
      </div>
    </>
  );
}

/** A rule in the sheet with its controls under it (#292). */
function EditableLine({ entry }: { entry: Entry }) {
  return (
    <RuleLine entry={entry} marked={false}>
      <MonitorControls rule={ruleOfEntry(entry)} served={entry} />
    </RuleLine>
  );
}
