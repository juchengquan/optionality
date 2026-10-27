/** The Provider seam: one source of market data, chosen before boot (ADR 0015).
 *
 *  A Provider is anything that can answer `QuoteFetcher` for this service's Contracts. There is
 *  one per deployment, named in `.env` and read once at boot like every other knob — not two at
 *  once, which would double the entitlements and raise a question with no good answer: when they
 *  disagree about delta, which one does the alarm fire on?
 *
 *  The interface itself is in `ports.ts`, with the other things the HTTP layer needs named as
 *  interfaces — and deliberately NOT here, because this module imports a vendor client. `deps.ts`
 *  reaches the frontend's type graph through `AppType`, so an interface declared beside the
 *  factory would pull the moomoo SDK into the dashboard's typecheck (it did, for one commit).
 *
 *  What is NOT here: anything about the fields a Provider supplies. That depends on the account it
 *  speaks for rather than on its code, so it is observed and never declared — a silent figure is
 *  found by the sweep and quarantined (ADR 0015, #167).
 */
import type { Settings } from "./env.ts";
import { moomooProvider } from "./opend/provider.ts";
import type { ProviderClient } from "./ports.ts";

/** Every Provider this build can be pointed at. The switch below must have a case for each, and
 *  `/health` reports whichever one answered. */
export const PROVIDERS = ["moomoo"] as const;
export type ProviderName = (typeof PROVIDERS)[number];

/** The Provider this deployment names, or a fatal error.
 *
 *  Fatal on purpose, like every other mistyped setting (env.ts): a service that starts with no
 *  Provider has no market data, no alarms and a dashboard full of dashes, which is worse than one
 *  that does not start. launchd keeps trying and the log says the name it did not know.
 */
export function makeProvider(settings: Settings): ProviderClient {
  switch (settings.provider) {
    case "moomoo":
      return moomooProvider(settings);
    default:
      throw new Error(
        `OPTIONALITY_PROVIDER: unknown provider '${settings.provider}' `
        + `(known: ${PROVIDERS.join(", ")})`,
      );
  }
}
