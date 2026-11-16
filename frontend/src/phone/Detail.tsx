/** The phone's detail sheet (ADR 0023): a bottom sheet over the cards, with a card's detail and
 *  its rules, in the one order the desk's inspector draws (part J, `DetailSections.tsx`). Back
 *  closes it — a history entry, never a route (ADR 0005) — through the same `useDismissOnBack` the
 *  old page's sheet used. */
import { useEffect, useRef } from "react";

import type { Entry, Holding, Monitor } from "../shared/api";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { readUp, type EntryStyle } from "../shared/prefs";
import { useDismissOnBack } from "../shared/useDismissOnBack";
import type { HoldingWrites } from "../HoldingActions";
import { DetailBoundary } from "../DetailBoundary";
import { entryName } from "../needs";
import { HoldingSections, holdingMeta, RuleSections, ruleMeta } from "../DetailSections";
import { RuleLine } from "./Cards";
import { HoldingStrip } from "../StrikeStrip";
import { MonitorControls } from "../MonitorEdit";
import { ruleOfEntry } from "../edit";

export type Subject =
  | { kind: "holding"; holding: Holding; rules: Entry[] }
  | { kind: "rule"; entry: Entry; under: Entry[]; overlap?: string | null };

export function DetailSheet({ subject, onClose, quotes, monitors, privacy, entryStyle, writes, session }: {
  /** what is open, from the figures as they are NOW, or null for nothing */
  subject: Subject | null;
  onClose: () => void;
  quotes: Entry[];
  monitors: Monitor[];
  privacy: boolean;
  entryStyle: EntryStyle;
  /** editing, closing and deleting a holding (#294) */
  writes?: HoldingWrites;
  /** outside the session a holding's Level says which valuation it is from (#354, #371), and its
   *  history opens with the sheet (#374) */
  session: boolean;
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
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}
           onOpenChangeComplete={(o) => { if (!o && last.current) bringBack(refOf(last.current)); }}>
      {/* drawn in a portal OUTSIDE .nx, so it carries the page's colour tokens itself (next.css:
          .nx-tokens) and the two settings they read */}
      <SheetContent side="bottom" className="nx-tokens nxp-sheet" data-up={readUp()} data-entry={entryStyle}>
        {shown ? (
          <DetailBoundary key={shown.kind === "holding" ? shown.holding.id : shown.entry.id} what={shown.kind}>
            {shown.kind === "holding" ? (
              <HoldingDetail holding={shown.holding} rules={shown.rules} quotes={quotes} monitors={monitors}
                             privacy={privacy} session={session} writes={writes} />
            ) : <RuleDetail entry={shown.entry} under={shown.under} overlap={shown.overlap ?? null}
                            session={session} privacy={privacy} />}
          </DetailBoundary>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function HoldingDetail({ holding, rules, quotes, monitors, privacy, session, writes }: {
  holding: Holding; rules: Entry[]; quotes: Entry[]; monitors: Monitor[]; privacy: boolean; session: boolean;
  writes?: HoldingWrites;
}) {
  return (
    <>
      <SheetHeader>
        <SheetTitle>{holding.name}</SheetTitle>
        <SheetDescription>{holdingMeta(holding)}</SheetDescription>
      </SheetHeader>
      <div className="nxp-sheet-body">
        {/* the one order the desk's inspector draws too (part J, `sections.ts`) */}
        <HoldingSections surface="phone" holding={holding} rules={rules} quotes={quotes} monitors={monitors}
                         privacy={privacy} session={session} writes={writes}
                         strip={<HoldingStrip holding={holding} />}
                         ruleLine={(r, own) => <EditableLine key={r.id} entry={r} own={own} />} />
      </div>
    </>
  );
}

function RuleDetail({ entry, under, overlap = null, session, privacy }: {
  entry: Entry; under: Entry[]; overlap?: string | null; session: boolean; privacy: boolean;
}) {
  return (
    <>
      <SheetHeader>
        <SheetTitle>{entryName(entry)}</SheetTitle>
        <SheetDescription>{ruleMeta(entry)}</SheetDescription>
      </SheetHeader>
      <div className="nxp-sheet-body">
        <RuleSections surface="phone" entry={entry} under={under} overlap={overlap} privacy={privacy} session={session}
                      ruleLine={(r, own) => <EditableLine key={r.id} entry={r} own={own} />} />
      </div>
    </>
  );
}

/** A rule in the sheet with its controls under it (#292). */
function EditableLine({ entry, own = false }: { entry: Entry; own?: boolean }) {
  return (
    <RuleLine entry={entry} marked={false} own={own}>
      <MonitorControls rule={ruleOfEntry(entry)} served={entry} />
    </RuleLine>
  );
}

/** The card a subject is drawn as, by the `data-ref` every card carries (NeedsLine's `reveal`). */
function refOf(subject: Subject): string {
  return subject.kind === "holding" ? subject.holding.id : subject.entry.id;
}

/** The card a sheet was about, brought clear of the sticky header once the sheet has gone (#410):
 *  opened from a card half under the header, Back would otherwise leave it there. Only once the
 *  sheet's scroll lock has let go, which puts the page back where it was — done sooner, that undoes
 *  it — and not at all where the card has left the book (a close says so itself, `ClosedResult`).
 *  "nearest", so a card already in view does not move. */
function bringBack(ref: string): void {
  const started = performance.now();
  const step = () => {
    if (document.documentElement.hasAttribute("data-base-ui-scroll-locked") && performance.now() - started < 1000) {
      requestAnimationFrame(step);
      return;
    }
    const card = [...document.querySelectorAll<HTMLElement>(".nx [data-ref]")].find((el) => el.dataset.ref === ref);
    card?.scrollIntoView?.({ block: "nearest" });
  };
  requestAnimationFrame(step);
}
