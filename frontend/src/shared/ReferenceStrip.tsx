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

/** What the Reference is called, the vendor that answered, and how fresh the vendor says it is.
 *
 *  `SPX (ibkr)`, not `SPX`. A Reference may be fetched from a vendor other than the Provider, and
 *  the whole reason that is allowed is that it says where the figure came from (ADR 0019): a
 *  number on this strip is acted on by a person whether or not any code depends on it.
 *
 *  The arithmetic that used to be here — `SPX (via SPY ×10)` — went with the scale. It existed
 *  because moomoo refuses every index as a class; the index turned out to be obtainable, and a
 *  scaled stand-in is a simulation rather than a reading.
 *
 *  An unlabelled Reference is its code, which is already the truth about itself — with the vendor
 *  still named, because that is the part no code can tell you.
 */
export function referenceTitle(reference: Reference): string {
  const name = reference.label || shortCode(reference.code);
  const said = freshness(reference);
  return `${name} (${[reference.source, ...said].join(", ")})`;
}

/** What the vendor said about how fresh the figure is — nothing where it said nothing.
 *
 *  Two independent facts rather than one scale (ADR 0019): `delayed` is about the subscription and
 *  will not change during the day; `last_known` is about right now. Either can be true without the
 *  other, and grade 4 of IBKR's four is both.
 *
 *  Null is NOT false. moomoo reports no grade at all, so a bare `(moomoo)` means "it never said"
 *  while `(ibkr)` means "it told us this is live" — the two look identical and are not, which is
 *  why the Service panel records which vendors report freshness and which do not.
 *
 *  The minutes appear only where the vendor states them: Yahoo reports `exchangeDataDelayedBy`,
 *  IBKR reports a tier and no duration, so `15m late` and `delayed` are each what their vendor
 *  actually said rather than what we assumed.
 */
function freshness(reference: Reference): string[] {
  const said: string[] = [];
  if (reference.delayed === true) {
    const minutes = reference.delayed_by_minutes;
    said.push(minutes === null ? "delayed" : `${minutes}m late`);
  }
  if (reference.last_known === true) said.push("last known");
  return said;
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
