/** Every vendor a Reference can name — the one list, on its own, importable by a page.
 *
 *  It sat in `reference.ts` beside the schema that validates against it, which is where it belongs
 *  by meaning. It is here instead for a mechanical reason: the dashboard renders the "from" box
 *  from this list at RUNTIME, and anything it imports for that comes with whatever that module
 *  imports. `reference.ts` imports zod, so reaching the list through it put zod and every request
 *  schema in the bundle — measured at +26 kB gzipped, 16% of the dashboard, for three strings.
 *  A list of names needs no validator, so the file that holds it has no dependencies at all and
 *  both sides can afford it.
 *
 *  `reference.ts` re-exports it, so nothing that already said `SOURCES` had to learn a second
 *  place to look, and `schemas/index.ts` publishes it for the suites.
 *
 *  The VENDOR outright, never "the Provider": a row meaning "wherever the service is pointed"
 *  would silently show a different company's figure for the same ticker the day
 *  OPTIONALITY_PROVIDER changes, under the same unchanged label (ADR 0019).
 *
 *  Listed here means KNOWN, not available. Whether this build can actually reach one is a
 *  separate question the route answers, the same way `makeProvider` refuses a Provider name it
 *  has no case for rather than booting without market data.
 */
export const SOURCES = ["moomoo", "ibkr", "yahoo"] as const;
/** the union itself, so a form on the other side of `backend/schemas` types its box from this
 *  list rather than spelling the same three names again */
export type Source = (typeof SOURCES)[number];
