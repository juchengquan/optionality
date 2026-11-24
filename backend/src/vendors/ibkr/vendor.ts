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
import type { AccountSource, AccountWatch } from "../../ports.ts";
import type { ProviderVendor } from "../index.ts";

/** What the account's source needs of the library's client: its watch (#476). */
interface Watching {
  watchAccount(wanted?: string): Promise<AccountWatch>;
}

/** The account's watch over `client` (ADR 0031, #477), every way a start ends sorted for the route:
 *  the library's `IbkrUnreachable` — no session at all, in the connect's own words — apart from a
 *  start that failed once it began (a plain `Error`: its deadline, or its connection closing under
 *  it) and from `IbkrAccountRefused`. One connect, made by `watchAccount` itself, so the words of a
 *  refused session reach the route rather than a probe's yes or no.
 *
 *  `answered` is the descriptor's to call each time the client answers anything else — a price
 *  read that worked, a handshake for `/health` — which tells the hold that a lost connection is
 *  back. A listener's failure is logged and never fails the read that called it. */
export function accountSource(client: Watching): { source: AccountSource; answered: () => void } {
  const listeners: (() => void)[] = [];
  return {
    source: {
      async watch(wanted) {
        try {
          return { watch: await client.watchAccount(wanted ?? undefined) };
        } catch (err) {
          const words = err instanceof Error ? err.message : String(err);
          if (err instanceof IbkrUnreachable) return { unreachable: words };
          return err instanceof IbkrAccountRefused ? { refused: words } : { failed: words };
        }
      },
      onAnswered(listener) {
        listeners.push(listener);
      },
    },
    answered() {
      for (const listener of listeners) {
        try {
          listener();
        } catch (err) {
          console.error(`IBKR account: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    },
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
    // TEMPORARY SEAM until #476 is merged in: the library's client then has `watchAccount`
    const account = accountSource(client as unknown as Watching);
    // A plain object of closures, as moomoo's descriptor hands back, and never the instance:
    // `main.ts` and every route pass `provider.fetchQuotes` on DETACHED, and a class method
    // extracted from its instance has no `this` — every ask then failed with "this.close is not a
    // function" from inside the client. `openVendors` already wraps the sources for the same
    // reason; the Provider is handed on by more hands than that one.
    return {
      name: client.name,
      // each answer a chance for a lost account watch to come back (ADR 0031): an empty ask
      // connects nothing, so it says nothing
      fetchQuotes: async (codes) => {
        const batch = await client.fetchQuotes(codes);
        if (codes.length > 0) account.answered();
        return batch;
      },
      reachable: async () => {
        const up = await client.reachable();
        if (up) account.answered();
        return up;
      },
      // IB Gateway grades each REQUEST, which a Reference row carries as `delayed`; it states no
      // grade for the account, and passing a request's through as one is out of scope (#464)
      quoteGrade: () => null,
      close: () => client.close(),
      // over the same client, so the account is held on the session the prices are read on
      account: account.source,
    };
  },
};
