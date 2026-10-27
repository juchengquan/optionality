/** IBKR as a Provider (ADR 0015).
 *
 *  The same three answers moomoo gives — a name, the one bounded fetch, and whether the gateway is
 *  there — behind the same interface, so nothing above the seam can tell which is configured. That
 *  is the whole point of PR 4 having gone first.
 *
 *  It warns on the way up because it has never met a gateway: every field id and every endpoint is
 *  read from the reference and proved against a stub (client.ts says what that does and does not
 *  prove). The warning is in the boot log rather than a comment because the owner reads one of
 *  those and not the other.
 */
import { IbkrClient } from "./client.ts";
import type { Settings } from "../env.ts";
import type { ProviderClient } from "../ports.ts";

export function ibkrProvider(settings: Settings): ProviderClient {
  const client = new IbkrClient({ baseUrl: settings.ibkrGatewayUrl });
  console.warn(
    `ibkr: EXPERIMENTAL — no deployment has run against a gateway yet. `
    + `Greeks need OPRA AND the index feed; a figure that does not arrive is quarantined with a `
    + `notice after ${settings.quarantineAfterSilentSweeps} sweeps, not silently skipped.`,
  );
  return {
    name: "ibkr",
    fetchQuotes: client.asFetcher(),
    // the SESSION, not the port: a gateway process with a dead browser login accepts connections
    // and answers nothing (client.ts, and 2026-10-16 on the other provider)
    reachable: () => client.reachable(),
    close: () => client.close(),
  };
}
