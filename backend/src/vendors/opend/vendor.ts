/** moomoo as a vendor (ADR 0015, registered by `vendors.ts` since ADR 0019).
 *
 *  Nothing new: it is the OpenD client and the port probe, named and bundled so that the service
 *  above holds one thing rather than two unrelated fields. Everything moomoo-specific — the
 *  websocket port, the key, the TCP probe, the error prose its containment reads — stays below
 *  this line.
 *
 *  It needs no configuration gate. OpenD's host and port have defaults that are right on this
 *  machine, and a key that is blank is a login moomoo refuses rather than a vendor that is
 *  absent — which the sweep reports and quarantine never acts on, because an unreachable Provider
 *  says nothing about whether a rule is evaluable.
 */
import { OpendClient } from "./client.ts";
import { probeOpend } from "./probe.ts";
import type { Settings } from "../../env.ts";
import type { ProviderVendor } from "../index.ts";

export const moomooVendor: ProviderVendor = {
  name: "moomoo",
  canBeProvider: true,
  open(settings: Settings) {
    const client = new OpendClient({
      host: settings.opendHost,
      port: settings.moomooWsPort,
      key: settings.moomooWsKey,
    });
    return {
      name: "moomoo",
      fetchQuotes: client.asFetcher(),
      // the WEBSOCKET port, which is the one this client speaks and not the TCP one the Python used
      reachable: () => probeOpend(settings.opendHost, settings.moomooWsPort),
      close: () => client.close(),
    };
  },
};
