import type { Reference } from "./api";
import { DASH } from "./format";
import { changeText, drawnReadings, FIGURE, referenceTitle } from "./readings";

/** The market, read beside the strikes — and nothing more (ADR 0018).
 *
 *  It sits BELOW the needs-you line on purpose. That line appears rather than reports, and its own comment
 *  says why: "a line that is almost always the same becomes furniture and stops being read, which
 *  fails on the one day it matters". This strip IS that furniture by design — it is almost always
 *  the same, and being glanceable is the whole of its job — so it must not occupy the position that
 *  has to stay conspicuous.
 *
 *  Which is also why it is never urgency-coloured and never enters `needs()`. A Reference cannot
 *  need you: nothing alarms on it, nothing is derived from it, and a figure that did not arrive is
 *  a dash rather than an event.
 */

function ReferenceReading({ reference, at }: { reference: Reference; at: string | null }) {
  const change = changeText(reference.change);
  return (
    // `reference` matches no CSS rule and is kept anyway: the layout suite measures each ITEM by
    // it (__browser__/References.test.tsx walks `.references .reference` and asserts none of them
    // pushes the page sideways at 320px), and the parts carry all the styling there is.
    <span className="reference" title={reference.error ?? reference.name ?? undefined}>
      <span className="reference-name">{referenceTitle(reference)}</span>
      {" "}
      <span className="reference-figure">
        {reference.figure === null ? DASH : FIGURE.format(reference.figure)}
      </span>
      {change ? <span className="reference-change">{change}</span> : null}
      {/* said only when it is the LAST TRADE, which is the weaker claim: every other figure on
          this page is a mid, and a last can be a session old — SPY's read 755.72 against a live
          mid of 758.73 (ADR 0018). The usual case says nothing, so the strip stays quiet. */}
      {reference.field === "last_price" ? <span className="reference-field">last</span> : null}
      {/* a dash was not READ at that time: its source was asked and gave nothing */}
      {at ? <span className="reference-time">{`${reference.figure === null ? "tried" : "read"} at ${at}`}</span> : null}
    </span>
  );
}

/** @param timeOf given outside New York's session, where the page reads the strip once rather than
 *  polling it (#371): the words for when the service read each reading, from its own stamp in
 *  DISPLAY_TZ (`fetched_at`) — dated where the time alone would mislead (`servedWhen`). ADR 0018's
 *  concern is a frozen figure that looks live, and the time is what answers it. In session the strip
 *  is polled with the book and says no time, as it always has.
 *
 *  A reading with NO time at all is not drawn outside the session, rather than drawn bare. Every
 *  service since #371 stamps every reading, so this is a service older than the page — a deploy
 *  that restarted one and not the other — and a strip that hides its figures until both agree is
 *  the honest failure: the one ADR 0018 rules out is a figure shown as if current. */
export function ReferenceStrip({ references, timeOf }: {
  references: Reference[]; timeOf?: (served: string | null | undefined) => string | null;
}) {
  const drawn = drawnReadings(references, timeOf);
  // nothing kept, nothing drawn: a backdrop nobody asked for would be a line that is always the
  // same with nothing in it
  if (drawn.length === 0) return null;
  return (
    <div className="references">
      {drawn.map(({ reference, at }) => <ReferenceReading key={reference.id} reference={reference} at={at} />)}
    </div>
  );
}
