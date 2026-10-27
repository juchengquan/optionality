/** What the HTTP layer needs from the rest of the service, named as interfaces (ADR 0009, phase 5).
 *
 *  The worker and the scheduler's cron half were here too, until phase 10 retired the run pipeline
 *  (ADR 0014). The sweeper arrived in phase 6; the Telegram bot in phase 7. The
 *  routes need them now, so they are ports with fakes in the tests — which is how the Python's own
 *  route tests work: `client_factory` injects an echo `snapshot_fetcher` so that a test can never
 *  reach the real moomoo SDK, because it blocks indefinitely on a dead port and a missing fake
 *  looks like a hung suite (CLAUDE.md).
 *
 *  Keeping them as interfaces rather than concrete imports is also what lets phase 6 be a phase:
 *  the real implementations drop in behind these signatures without touching a route.
 */
import type { QuoteFetcher } from "./quotes.ts";

/** The alarm engine's account of its own health, as /health reports it. */
export interface SweeperPort {
  lastSweepAt(): Date | null;
  lastSweepOk(): boolean;
  consecutiveFailures(): number;
  /** The human label the status strip shows, and whether it is bad. Derived here rather than
   *  client-side so the engine gives its own account (see health.py). */
  alarmState(): { label: string; bad: boolean };
  lastFetchAt(): Date | null;
  /** What the last batch did, or null before one was asked for. /health reports this instead of a
   *  port probe: a socket that accepts is not a gateway that answers. */
  lastFetchOk(): boolean | null;
}

/** A Provider: one configured source of market data, chosen before boot (ADR 0015).
 *
 *  `provider.ts` builds whichever one `.env` names. `name` and `reachable` exist for `/health`,
 *  which until now reported `opend: true` — the vendor's name on the API contract, and a sentence
 *  on the dashboard that would have been a lie the moment anything else was behind it.
 */
export interface ProviderClient {
  /** What this Provider is called, as `/health` reports it and the dashboard prints it. */
  readonly name: string;
  /** The one question a Provider answers (quotes.ts). */
  readonly fetchQuotes: QuoteFetcher;
  /** Whether the gateway is there AT ALL, in whatever terms this Provider has — a TCP connect for
   *  moomoo's OpenD, something else for a Provider that speaks HTTP.
   *
   *  Consulted only while nothing has been fetched yet: an answered request outranks a probe, and
   *  a socket that accepts is not a gateway that answers (ADR 0010, and 2026-10-16, when OpenD
   *  held the port open and timed out every login). */
  reachable(): Promise<boolean>;
  /** Hang up, so the next call reconnects. Called on the way out of the process. */
  close(): void;
}
