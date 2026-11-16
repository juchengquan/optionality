/** A Reference reading in words (ADR 0018, ADR 0019): what the strip draws (`ReferenceStrip.tsx`),
 *  the References panel names, and the saved picture and its text say (#394). Pure, so the picture's
 *  builder (`snapshot/plain.ts`) reaches it without a component. */
import { fixed, spx } from "./numbers";
import type { Reference } from "./api";
import { DASH } from "./format";

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

/** A reading's figure: two places and no thousands separator, as SPX is written everywhere on the
 *  page (`shared/numbers.ts`: `spx`, 2026-11-16) — the strip's 7561.67 is read against the strikes
 *  and breakevens beside it, which carry none. */
export const FIGURE = { format: (n: number): string => spx(n) };

/** The day's move, signed, as a percentage of the previous close. Scale-free, like the fraction the
 *  service sends. */
export function changeText(change: number | null): string | null {
  if (change === null) return null;
  const pc = change * 100;
  const text = fixed(pc, 2);
  // a move too small for two places is the formatter's bound with its sign inside it: "<+0.01%",
  // as a fall is ">−0.01%"
  if (text.startsWith("<")) return `<+${text.slice(1)}%`;
  return `${pc > 0 || text === "0.00" ? "+" : ""}${text}%`;
}

/** One reading in words, as the strip draws it, for the saved picture and its text (#394): "S&P 500
 *  (moomoo) 7,612.25 +0.42% read at 00:59". */
export function referenceWords(reference: Reference, at: string | null): string {
  const change = changeText(reference.change);
  return [
    referenceTitle(reference),
    reference.figure === null ? DASH : FIGURE.format(reference.figure),
    ...(change ? [change] : []),
    ...(reference.field === "last_price" ? ["last"] : []),
    ...(at ? [`${reference.figure === null ? "tried" : "read"} at ${at}`] : []),
    // a dash says why, as the strip's title does to a pointer: a picture has no pointer
    ...(reference.figure === null && reference.error ? [`(${reference.error})`] : []),
  ].join(" ");
}

/** The readings the strip draws, each with the time it says (none in session): outside it, a
 *  reading with no time is not drawn (below). */
export function drawnReadings(
  references: Reference[], timeOf?: (served: string | null | undefined) => string | null,
): { reference: Reference; at: string | null }[] {
  return references.map((reference) => ({ reference, at: timeOf ? timeOf(reference.fetched_at) : null }))
    .filter((r) => !timeOf || r.at !== null);
}
