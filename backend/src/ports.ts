/** What the HTTP layer needs from the rest of the service, named as interfaces (ADR 0009, phase 5).
 *
 *  The worker and the scheduler's cron half were here too, until phase 10 retired the run pipeline
 *  (ADR 0014). The routes reach the alarm engine and the vendors through these signatures rather
 *  than importing them, so a test fakes them instead — which is what keeps the rule the harness
 *  exists for: a test must never reach the real moomoo SDK, because it blocks indefinitely on a
 *  dead port and a missing fake looks like a hung suite (CLAUDE.md).
 */
import type { QuoteFetcher } from "./quotes.ts";

/** The alarm engine's account of its own health, as /health reports it.
 *
 *  `SweepHealth` in `health.ts` is the implementation, and this is its whole surface — which is
 *  what made splitting it out of `MonitorSweeper` free: the seam had been drawn here since phase 5
 *  and the engine had simply grown through it. `main.ts` hands the routes and the bot that object
 *  rather than the sweeper, so nothing reachable from a request can start a sweep. */
export interface SweeperPort {
  lastSweepAt(): Date | null;
  lastSweepOk(): boolean;
  consecutiveFailures(): number;
  /** The human label the status strip shows, and whether it is bad. Derived here rather than
   *  client-side so the engine gives its own account. */
  alarmState(): { label: string; bad: boolean };
  lastFetchAt(): Date | null;
  /** What the last batch did, or null before one was asked for. /health reports this instead of a
   *  port probe: a socket that accepts is not a gateway that answers. */
  lastFetchOk(): boolean | null;
}

/** An open vendor: one market-data vendor this build can reach (ADR 0015, widened by 0019).
 *
 *  Every vendor answers this much, whether it is the Provider or only serves a Reference —
 *  `vendors.ts` opens them all the same way, and one shutdown loop hangs them all up. What a
 *  Reference-only vendor does NOT have to answer is `reachable`: that question is asked of the
 *  Provider alone (see below), and a vendor with no gateway to probe would have to invent one.
 */
export interface VendorClient {
  /** What this vendor is called, as a Reference's `source` names it and `/health` prints it. */
  readonly name: string;
  /** The one question every vendor answers (quotes.ts). */
  readonly fetchQuotes: QuoteFetcher;
  /** Hang up, so the next call reconnects. Called on the way out of the process. */
  close(): void;
}

/** The Provider: the one vendor the alarms read from, chosen before boot (ADR 0015).
 *
 *  `vendors.ts` builds whichever one `.env` names. `name` and `reachable` exist for `/health`,
 *  which until ADR 0015 reported `opend: true` — the vendor's name on the API contract, and a
 *  sentence on the dashboard that would have been a lie the moment anything else was behind it.
 */
export interface ProviderClient extends VendorClient {
  /** Whether the gateway is there AT ALL, in whatever terms this Provider has — a TCP connect for
   *  moomoo's OpenD, a handshake for IB Gateway's socket.
   *
   *  Consulted only while nothing has been fetched yet: an answered request outranks a probe, and
   *  a socket that accepts is not a gateway that answers (ADR 0010, and 2026-10-16, when OpenD
   *  held the port open and timed out every login). */
  reachable(): Promise<boolean>;
}
