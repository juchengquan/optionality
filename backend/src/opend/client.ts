/** The OpenD client: one bounded batched snapshot call (ADR 0009, phase 6).
 *
 *  WebSocket, because the npm package speaks nothing else — the Python SDK's TCP protocol has no
 *  JavaScript implementation. Phase 0 compared the two transports field by field for the same
 *  contract within one second and found 0 of 56 fields differing, which is what made this a port
 *  rather than a rewrite of the data source.
 *
 *  ## The connection is kept, where the Python's is not
 *
 *  `fetch_snapshot` opens a client, asks, and closes, every time. Over TCP that is cheap. Over
 *  WebSocket it is a handshake and a keyed login per sweep — once a minute, for ever. So this holds
 *  the connection and tears it down on ANY failure, so the next call reconnects. That keeps the
 *  property the per-call version got for free: a socket that has quietly died produces a failed
 *  sweep and a visible `last_sweep_ok: false`, not a silent stream of empty batches.
 */
import type { MoomooClient, Security, Snapshot } from "./types.ts";
import { toRecords } from "./snapshot.ts";
import type { QuoteBatch, QuoteFetcher } from "../quotes.ts";

/** Market 11 is the US. See snapshot.ts — the service deals in no other. */
const US_MARKET = 11;

export interface OpendConfig {
  host: string;
  /** the WEBSOCKET port, which is not the TCP one the Python uses */
  port: number;
  /** OpenD's websocket key, in plaintext; the library hashes it */
  key: string;
  loginTimeoutMs?: number;
  /** Bounds the ASK, where loginTimeoutMs bounds the handshake. A logged-in OpenD can accept a
   *  request and never answer it, and the library's promise then never settles — which stopped the
   *  alarm engine dead on 2026-10-16. Shorter than the sweep watchdog on purpose: the fetch should
   *  fail and be counted, not be abandoned by the loop. */
  requestTimeoutMs?: number;
  /** supplied by a test; the real one is the npm package's default export */
  create?: () => MoomooClient;
}

/** Stop waiting, which is NOT the same as cancelling: the request may still be in flight on a
 *  socket nobody is listening to any more. That is why every caller of this closes the connection,
 *  so the next call starts a new one rather than inheriting a queue it cannot see.
 */
function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`OpenD ${what} timed out after ${ms}ms`)),
      ms,
    );
    work.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err: unknown) => {
        clearTimeout(timer);
        // `describe`, not String(): the library rejects with a plain `{retType, retMsg, errCode}`,
        // and String() of that is "[object Object]" — which threw moomoo's own sentence away and
        // took the containment below with it (#175).
        reject(err instanceof Error ? err : new Error(describe(err)));
      },
    );
  });
}

/** `US.SPXW261030C8100000` as moomoo wants it, and back again. */
function toSecurity(code: string): Security {
  const bare = code.startsWith("US.") ? code.slice(3) : code;
  return { market: US_MARKET, code: bare };
}

export class OpendClient {
  /** The logged-in client, or null when the next call must log in again. */
  private client: MoomooClient | null = null;
  /** The client OBJECT, kept for the life of the process even while `client` is null.
   *
   *  Calling `start()` again on the same object makes the library close the previous socket itself.
   *  Building a fresh object instead orphans the old one: `stop()` does not close anything, and the
   *  base class re-opens that orphan every 1000ms for ever. Measured on 2026-10-16, after an OpenD
   *  outage: 37 ESTABLISHED connections from one process and 10,794 login/disconnect cycles.
   */
  private instance: MoomooClient | null = null;
  private connecting: Promise<MoomooClient> | null = null;

  /** Written out rather than a `constructor(private readonly deps: ...)` parameter property.
   *  Node runs this file by ERASING types, and a parameter property is syntax that has to EMIT code —
   *  so it is rejected outright at load time (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX). tsc accepts it and
   *  vitest transforms it, which is how two of these reached main unable to run (see check-api). */
  private readonly config: OpendConfig;

  constructor(config: OpendConfig) {
    this.config = config;
  }

  private async connect(): Promise<MoomooClient> {
    if (this.client) return this.client;
    // one handshake even if several callers arrive together: the sweep and a creation probe can
    // overlap, and two logins on one key is a way to be disconnected
    this.connecting ??= this.login();
    try {
      this.client = await this.connecting;
      return this.client;
    } finally {
      this.connecting = null;
    }
  }

  private async login(): Promise<MoomooClient> {
    const { host, port, key, loginTimeoutMs = 8000 } = this.config;
    if (!key) throw new Error("OpenD websocket key is not configured");
    const create = this.config.create ?? (await defaultFactory());
    this.instance ??= create();
    const client = this.instance;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`OpenD login timed out after ${loginTimeoutMs}ms`)),
        loginTimeoutMs,
      );
      client.onlogin = (ok, msg) => {
        clearTimeout(timer);
        if (ok) resolve();
        else reject(new Error(`OpenD login refused: ${describe(msg)}`));
      };
      try {
        client.start(host, port, false, key);
      } catch (err) {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    return client;
  }

  /** Hang up, so the next call logs in again.
   *
   *  Both halves matter and neither is interchangeable: `stop()` unregisters the push callback,
   *  `websock.close()` is what actually closes the socket, kills the library's reconnect timer and
   *  rejects any request still outstanding. The object itself is kept — see `instance`.
   */
  close(): void {
    const client = this.client ?? this.instance;
    try {
      client?.stop();
      client?.websock?.close();
    } catch {
      /* already gone */
    }
    this.client = null;
  }

  /** One batched snapshot for these codes — the single bounded call the invariant names.
   *
   *  Throws for everything, including an unknown contract: the error text is moomoo's and `batch`
   *  below is what reads it. The Python's "snapshot API failed: ..." prefix is kept.
   */
  async snapshot(codes: string[]): Promise<ReturnType<typeof toRecords>> {
    if (codes.length === 0) return [];
    let response;
    try {
      const client = await this.connect();
      response = await withTimeout(
        client.GetSecuritySnapshot({ c2s: { securityList: codes.map(toSecurity) } }),
        this.config.requestTimeoutMs ?? 10_000,
        "request",
      );
    } catch (err) {
      // any failure, including a dropped socket, costs the connection
      this.close();
      throw new Error(`snapshot API failed: ${describe(err)}`);
    }
    if (response.retType !== 0) {
      throw new Error(`snapshot API failed: ${response.retMsg ?? `retType ${response.retType}`}`);
    }
    const list: Snapshot[] = response.s2c?.snapshotList ?? [];
    return toRecords(list);
  }

  /** A batch that survives a contract moomoo has never heard of.
   *
   *  moomoo rejects the WHOLE batch when any code is unknown, naming the culprit in its error
   *  text; this drops it and retries, so one bad contract cannot take the watchlist hostage. Any
   *  other error — connection, quota — is re-thrown untouched: containment engages only on the
   *  deterministic named-culprit case, because retrying a connection failure one code at a time
   *  would present an outage as a watchlist full of unknown contracts.
   *
   *  This loop used to live above the port, in `fetchResilient`, which meant the service itself
   *  read moomoo's error prose. It is moomoo's grammar, so it is moomoo's business: the port now
   *  carries the ANSWER — which codes could not be priced — and a second Provider reports its own
   *  failures in its own terms (ADR 0015, #168).
   */
  async batch(codes: string[]): Promise<QuoteBatch> {
    let remaining = [...codes];
    const unknown: string[] = [];
    while (remaining.length > 0) {
      try {
        return { records: await this.snapshot(remaining), unknown };
      } catch (err) {
        const match = UNKNOWN_CODE.exec(err instanceof Error ? err.message : String(err));
        if (!match) throw err;
        const culprit = match[1]!.replace(/\.+$/, "");
        // moomoo may name the code with or without its market prefix, and everything downstream
        // is keyed by ours
        const hits = remaining.filter((c) => c === culprit || c.endsWith(culprit));
        if (hits.length === 0) throw err; // cannot map the culprit to a code we asked for
        remaining = remaining.filter((c) => !hits.includes(c));
        unknown.push(...hits);
      }
    }
    return { records: [], unknown };
  }

  /** The port the rest of the service takes. */
  asFetcher(): QuoteFetcher {
    return (codes) => this.batch(codes);
  }
}

/** moomoo names the offending contract in the error text, which is what makes containment safe. */
const UNKNOWN_CODE = /Unknown stock\.?\s+([A-Z0-9.]+)/;

/** Whatever the library handed us, as a sentence.
 *
 *  The shape that matters is its own: `GetSecuritySnapshot` does not resolve a bad `retType`, it
 *  REJECTS with `{retType, retMsg, errCode}` — a plain object, not an Error. Measured against the
 *  live gateway on 2026-10-28: asking for `.SPX` gave `{"retType":-1,"retMsg":"US stock indices
 *  are not supported","errCode":0}`, and asking for a contract that does not exist gave
 *  `Unknown stock. <code>`. Both arrived at the service as `[object Object]`, so moomoo's sentence
 *  never reached a log, a Telegram alert — or `UNKNOWN_CODE`, which is what made containment a
 *  thing that worked only against tests (#175).
 *
 *  `retMsg` is preferred over the whole object because it is the sentence a human needs and the
 *  one the regex reads. `errCode` is appended only when the message does not already carry it,
 *  the same rule the IBKR client's `describeFetchError` follows for an errno. Anything else — no
 *  message, an empty one, a shape nobody has seen — falls through to the whole object, which is
 *  never empty and never loses what arrived. A `retType`-only branch was written and then deleted:
 *  a sweep showed that `{"retType":-1}` already says it, so the branch only duplicated the
 *  fallback.
 */
function describe(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object") {
    const { retMsg, errCode } = value as { retMsg?: unknown; errCode?: unknown };
    if (typeof retMsg === "string" && retMsg !== "") {
      const code = typeof errCode === "number" && errCode !== 0 && !retMsg.includes(String(errCode))
        ? ` (errCode ${errCode})`
        : "";
      return `${retMsg}${code}`;
    }
  }
  return JSON.stringify(value);
}

/** Imported lazily so that nothing which merely imports this module opens a socket, and so that a
 *  test supplying its own `create` never loads the package at all. */
async function defaultFactory(): Promise<() => MoomooClient> {
  const { default: mmWebsocket } = await import("moomoo-api");
  return () => new mmWebsocket();
}
