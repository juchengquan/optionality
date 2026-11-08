/** IB Gateway as a Reference source (ADR 0019, track C).
 *
 *  Not a Provider — or not necessarily one. A Reference may be served by a vendor the rest of the
 *  service does not use, because nothing alarms on it and nothing is derived from it, which is the
 *  only reason the one-Provider rule does not reach it. So this is built whether or not
 *  `OPTIONALITY_PROVIDER` says ibkr, and it is the SAME client either way: two connections to one
 *  gateway for the same data, each with its own client id and handshake, is the trap ADR 0019
 *  closed before it existed.
 *
 *  Off unless `IBKR_HOST` is set. A Reference naming `ibkr` with no host configured gets a dash
 *  saying "no ibkr client in this build", which is the honest answer and not a blank.
 */
import { IbkrClient } from "./client.ts";
import type { Settings } from "../env.ts";
import type { Sources } from "../references.ts";

/** The client, held for the life of the process. Null where no host is configured.
 *
 *  Held rather than opened per ask: a handshake and a session start on every dashboard refresh is
 *  5,760 of them a day to read two numbers, which is the waste `opend/client.ts` already rejected
 *  for websockets.
 */
export function ibkrSource(settings: Settings): { sources: Sources; close: () => void } {
  if (!settings.ibkrHost) return { sources: {}, close: () => { /* nothing opened */ } };

  const client = new IbkrClient({
    host: settings.ibkrHost,
    port: settings.ibkrPort,
    clientId: settings.ibkrClientId,
  });
  return {
    sources: { ibkr: (codes) => client.fetchQuotes(codes) },
    close: () => client.close(),
  };
}
