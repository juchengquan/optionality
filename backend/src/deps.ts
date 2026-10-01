/** Everything a route needs, in one value (ADR 0009, phase 5).
 *
 *  Passed into each router factory as a closure rather than carried on Hono's context: the context
 *  route requires a generic on every handler and gives `hc` nothing extra, and a closure is
 *  checked at the point of construction instead.
 */
import type { DatabaseSync } from "node:sqlite";

import type { Settings } from "./env.ts";
import type {
  HtmlDocument, OpendProbe, RunFactoryPort, SchedulerPort, SweeperPort, WorkerPort,
} from "./ports.ts";

export interface Deps {
  settings: Settings;
  db: DatabaseSync;
  /** Injectable so that a test can state the time rather than wait for it. */
  now(): Date;
  worker: WorkerPort;
  runs: RunFactoryPort;
  scheduler: SchedulerPort;
  sweeper: SweeperPort;
  opendReachable: OpendProbe;
  htmlDocument: HtmlDocument;
}
