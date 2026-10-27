/** moomoo as a Provider (ADR 0015).
 *
 *  Nothing new: it is the OpenD client and the port probe, named and bundled so that the service
 *  above holds one thing rather than two unrelated fields. Everything moomoo-specific — the
 *  websocket port, the key, the TCP probe, the error prose its containment reads — stays below
 *  this line.
 */
import { OpendClient } from "./client.ts";
import { probeOpend } from "./probe.ts";
import type { Settings } from "../env.ts";
import type { ProviderClient } from "../ports.ts";

export function moomooProvider(settings: Settings): ProviderClient {
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
}
