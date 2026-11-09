/** Yahoo as a vendor (ADR 0019, track D).
 *
 *  Reference-only, and that is a statement about what it can price rather than about trust: it
 *  quotes index levels and no option, so nothing the alarm engine evaluates could be read from it.
 *  `canBeProvider: false` is therefore what keeps `OPTIONALITY_PROVIDER=yahoo` fatal at boot
 *  instead of producing a watchlist of dashes, and it is why this client owes no `reachable` —
 *  that question is only ever asked of the Provider.
 *
 *  It needs no configuration: no host, no key, no login. So it is always available and costs
 *  nothing until a Reference names it — one bounded call per source IN USE. Deleting the row is
 *  the off switch; a setting would be a second thing to remember.
 *
 *  Nothing to hang up either. The library holds a cookie jar rather than a socket, and it is
 *  loaded lazily on the first call that needs it (`client.ts`), so a build with no Yahoo
 *  Reference never imports it at all.
 */
import { yahooFetcher } from "./client.ts";
import type { ReferenceVendor } from "../index.ts";

export const yahooVendor: ReferenceVendor = {
  name: "yahoo",
  canBeProvider: false,
  open: () => ({
    name: "yahoo",
    fetchQuotes: yahooFetcher(),
    close: () => { /* a cookie jar, not a socket */ },
  }),
};
