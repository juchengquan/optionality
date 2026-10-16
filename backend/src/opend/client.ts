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
import type { QuoteFetcher } from "../quotes.ts";

/** Market 11 is the US. See snapshot.ts — the service deals in no other. */
const US_MARKET = 11;

export interface OpendConfig {
  host: string;
  /** the WEBSOCKET port, which is not the TCP one the Python uses */
  port: number;
  /** OpenD's websocket key, in plaintext; the library hashes it */
  key: string;
  loginTimeoutMs?: number;
  /** supplied by a test; the real one is the npm package's default export */
  create?: () => MoomooClient;
}

/** `US.SPXW261030C8100000` as moomoo wants it, and back again. */
function toSecurity(code: string): Security {
  const bare = code.startsWith("US.") ? code.slice(3) : code;
  return { market: US_MARKET, code: bare };
}

export class OpendClient {
  private client: MoomooClient | null = null;
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
    const client = create();
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

  /** Drop the connection so the next call makes a new one. */
  close(): void {
    try {
      this.client?.stop();
    } catch {
      /* already gone */
    }
    this.client = null;
  }

  /** One batched snapshot for these codes.
   *
   *  The error text matters as much as the data: moomoo names an unknown contract in it, and
   *  `fetchResilient` reads that name to drop the culprit and retry. Keeping the Python's
   *  "snapshot API failed: ..." prefix is what makes the containment work unchanged.
   */
  async snapshot(codes: string[]): Promise<ReturnType<typeof toRecords>> {
    if (codes.length === 0) return [];
    let response;
    try {
      const client = await this.connect();
      response = await client.GetSecuritySnapshot({
        c2s: { securityList: codes.map(toSecurity) },
      });
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

  /** The port the rest of the service takes. */
  asFetcher(): QuoteFetcher {
    return (codes) => this.snapshot(codes);
  }
}

function describe(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/** Imported lazily so that nothing which merely imports this module opens a socket, and so that a
 *  test supplying its own `create` never loads the package at all. */
async function defaultFactory(): Promise<() => MoomooClient> {
  const { default: mmWebsocket } = await import("moomoo-api");
  return () => new mmWebsocket();
}
