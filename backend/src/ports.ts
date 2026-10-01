/** What the HTTP layer needs from the rest of the service, named as interfaces (ADR 0009, phase 5).
 *
 *  The worker, the scheduler and the sweeper arrive in phase 6; the Telegram bot in phase 7. The
 *  routes need them now, so they are ports with fakes in the tests — which is how the Python's own
 *  route tests work: `client_factory` injects an echo `snapshot_fetcher` so that a test can never
 *  reach the real moomoo SDK, because it blocks indefinitely on a dead port and a missing fake
 *  looks like a hung suite (CLAUDE.md).
 *
 *  Keeping them as interfaces rather than concrete imports is also what lets phase 6 be a phase:
 *  the real implementations drop in behind these signatures without touching a route.
 */
import type { TaskType } from "./schemas/config-body.ts";

/** THE single job thread. One worker owns run execution (CLAUDE.md). */
export interface WorkerPort {
  /** How many runs are waiting, for /health. */
  queueDepth(): number;
  /** Hand a created run to the queue. */
  submit(runId: string): void;
}

export interface CreateRunArgs {
  taskType: TaskType;
  configName: string;
  /** "schedule" | "api" */
  trigger: string;
  notify: boolean;
}

/** Creating the run row. Separate from the worker because a schedule creates runs too, and in
 *  phase 6 that happens on a different thread from any request. */
export interface RunFactoryPort {
  createRun(args: CreateRunArgs): string;
}

/** The cron schedule. `refreshJobs` must only touch `schedule-*` job ids (CLAUDE.md). */
export interface SchedulerPort {
  /** Rebuild the schedule from the database, after a schedule row changes. */
  refreshJobs(): void;
}

/** The alarm engine's account of its own health, as /health reports it. */
export interface SweeperPort {
  lastSweepAt(): Date | null;
  lastSweepOk(): boolean;
  consecutiveFailures(): number;
  /** The human label the status strip shows, and whether it is bad. Derived here rather than
   *  client-side so the engine gives its own account (see health.py). */
  alarmState(): { label: string; bad: boolean };
  lastFetchAt(): Date | null;
}

/** Whether OpenD is listening. A TCP connect in the Python; anything that answers the question
 *  will do, and /health must report rather than raise. */
export type OpendProbe = (host: string, port: number) => Promise<boolean>;

/** Wrapping a report's stored HTML into a document. Ported with the notifications in phase 7;
 *  until then the route needs only the shape. */
export type HtmlDocument = (body: string) => string;
