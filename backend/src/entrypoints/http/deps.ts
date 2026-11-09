/** Everything a route needs, in one value (ADR 0009, phase 5).
 *
 *  Passed into each router factory as a closure rather than carried on Hono's context: the context
 *  route requires a generic on every handler and gives `hc` nothing extra, and a closure is
 *  checked at the point of construction instead.
 */
import type { DatabaseSync } from "node:sqlite";

import type { Settings } from "../../env.ts";
import type { ProviderClient, SweeperPort } from "../../ports.ts";
import type { Sources } from "../../references.ts";

export interface Deps {
  settings: Settings;
  db: DatabaseSync;
  /** Injectable so that a test can state the time rather than wait for it. */
  now(): Date;
  /** The id a write mints, injectable for the same reason as `now`: a door scenario (ADR 0021)
   *  records the rows a request wrote, and a random id there could only be scrubbed after the
   *  fact. Absent, as it is in `main.ts`, a write mints a uuid (`db/values.newId`). */
  newId?(): string;
  sweeper: SweeperPort;
  /** Where market data comes from: its name and state for `/health`, and the one bounded call the
   *  creation probes and the live routes make (ADR 0015).
   *
   *  A test must never reach the real SDK, which blocks indefinitely on a dead port so that a
   *  missing fake looks like a hung suite — `harness` supplies a fake Provider. */
  provider: ProviderClient;
  /** Every vendor this build can reach, by name — the Provider among them (ADR 0019).
   *
   *  A Reference is the one figure allowed a source the rest of the service does not use: nothing
   *  alarms on it and nothing is derived from it, so the one-Provider rule does not reach it.
   *  `vendors.openVendors` assembles this, which is also what guarantees the Provider's own
   *  Reference rows are served by the same client the alarms read from.
   *
   *  Includes the Provider rather than being merged with it here. That merge used to happen in
   *  `routes/references.ts` AND in `main.ts`, in two different shapes.
   */
  sources: Sources;
}
