/** A holding's history on demand (#353, ADR 0023 amended 2026-11-13): a section in the desk's
 *  inspector and the phone's holding sheet that draws `HoldingHistory` — the burndown, the IV chart
 *  and SPX against the strikes — once it is opened.
 *
 *  - **Shut, it asks for nothing.** The charts are not mounted until the section is first opened,
 *    so no sample is read for a holding nobody asked about.
 *  - **Read once per opening of the holding.** Opened, the charts stay mounted, hidden when it is
 *    shut, so shutting and opening it again asks nothing more; `useSamples` reads once per id, so
 *    a poll's new valuation of the same holding asks nothing either. Samples never join a poll.
 *  - **Another holding starts afresh.** The inspector and the sheet draw a holding's detail keyed
 *    by its id, so this is drawn anew for each, in the state the session gives it; the charts of
 *    the one before go with it, and an answer for it lands nowhere (`useSamples`' guard).
 *
 *  - **Open outside the session, shut in it** (`defaultOpen`, #371): the desk's inspector (#372)
 *    and the phone's sheet (#374) both pass `!session`. Drawn open, it reads the samples at once,
 *    once, as an opening by hand would. Read when the section is first drawn and never after, so a
 *    change of session never folds or unfolds one already open.
 *
 *  Privacy is `HoldingHistory`'s. The saved image does not carry it: the still draws no history. */
import { useId, useState } from "react";
import { ChevronRight } from "lucide-react";

import { HoldingHistory, type Charted } from "./History";

export function HistoryOnDemand({ holding, privacy, defaultOpen = false }: {
  holding: Charted; privacy: boolean;
  /** drawn open, its samples read at once; read once, when first drawn, not on a later change */
  defaultOpen?: boolean;
}) {
  const body = useId();
  const [open, setOpen] = useState(defaultOpen);
  // once opened, the charts stay mounted, so shutting and opening again asks nothing more
  const [opened, setOpened] = useState(defaultOpen);
  return (
    <section className="nx-hist-od" data-open={open ? "" : undefined}>
      <button type="button" className="nx-hist-od-toggle" aria-expanded={open} aria-controls={body}
              onClick={() => { setOpen(!open); setOpened(true); }}>
        <ChevronRight aria-hidden="true" className="nx-hist-od-mark" />
        history
      </button>
      <div id={body} className="nx-hist-od-body" hidden={!open}>
        {opened ? <HoldingHistory holding={holding} privacy={privacy} /> : null}
      </div>
    </section>
  );
}
