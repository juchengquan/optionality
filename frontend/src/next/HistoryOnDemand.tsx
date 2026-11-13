/** A holding's history on demand in LIVE (#353, ADR 0023 amended 2026-11-13): a collapsed section in
 *  the desk's inspector and the phone's holding sheet that draws `HoldingHistory` — the burndown,
 *  the IV chart and SPX against the strikes, exactly as REVIEW draws them — once it is opened.
 *
 *  - **Shut, it asks for nothing.** The charts are not mounted until the section is first opened,
 *    so no sample is read for a holding nobody asked about.
 *  - **Read once per opening of the holding.** Opened, the charts stay mounted, hidden when it is
 *    shut, so shutting and opening it again asks nothing more; `useSamples` reads once per id, so
 *    a poll's new valuation of the same holding asks nothing either. Samples never join a poll.
 *  - **Another holding starts shut.** What was opened is held with the id it was opened for, so a
 *    holding selected next is not read until its own section is opened, and a late answer for the
 *    last one lands nowhere (`useSamples`' guard, and the charts unmounted with it).
 *
 *  Privacy is `HoldingHistory`'s, as in REVIEW. The saved image does not carry it: the still draws
 *  neither mode's history. */
import { useId, useState } from "react";
import { ChevronRight } from "lucide-react";

import { HoldingHistory, type Charted } from "./History";

export function HistoryOnDemand({ holding, privacy }: { holding: Charted; privacy: boolean }) {
  const body = useId();
  // the holding it was opened for, and whether it is open now
  const [state, setState] = useState<{ id: string; open: boolean } | null>(null);
  const opened = state?.id === holding.id;
  const open = opened && state.open;
  return (
    <section className="nx-hist-od" data-open={open ? "" : undefined}>
      <button type="button" className="nx-hist-od-toggle" aria-expanded={open} aria-controls={body}
              onClick={() => setState({ id: holding.id, open: !open })}>
        <ChevronRight aria-hidden="true" className="nx-hist-od-mark" />
        history
      </button>
      <div id={body} className="nx-hist-od-body" hidden={!open}>
        {opened ? <HoldingHistory holding={holding} privacy={privacy} /> : null}
      </div>
    </section>
  );
}
