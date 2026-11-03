import type { Reference } from "./api";
import { DASH } from "./format";

/** The market, read beside the strikes — and nothing more (ADR 0018).
 *
 *  It sits BELOW `TopLine` on purpose. That line appears rather than reports, and its own comment
 *  says why: "a line that is almost always the same becomes furniture and stops being read, which
 *  fails on the one day it matters". This strip IS that furniture by design — it is almost always
 *  the same, and being glanceable is the whole of its job — so it must not occupy the position that
 *  has to stay conspicuous.
 *
 *  Which is also why it is never urgency-coloured and never enters `needs()`. A Reference cannot
 *  need you: nothing alarms on it, nothing is derived from it, and a figure that did not arrive is
 *  a dash rather than an event.
 */

/** `US.SPY` → `SPY`. The market prefix is on every code in this service and carries nothing. */
function shortCode(code: string): string {
  return code.replace(/^US\./, "");
}

/** What the Reference is called, with its arithmetic shown.
 *
 *  `SPX (via SPY ×10)`, never `SPX`. SPY×10 is NOT SPX: there is tracking error, there are
 *  dividends, and the two trade different sessions. The label is the only place SPX is said at
 *  all, so the figure beside it must never read as the index itself — and the `via` is what keeps
 *  the claim honest while still saving the mental ×10 at every glance.
 *
 *  An unlabelled Reference is just its code, which is already the truth about itself.
 */
export function referenceTitle(reference: Reference): string {
  const via = shortCode(reference.code);
  if (!reference.label) return via;
  return `${reference.label} (via ${via}${reference.scale === null ? "" : ` ×${reference.scale}`})`;
}

/** Thousands separated and two places: these are index-sized numbers, and 7587.3 beside a strike
 *  of 6950 is read by its digits.
 *
 *  `en-US` named explicitly, never the device's locale: the owner's browser is Chinese and a bare
 *  `toLocaleString()` renders the page in whatever language the device is set to (`format.clockTime`
 *  has the same note, and the bug that earned it). */
const FIGURE = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
});

/** The day's move, signed, as a percentage of the previous close. Scale-free, like the fraction the
 *  service sends. */
function changeText(change: number | null): string | null {
  if (change === null) return null;
  const pc = change * 100;
  return `${pc >= 0 ? "+" : ""}${pc.toFixed(2)}%`;
}

function ReferenceReading({ reference }: { reference: Reference }) {
  const change = changeText(reference.change);
  return (
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
    </span>
  );
}

export function ReferenceStrip({ references }: { references: Reference[] }) {
  // nothing kept, nothing drawn: a backdrop nobody asked for would be a line that is always the
  // same with nothing in it
  if (references.length === 0) return null;
  return (
    <div className="references">
      {references.map((r) => <ReferenceReading key={r.id} reference={r} />)}
    </div>
  );
}
