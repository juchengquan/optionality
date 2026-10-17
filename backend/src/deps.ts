/** Everything a route needs, in one value (ADR 0009, phase 5).
 *
 *  Passed into each router factory as a closure rather than carried on Hono's context: the context
 *  route requires a generic on every handler and gives `hc` nothing extra, and a closure is
 *  checked at the point of construction instead.
 */
import type { DatabaseSync } from "node:sqlite";

import type { Settings } from "./env.ts";
import type { OpendProbe, SweeperPort } from "./ports.ts";
import type { QuoteFetcher } from "./quotes.ts";

export interface Deps {
  settings: Settings;
  db: DatabaseSync;
  /** Injectable so that a test can state the time rather than wait for it. */
  now(): Date;
  sweeper: SweeperPort;
  opendReachable: OpendProbe;
  /** One bounded OpenD call, for the creation probes and the live routes. A test must never reach
   *  the real SDK, which blocks indefinitely on a dead port so that a missing fake looks like a
   *  hung suite. */
  fetchQuotes: QuoteFetcher;
}
