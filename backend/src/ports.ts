/** What the HTTP layer needs from the rest of the service, named as interfaces (ADR 0009, phase 5).
 *
 *  The worker and the scheduler's cron half were here too, until phase 10 retired the run pipeline
 *  (ADR 0014). The routes reach the alarm engine and the vendors through these signatures rather
 *  than importing them, so a test fakes them instead — which is what keeps the rule the harness
 *  exists for: a test must never reach the real moomoo SDK, because it blocks indefinitely on a
 *  dead port and a missing fake looks like a hung suite (CLAUDE.md).
 */
import type { QuoteFetcher } from "optionality/quotes";

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

/** What a Provider last read of the account's quote grade for US options (#464): whether the option
 *  prices it serves are real-time. moomoo grades the ACCOUNT, by level, and never a quote; its
 *  client reads it once per connection episode (and a failed read again at most every 30 minutes)
 *  and keeps it, so asking for this asks OpenD nothing —
 *  `/health` reads it, and must never cause a read. */
export interface QuoteGradeReading {
  /** moomoo's grade as the Python SDK names it (`LV1`, `BMP`, `N/A`, ...), whether that means
   *  real-time (the library's `isRealtime`; null for Unknow), and when it was read. Null while no
   *  read has answered. */
  read: { usOption: string; realtime: boolean | null; at: Date } | null;
  /** OpenD's words for why the latest read failed, or null. A failure leaves `read` as it was. */
  failure: string | null;
}

/** The Provider: the one vendor the alarms read from, chosen before boot (ADR 0015).
 *
 *  `vendors.ts` builds whichever one `.env` names. `name`, `reachable` and `quoteGrade` exist for
 *  `/health`, which until ADR 0015 reported `opend: true` — the vendor's name on the API contract,
 *  and a sentence on the dashboard that would have been a lie the moment anything else was behind
 *  it.
 */
export interface ProviderClient extends VendorClient {
  /** Whether the gateway is there AT ALL, in whatever terms this Provider has — a TCP connect for
   *  moomoo's OpenD, a handshake for IB Gateway's socket.
   *
   *  Consulted only while nothing has been fetched yet: an answered request outranks a probe, and
   *  a socket that accepts is not a gateway that answers (ADR 0010, and 2026-10-16, when OpenD
   *  held the port open and timed out every login). */
  reachable(): Promise<boolean>;
  /** The account's quote grade as last read, or null for a Provider that reports none — IB Gateway
   *  grades each request rather than the account, and that is not this (#464). */
  quoteGrade(): QuoteGradeReading | null;
}

/** A GET of the app's own (ADR 0026): the path, and the caller's Authorization header, passed on so
 *  the one token governs both — answering the status and the body. `app.ts` builds it and hands it
 *  to the MCP door, its whole reach. The method is not a parameter, which is what makes that door
 *  read-only by construction. Here because two surfaces speak it and neither may import the other. */
export type Read = (path: string, authorization: string | null) => Promise<{ status: number; body: string }>;

/** A write of the app's own (ADR 0028): the method, the path, the JSON body, and the caller's
 *  Authorization header passed on as `Read` passes it — answering the status and the body. `app.ts`
 *  builds it as it builds `Read`, and hands both to the MCP door, whose `allowedWrite` (`writes.ts`)
 *  lets through only the method and path pairs `schema/mcp/server.json` lists for a write tool. */
export type Write = (
  method: string, path: string, body: unknown, authorization: string | null,
) => Promise<{ status: number; body: string }>;

/** Telling the owner, as a surface is handed it: `notify.ts`'s `delivery`, which says whether the
 *  message was sent, not sent because Telegram is not configured, or refused — and never throws.
 *  Here because the MCP door may import nothing that runs. */
export type Notify = (text: string) => Promise<"sent" | "unconfigured" | "failed">;
