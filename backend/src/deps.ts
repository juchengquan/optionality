/** Everything a route needs, in one value (ADR 0009, phase 5).
 *
 *  Passed into each router factory as a closure rather than carried on Hono's context: the context
 *  route requires a generic on every handler and gives `hc` nothing extra, and a closure is
 *  checked at the point of construction instead.
 */
import type { DatabaseSync } from "node:sqlite";

import type { Settings } from "./env.ts";
import type { ProviderClient, SweeperPort } from "./ports.ts";
import type { Sources } from "./references.ts";

export interface Deps {
  settings: Settings;
  db: DatabaseSync;
  /** Injectable so that a test can state the time rather than wait for it. */
  now(): Date;
  sweeper: SweeperPort;
  /** Where market data comes from: its name and state for `/health`, and the one bounded call the
   *  creation probes and the live routes make (ADR 0015).
   *
   *  A test must never reach the real SDK, which blocks indefinitely on a dead port so that a
   *  missing fake looks like a hung suite — `harness` supplies a fake Provider. */
  provider: ProviderClient;
  /** Vendors a Reference may name beyond the Provider, by name (ADR 0019).
   *
   *  Separate from `provider` because a Reference is the one figure allowed a source the rest of
   *  the service does not use: nothing alarms on it and nothing derives from it, so the
   *  one-Provider rule does not reach it. The Provider is always available as a source under its
   *  own name; this is what else is reachable, and `references.ts` merges the two.
   *
   *  Empty today. ADR 0019's track C puts IBKR here whether or not it is the Provider.
   */
  referenceSources?: Sources;
}
