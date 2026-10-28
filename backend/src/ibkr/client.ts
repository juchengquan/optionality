/** The IBKR Client Portal client: one bounded batched snapshot per call (ADR 0015).
 *
 *  HTTP and JSON against a gateway running on the owner's own machine, so there is **no
 *  third-party client at all** — decision 02 of the plan, and the reason is not taste: Node runs
 *  this service's TypeScript directly with no build step (ADR 0009), so a client that `tsc`
 *  accepts and Node refuses to load is a real failure mode. `make check-api` exists because two
 *  classes already reached `main` unable to load. `fetch` cannot do that.
 *
 *  ## EXPERIMENTAL — nothing here has met a gateway
 *
 *  Every shape in `types.ts`, every field id in `fields.ts` and every endpoint below is written
 *  from the Web API reference and tested against a stub. What that proves is the shape: how many
 *  calls a sweep costs, that one unknown contract cannot take the watchlist hostage, that a dead
 *  session reads as an outage rather than as a watchlist of unknown contracts. What it cannot
 *  prove, and what PR 6 is for:
 *
 *  1. **Entitlements.** Greeks need the option AND its underlying index — for SPX that is OPRA
 *     plus CBOE Streaming Market Indexes. Five of the owner's nine monitors watch `option_delta`.
 *     If those do not arrive, this Provider is unusable, and the service now SAYS so instead of
 *     logging it: a figure that does not arrive for N sweeps is quarantined with a notice (#167).
 *  2. **The pre-flight.** The reference says the first snapshot returns no data and that
 *     `/iserver/accounts` must precede market data. Both are handled; what a cold sweep really
 *     costs is unmeasured.
 *  3. **Session life.** The gateway needs a browser login. `reachable()` reads
 *     `/iserver/auth/status` rather than a socket, because 2026-10-16 taught this service that a
 *     port which accepts is not a gateway that answers.
 *  4. **TLS.** The gateway serves a self-signed certificate on localhost, which Node's `fetch`
 *     refuses — correctly. The resolution is `NODE_EXTRA_CA_CERTS` pointing at the gateway's own
 *     certificate, NOT disabling verification: this process holds a live Telegram token and a
 *     database of positions. Unverified at the time of writing.
 */
import { ConidCache } from "./conids.ts";
import { type ContractSpec, SNAPSHOT_FIELDS, hasFigures, toRecord } from "./fields.ts";
import type { AuthStatus, SnapshotRow } from "./types.ts";
import type { QuoteBatch, QuoteFetcher, QuoteRecord } from "../quotes.ts";

export interface IbkrConfig {
  /** the gateway's API root, e.g. `https://127.0.0.1:5000/v1/api` */
  baseUrl: string;
  /** Bounds every ask. A gateway can accept a request and never answer it, and an unbounded ask
   *  is what stopped the alarm engine dead on 2026-10-16 on the other provider. Shorter than the
   *  sweep watchdog on purpose: the fetch should fail and be counted, not be abandoned. */
  requestTimeoutMs?: number;
  /** how often to tickle the gateway so its session does not lapse; 0 never does */
  tickleEverySeconds?: number;
  /** how long to wait before asking again for a snapshot that came back with no figures */
  emptyRetryMs?: number;
  /** how many times. Bounded, because a contract with genuinely no data must read as a figure
   *  that did not arrive rather than loop. */
  emptyRetries?: number;
  /** supplied by a test; the real one is the runtime's */
  fetch?: typeof globalThis.fetch;
}

export class IbkrClient {
  private readonly config: IbkrConfig;
  private readonly conids: ConidCache;
  private preflighted: Promise<void> | null = null;
  private keepalive: ReturnType<typeof setInterval> | null = null;

  /** Written out rather than a parameter property: Node only ERASES types, and a parameter
   *  property has to emit code (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX). See opend/client.ts. */
  constructor(config: IbkrConfig) {
    this.config = config;
    this.conids = new ConidCache((path) => this.get(path));
  }

  /** One batch for these codes — the single bounded call the invariant names (CLAUDE.md).
   *
   *  Returns what it got and what it could not resolve, never moomoo's shape of answer and never
   *  a throw for one bad contract (#168). A throw here means the gateway itself could not answer,
   *  which is an outage: `/health` reports it and the top line paints bad.
   */
  async batch(codes: string[]): Promise<QuoteBatch> {
    if (codes.length === 0) return { records: [], unknown: [] };
    await this.preflight();
    const { specs, unknown } = await this.conids.resolve(codes);
    if (specs.length === 0) return { records: [], unknown };
    return { records: await this.snapshot(specs), unknown };
  }

  /** The port the rest of the service takes. */
  asFetcher(): QuoteFetcher {
    return (codes) => this.batch(codes);
  }

  /** Whether the gateway's SESSION is alive, which is not whether its port is open.
   *
   *  `/health` consults this only while nothing has been fetched yet — an answered request
   *  outranks a probe (ADR 0010). Any failure is a no: a health endpoint that raises because the
   *  probe raised tells you less than one that says the Provider is down.
   *
   *  `competing` is deliberately not consulted. It means another session has taken the connection
   *  over, and what that does to market data is one of PR 6's questions; reporting down on it
   *  would be a guess either way, and the next batch answers it for real.
   */
  async reachable(): Promise<boolean> {
    try {
      const status = await this.get<AuthStatus>("/iserver/auth/status");
      return status.authenticated === true && status.connected === true;
    } catch {
      return false;
    }
  }

  /** Stop the keepalive and forget the pre-flight, so the next call does the handshake again.
   *
   *  The conid cache is deliberately KEPT: a conid is a property of the contract, not of the
   *  session, and re-resolving the watchlist would cost a call per contract for nothing.
   */
  close(): void {
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = null;
    this.preflighted = null;
  }

  /** What the reference asks for before market data, once per session.
   *
   *  The secdef search a derivative request also needs is the conid cache's first call, so a cold
   *  sweep pre-flights both without a step that exists only to pre-flight.
   */
  private preflight(): Promise<void> {
    this.preflighted ??= (async () => {
      try {
        await this.get("/iserver/accounts");
      } catch (err) {
        // not remembered: a pre-flight that failed must be retried, or one bad minute would mean
        // a process that never fetches again
        this.preflighted = null;
        throw err;
      }
      this.startKeepalive();
    })();
    return this.preflighted;
  }

  /** One snapshot for every resolved contract, retried while the gateway has nothing at all.
   *
   *  The first request for a conid primes the subscription and comes back with the conid and no
   *  fields. Without the retry every newly watched contract would read as a silent figure for one
   *  sweep. With it, a contract that has genuinely no data — an entitlement the account does not
   *  hold — still reads as a figure that did not arrive, which is the designed answer: counted by
   *  the sweep and quarantined with a notice after N of them (#167), never deleted.
   */
  private async snapshot(specs: ContractSpec[]): Promise<QuoteRecord[]> {
    const conids = specs.map((s) => s.conid).join(",");
    const path = `/iserver/marketdata/snapshot?conids=${conids}&fields=${SNAPSHOT_FIELDS}`;
    const attempts = (this.config.emptyRetries ?? 3) + 1;
    let rows: SnapshotRow[] = [];
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) await sleep(this.config.emptyRetryMs ?? 250);
      const answered = await this.get<SnapshotRow[]>(path);
      rows = Array.isArray(answered) ? answered : [];
      if (rows.some(hasFigures)) break;
    }
    const byConid = new Map<number, SnapshotRow>();
    for (const row of rows) {
      const conid = Number(row.conid);
      if (Number.isFinite(conid)) byConid.set(conid, row);
    }
    const records: QuoteRecord[] = [];
    for (const spec of specs) {
      const row = byConid.get(spec.conid);
      // no row, or a row with nothing on it, is a figure that did not arrive — not a record of
      // undefineds, which would read on the dashboard as a contract that is worth nothing
      if (row && hasFigures(row)) records.push(toRecord(spec, row));
    }
    return records;
  }

  /** The gateway logs a session out for inactivity, and this service asks for data once a minute
   *  at most — less when the market is shut and nothing is watched.
   *
   *  Unref'd so it cannot hold the process open, and it swallows its own failures: a throw from a
   *  timer callback is an unhandled rejection, which `main.ts` treats as fatal. A failed tickle is
   *  not the sweep's business — the next fetch fails visibly and `/health` says so.
   */
  private startKeepalive(): void {
    const seconds = this.config.tickleEverySeconds ?? 60;
    if (seconds <= 0 || this.keepalive) return;
    this.keepalive = setInterval(() => {
      void this.post("/tickle").catch(() => { /* the next fetch is the real answer */ });
    }, seconds * 1000);
    this.keepalive.unref?.();
  }

  private get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  private post<T>(path: string): Promise<T> {
    return this.request<T>("POST", path);
  }

  /** Every call to the gateway, bounded and with its status in the message.
   *
   *  The status is in the message because that is what reaches the log and the degraded Telegram
   *  alert: a 401 is a lapsed browser session and a 503 is a gateway that is starting, and those
   *  need different things done about them.
   */
  private async request<T>(method: "GET" | "POST", path: string): Promise<T> {
    const ms = this.config.requestTimeoutMs ?? 10_000;
    const controller = new AbortController();
    const doFetch = this.config.fetch ?? globalThis.fetch;
    let response: Response;
    try {
      // BOTH: the abort asks the transport to give up, and the race stops this service waiting.
      // They are not the same thing — the request may still be in flight on a connection nobody
      // is listening to any more, which is exactly what opend/client.ts says about its own
      // timeout. Waiting on the abort alone would trust the callee to honour it.
      response = await withTimeout(
        doFetch(`${this.config.baseUrl}${path}`, {
          method, signal: controller.signal, headers: { Accept: "application/json" },
        }),
        ms, `ibkr ${method} ${path}`, () => controller.abort(),
      );
    } catch (err) {
      if (err instanceof Timeout) throw err;
      throw new Error(`ibkr ${method} ${path} failed: ${describe(err)}`);
    }
    if (!response.ok) {
      throw new Error(`ibkr ${method} ${path} failed: HTTP ${response.status}`);
    }
    return await response.json() as T;
  }
}

/** A timeout this service imposed, rather than a failure the gateway reported. Distinguished so
 *  that the message says `timed out` once rather than wrapped in `failed:`. */
class Timeout extends Error {}

/** Stop waiting after `ms`, and ask the transport to give up as well.
 *
 *  Stopping waiting is not cancelling: whatever the abort does or does not do, this service has an
 *  answer at `ms` and the sweep can count a failure. The pattern is opend/client.ts's, which is
 *  there because an unbounded ask stopped the alarm engine dead on 2026-10-16.
 */
function withTimeout<T>(
  work: Promise<T>, ms: number, what: string, giveUp: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // not unref'd either: this one IS awaited, and the whole point of it is to settle
    const timer = setTimeout(() => {
      giveUp();
      reject(new Timeout(`${what} timed out after ${ms}ms`));
    }, ms);
    work.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err: unknown) => { clearTimeout(timer); reject(err); },
    );
  });
}

/** The wait between snapshot attempts.
 *
 *  NOT unref'd, which it was for one commit: an unref'd timer does not hold the event loop open,
 *  so a process whose only pending work was this sleep EXITED in the middle of a batch — node
 *  reports it as "Detected unsettled top-level await" and leaves with code 13. The live service
 *  never showed it because its HTTP server holds the loop open, and no in-process test can show
 *  it because the test runner holds it open too; `client.node.test.ts` spawns a process with
 *  nothing else to do. The rule the timers here follow: unref what nobody is awaiting (the
 *  keepalive interval), never what something is.
 *
 *  Zero is not `setTimeout(…, 0)` either: a test with fake timers would wait for a tick nobody
 *  advances.
 */
function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function describe(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
