/** What the API accepts for a Reference (ADR 0018, amended by 0019).
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

/** Every vendor a Reference can name. The VENDOR outright, never "the Provider": a row meaning
 *  "wherever the service is pointed" would silently show a different company's figure for the
 *  same ticker the day OPTIONALITY_PROVIDER changes, under the same unchanged label (ADR 0019).
 *
 *  Listed here means KNOWN, not available. Whether this build can actually reach one is a
 *  separate question the route answers, the same way `makeProvider` refuses a Provider name it
 *  has no case for rather than booting without market data.
 */
export const SOURCES = ["moomoo", "ibkr", "yahoo"] as const;

export const ReferenceIn = z.object({
  code: Code,
  /** what to call it, or absent for "the code is its own name". More useful since the scale went:
   *  `^GSPC`, `US..SPX` and `SPX` are three vendors' names for one index, and none of them is
   *  what the owner calls it. */
  label: z.string().trim().min(1).optional(),
  /** required, because a Reference whose vendor is unknown cannot be fetched at all. `scale` was
   *  here until ADR 0019: it existed for SPY×10 standing in for SPX, and a scaled stand-in is a
   *  simulation rather than a reading. */
  source: z.enum(SOURCES),
});
