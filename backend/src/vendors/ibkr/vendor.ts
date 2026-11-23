/** IB Gateway as a vendor (ADR 0019, track C).
 *
 *  Reached as a Reference source whether or not it is the Provider, because a Reference alarms on
 *  nothing and nothing is derived from one — the only reason the one-Provider rule does not reach
 *  it. `canBeProvider` is true because this client can answer everything a Provider must: whether
 *  this deployment SHOULD read its alarms from IBKR is `OPTIONALITY_PROVIDER`'s answer, not this
 *  file's.
 *
 *  One client either way. Two connections to one gateway for the same data, each with its own
 *  client id and handshake, is the trap ADR 0019 closed before it existed — and IB Gateway allows
 *  one connection per client id, so the second would displace the first in silence. `vendors.ts`
 *  opens each vendor once and shares it, which is what makes that structural rather than
 *  remembered.
 *
 *  Off unless `IBKR_HOST` is set: `open` answers null, a Reference naming `ibkr` gets a dash
 *  saying "no ibkr client in this build", and naming it as the Provider is fatal at boot.
 */
import { IbkrAccountRefused, IbkrClient, IbkrUnreachable } from "optionality/vendors/ibkr/client";
import type { Settings } from "../../env.ts";
import type { ReadAccount } from "../../ports.ts";
import type { ProviderVendor } from "../index.ts";

/** The account's one read over `client` (ADR 0030, #470), every way it ends sorted for the route:
 *  the library's `IbkrUnreachable` — no session at all, in the connect's own words — apart from a
 *  read that failed once it began (a plain `Error`: its deadline, or its connection closing under
 *  it) and from `IbkrAccountRefused`. One connect, made by `account` itself, so the words of a
 *  refused session reach the route rather than a probe's yes or no. */
export function accountReader(client: IbkrClient): ReadAccount {
  return async (wanted) => {
    try {
      return { account: await client.account(wanted ?? undefined) };
    } catch (err) {
      const words = err instanceof Error ? err.message : String(err);
      if (err instanceof IbkrUnreachable) return { unreachable: words };
      return err instanceof IbkrAccountRefused ? { refused: words } : { failed: words };
    }
  };
}

export const ibkrVendor: ProviderVendor = {
  name: "ibkr",
  canBeProvider: true,
  /** Why `IBKR_HOST`: the gateway runs wherever the owner logs in, and there is no default worth
   *  guessing — 4001 vs 4002 already depends on whether that login is live or paper. */
  configuredBy: "IBKR_HOST",
  open(settings: Settings) {
    if (!settings.ibkrHost) return null;
    // Held for the life of the process, not opened per ask: a handshake and a session start on
    // every dashboard refresh is 5,760 of them a day to read two numbers, which is the waste
    // `opend/client.ts` already rejected for websockets.
    const client = new IbkrClient({
      host: settings.ibkrHost,
      port: settings.ibkrPort,
      clientId: settings.ibkrClientId,
    });
    // A plain object of closures, as moomoo's descriptor hands back, and never the instance:
    // `main.ts` and every route pass `provider.fetchQuotes` on DETACHED, and a class method
    // extracted from its instance has no `this` — every ask then failed with "this.close is not a
    // function" from inside the client. `openVendors` already wraps the sources for the same
    // reason; the Provider is handed on by more hands than that one.
    return {
      name: client.name,
      fetchQuotes: (codes) => client.fetchQuotes(codes),
      reachable: () => client.reachable(),
      // IB Gateway grades each REQUEST, which a Reference row carries as `delayed`; it states no
      // grade for the account, and passing a request's through as one is out of scope (#464)
      quoteGrade: () => null,
      close: () => client.close(),
      // over the same client, so the account is read on the session the prices are
      readAccount: accountReader(client),
    };
  },
};
