/** What the API accepts for a Reference (ADR 0018).
 *
 *  A RAW code, not an expiry/type/strike: `buildSpxCode` writes `US.SPXW` + six digits + C/P +
 *  strike×1000 and cannot spell `US.SPY` at all, and a Reference is a Security rather than a
 *  Contract — anything a Provider can quote, named by a code. Allowing an option through costs
 *  nothing on the way in and gives, free, the ability to watch a strike with no rule on it.
 *
 *  Optional fields are `.optional()` with their meaning applied where the value is used, as every
 *  other schema here is — see validate.ts for why that is forced by how `hc` types a request.
 */
import { z } from "zod";

/** Trimmed and upper-cased: every code in this service is upper-case — `buildSpxCode` writes them
 *  that way and moomoo's own `stock_owner` hands them back that way — so `us.spy` typed into a box
 *  is the same Security and must not become a second row the live probe then refuses. */
const Code = z.string().trim().min(1).transform((c) => c.toUpperCase());

/** What to multiply the figure by. SPY quotes at 758.73 against strikes of 6950, so SPX is read
 *  through SPY ×10 — and the strip shows that arithmetic rather than charging a mental ×10 at
 *  every glance.
 *
 *  Positive and finite. Zero would make every figure 0, which prints as a price; a negative one
 *  would invert the market. Both are refused at the door rather than left for the domain, which
 *  takes the scale as given. */
const Scale = z.number().positive().finite();

export const ReferenceIn = z.object({
  code: Code,
  /** what to call it, or absent for "the code is its own name". The label is the only place that
   *  says SPX at all, and it never claims to BE the index: SPY×10 has tracking error, it has
   *  dividends, and the two trade different sessions. */
  label: z.string().trim().min(1).optional(),
  scale: Scale.optional(),
});
