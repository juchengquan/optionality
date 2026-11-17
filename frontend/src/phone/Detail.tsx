/** The phone's detail sheet (ADR 0023): a bottom sheet over the cards, with a card's detail and
 *  its rules, in the one order the desk's inspector draws (part J, `DetailSections.tsx`). Back
 *  closes it — a history entry, never a route (ADR 0005) — through the same `useDismissOnBack` the
 *  old page's sheet used. */
import { useRef, type RefObject } from "react";

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
import { STALE_WORDS } from "../kept";
import { MonitorControls } from "../MonitorEdit";
import { ruleOfEntry } from "../edit";

export type Subject =
  | { kind: "holding"; holding: Holding; rules: Entry[] }
  | { kind: "rule"; entry: Entry; under: Entry[]; overlap?: string | null };

export function DetailSheet({ subject, onClose, quotes, monitors, privacy, entryStyle, writes, session, stale = false }: {
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
  /** drawn from the last valuation that succeeded, the ones since having failed (`kept.ts`) */
  stale?: boolean;
}) {
  const open = subject !== null;
  // Unmounted while open — the phone turned into the desk (a Pro Max in landscape is 932px) — its
  // entry would stay on the stack, and the next Back would do nothing. Next.tsx keeps the desk's
  // Settings mounted for this; the book cannot stay mounted in the other arrangement, so it gives its
  // entry back as it goes — through the hook's one list, since "Record as held"'s Add may be open
  // over it, its entry above this one's
  useDismissOnBack(open, onClose, { giveBackOnUnmount: true });
  // the sheet animates out after it closes, and must still have something to draw while it does
  const last = useRef<Subject | null>(null);
  if (subject) last.current = subject;
  const shown = subject ?? last.current;
  // opened on its title, as the journal's sheet is: Base UI focuses the first control by default, and
  // on a holding that is its first rule's "edit", far down — the sheet opened 905px into its 1559 on
  // the live book (2026-11-17), at "on pace", not at the top
  const title = useRef<HTMLHeadingElement>(null);
  // closed, the focus goes back to the card that opened it; where that card is gone — its rule
  // muted or deleted from its own sheet, as a leg's rule is since 2026-11-17 — to the book's
  // heading, never the body, where the next Tab would start from the top
  const handBack = () => (last.current && cardOf(refOf(last.current)) ? true : bookHeading());

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}
           onOpenChangeComplete={(o) => { if (!o && last.current) bringBack(refOf(last.current)); }}>
      {/* drawn in a portal OUTSIDE .nx, so it carries the page's colour tokens itself (next.css:
          .nx-tokens) and the two settings they read */}
      <SheetContent side="bottom" className="nx-tokens nxp-sheet" data-up={readUp()} data-entry={entryStyle}
                    data-stale={stale ? "" : undefined} initialFocus={title} finalFocus={handBack}>
        {shown ? (
          <DetailBoundary key={shown.kind === "holding" ? shown.holding.id : shown.entry.id} what={shown.kind}>
            {shown.kind === "holding" ? (
              <HoldingDetail title={title} holding={shown.holding} rules={shown.rules} quotes={quotes} monitors={monitors}
                             privacy={privacy} session={session && !stale} writes={writes} stale={stale} />
            ) : <RuleDetail title={title} entry={shown.entry} under={shown.under} overlap={shown.overlap ?? null}
                            session={session} privacy={privacy} />}
          </DetailBoundary>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function HoldingDetail({ title, holding, rules, quotes, monitors, privacy, session, writes, stale = false }: {
  title: RefObject<HTMLHeadingElement | null>;
  holding: Holding; rules: Entry[]; quotes: Entry[]; monitors: Monitor[]; privacy: boolean; session: boolean;
  writes?: HoldingWrites;
  /** drawn from the last valuation that succeeded (`kept.ts`): said in the header, over its figures,
   *  since the sheet covers the book's line saying why */
  stale?: boolean;
}) {
  return (
    <>
      <SheetHeader>
        <SheetTitle ref={title} tabIndex={-1}>{holding.name}</SheetTitle>
        <SheetDescription>{holdingMeta(holding)}</SheetDescription>
        {stale ? <p className="nxp-meta nxp-stale" role="status">{STALE_WORDS}</p> : null}
      </SheetHeader>
      <div className="nxp-sheet-body">
        {/* the one order the desk's inspector draws too (part J, `sections.ts`) */}
        <HoldingSections surface="phone" holding={holding} rules={rules} quotes={quotes} monitors={monitors}
                         privacy={privacy} session={session} writes={writes}
                         strip={<HoldingStrip holding={holding} />}
                         ruleLine={(r, own) => <EditableLine key={r.id} entry={r} own={own} within={holding.name} />} />
      </div>
    </>
  );
}

function RuleDetail({ title, entry, under, overlap = null, session, privacy }: {
  title: RefObject<HTMLHeadingElement | null>;
  entry: Entry; under: Entry[]; overlap?: string | null; session: boolean; privacy: boolean;
}) {
  return (
    <>
      <SheetHeader>
        <SheetTitle ref={title} tabIndex={-1}>{entryName(entry)}</SheetTitle>
        <SheetDescription>{ruleMeta(entry)}</SheetDescription>
      </SheetHeader>
      <div className="nxp-sheet-body">
        <RuleSections surface="phone" entry={entry} under={under} overlap={overlap} privacy={privacy} session={session}
                      ruleLine={(r, own) => <EditableLine key={r.id} entry={r} own={own} within={entryName(entry)} />} />
      </div>
    </>
  );
}

/** A rule in the sheet with its controls under it (#292). */
function EditableLine({ entry, own = false, within }: { entry: Entry; own?: boolean; within: string }) {
  return (
    <RuleLine entry={entry} marked={false} own={own} within={within}>
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
/** The card drawn for `ref`, if it is still in the book. */
function cardOf(ref: string): HTMLElement | null {
  return [...document.querySelectorAll<HTMLElement>(".nx [data-ref]")].find((el) => el.dataset.ref === ref) ?? null;
}

/** The book's heading, made focusable: where the focus goes when the card a sheet came from is gone. */
function bookHeading(): HTMLElement | null {
  const h = document.querySelector<HTMLElement>(".nx .nxp-book h2");
  if (h && !h.hasAttribute("tabindex")) h.setAttribute("tabindex", "-1");
  return h;
}

function bringBack(ref: string): void {
  const started = performance.now();
  const step = () => {
    if (document.documentElement.hasAttribute("data-base-ui-scroll-locked") && performance.now() - started < 1000) {
      requestAnimationFrame(step);
      return;
    }
    cardOf(ref)?.scrollIntoView?.({ block: "nearest" });
  };
  requestAnimationFrame(step);
}
