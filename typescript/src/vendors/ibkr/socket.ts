/** The socket: one connection, held, and torn down on any failure.
 *
 *  The shape is `opend/client.ts`'s, deliberately and almost line for line, because moomoo posed
 *  this exact problem first and the answer there has an incident behind it: a logged-in provider
 *  can accept a request and never answer it, and a promise that never settles stopped the alarm
 *  engine dead on 2026-10-16. So every wait here is bounded, and a failure closes the connection
 *  rather than leaving a queue nobody is listening to.
 *
 *  What is NOT here is the asking. This file carries bytes and nothing else: it knows framing and
 *  the handshake, and has no opinion about what a quote is. The bounded ask — which figures count
 *  as a complete answer, and what a timeout means — is `client.ts`'s, so that the decision can be
 *  tested without a socket and the socket can be tested without a decision.
 */
import { createConnection, type Socket } from "node:net";

import { greeting, readGreeting, startApi } from "./handshake.ts";
import { type Incoming, readMessage } from "./messages.ts";
import { frame, readFields, readFrames } from "./wire.ts";

export interface TwsSocketConfig {
  host: string;
  port: number;
  /** IB Gateway permits ONE connection per client id, and a second user of the same number
   *  displaces the first in silence. Each consumer carries its own (see the backend's `env.ts`). */
  clientId: number;
  /** Bounds the handshake: a port that accepts is not a gateway that answers. */
  connectTimeoutMs?: number;
  /** supplied by a test; the real one opens a TCP socket */
  connect?: (host: string, port: number) => Socket;
}

export type OnMessage = (message: Incoming) => void;

/** At most this many messages in any `PACE_WINDOW_MS`, the rest queued in order: `ib_async`'s own
 *  throttle (`Client.MaxRequests` 45 per `RequestsInterval` 1s), copied so that the two clients put
 *  the same messages on the wire at the same moments. IB Gateway's documented limit is 50 messages
 *  a second. While the client asked one contract at a time it paced itself; side by side (#257) a
 *  cold batch is two messages per contract at once, which a Provider's watchlist could push past
 *  the limit. As in `ib_async`, startApi counts and the version greeting does not, and a request's
 *  own timer runs while it waits in the queue. */
export const PACE_MESSAGES = 45;
export const PACE_WINDOW_MS = 1000;

export class TwsSocket {
  private socket: Socket | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private listener: OnMessage | null = null;
  /** The gateway's protocol version, once it has said. Null means no session. */
  serverVersion: number | null = null;
  /** when each of the messages in the current window went, and the ones still waiting their turn */
  private sentAt: number[] = [];
  private queued: string[] = [];
  private drain: ReturnType<typeof setTimeout> | null = null;

  private readonly config: TwsSocketConfig;

  // written out rather than a constructor parameter property: `tsc` and vitest both accept that
  // shorthand and Node refuses to run it, which is the exact class `make check-api` exists to
  // catch and did catch here
  constructor(config: TwsSocketConfig) {
    this.config = config;
  }

  get connected(): boolean {
    return this.socket !== null && this.serverVersion !== null;
  }

  /** Open, greet, and start the session.
   *
   *  Resolves once the gateway has accepted `startApi` and sent the unprompted message that says
   *  so. A greeting alone is not a session: the gateway answers the version exchange before it has
   *  decided anything about the client id, so stopping there would report success and then fail
   *  the first request.
   */
  async connect(onMessage: OnMessage): Promise<void> {
    if (this.socket) throw new Error("already connected to IB Gateway");
    const { host, port, clientId, connectTimeoutMs = 10_000 } = this.config;
    const open = this.config.connect ?? ((h, p) => createConnection({ host: h, port: p }));
    this.listener = onMessage;

    const socket = open(host, port);
    this.socket = socket;
    socket.setNoDelay(true);

    try {
      await this.handshake(socket, clientId, connectTimeoutMs);
    } catch (err) {
      // the whole point of holding a connection is that the next call can reuse it, which is only
      // safe if a failed one leaves nothing behind
      this.close();
      throw err;
    }
  }

  private handshake(socket: Socket, clientId: number, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let greeted = false;
      let settled = false;
      const timer = setTimeout(() => {
        finish(new Error(
          `IB Gateway at ${this.config.host}:${this.config.port} did not complete the handshake `
          + `within ${timeoutMs}ms`,
        ));
      }, timeoutMs);

      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.off("data", onData);
        socket.off("error", onError);
        socket.off("close", onClose);
        // the steady-state handlers take over only once the session exists
        if (!err) {
          socket.on("data", (chunk: Buffer) => this.onData(chunk));
          socket.on("error", () => this.close());
          socket.on("close", () => this.close());
        }
        err ? reject(err) : resolve();
      };

      // Every throw in here has to become a REJECTION. An exception raised inside a socket's
      // data handler escapes the promise entirely and surfaces as an uncaught error, leaving
      // `connect()` pending for ever — which is the 2026-10-16 failure in a new place, and is
      // how the version-floor refusal first behaved: it hung instead of refusing.
      const onData = (chunk: Buffer) => {
        try {
          readChunk(chunk);
        } catch (err) {
          finish(err instanceof Error ? err : new Error(String(err)));
        }
      };

      const readChunk = (chunk: Buffer) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        const { frames, rest } = readFrames(this.buffer);
        this.buffer = rest;
        for (const payload of frames) {
          if (!greeted) {
            // the greeting is the one message that is not a numbered message — it is the version
            // and the gateway's clock, read positionally
            const { serverVersion } = readGreeting(readFields(payload));
            this.serverVersion = serverVersion;
            greeted = true;
            this.queued.push(startApi(clientId));
            this.flush();
            continue;
          }
          const message = readMessage(payload);
          // the gateway volunteers this unasked once the session is up, and it is the only
          // signal that the client id was ACCEPTED rather than merely sent
          if (message.kind === "serverTime") {
            finish();
            continue;
          }
          // an error during the handshake is the gateway refusing the session — most often a
          // client id already in use, which otherwise looks exactly like "no gateway there"
          if (message.kind === "error" && message.reqId === -1) {
            finish(new Error(`IB Gateway refused the session: ${message.code} ${message.message}`));
            continue;
          }
          this.listener?.(message);
        }
      };

      const onError = (err: Error) => finish(
        new Error(`could not reach IB Gateway at ${this.config.host}:${this.config.port}: ${err.message}`),
      );
      const onClose = () => finish(new Error(
        `IB Gateway closed the connection during the handshake — logging out closes the API `
        + `socket, so this is what a logged-out gateway looks like`,
      ));

      socket.on("data", onData);
      socket.on("error", onError);
      socket.on("close", onClose);
      socket.write(greeting());
    });
  }

  private onData(chunk: Buffer): void {
    try {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      const { frames, rest } = readFrames(this.buffer);
      this.buffer = rest;
      for (const payload of frames) this.listener?.(readMessage(payload));
    } catch (err) {
      // the same reasoning as the handshake's, for the steady state: a throw here would be an
      // uncaught error on an event emitter rather than a failed fetch. Closing is what makes the
      // next call reconnect and the failure visible, as `opend/client.ts` does.
      console.error("IB Gateway message could not be read; closing the connection:", err);
      this.close();
    }
  }

  /** Sent now, or queued behind the messages already waiting if the window is full. */
  send(payload: string): void {
    if (!this.socket || this.serverVersion === null) {
      throw new Error("not connected to IB Gateway");
    }
    this.queued.push(payload);
    this.flush();
  }

  /** As many queued messages as the window allows, and a timer for the rest when the oldest
   *  message in the window ages out of it. */
  private flush(): void {
    this.drain = null;
    const socket = this.socket;
    if (!socket) return;
    const now = performance.now();
    while (this.sentAt.length > 0 && now - this.sentAt[0]! >= PACE_WINDOW_MS) this.sentAt.shift();
    while (this.queued.length > 0 && this.sentAt.length < PACE_MESSAGES) {
      socket.write(frame(this.queued.shift()!));
      this.sentAt.push(now);
    }
    if (this.queued.length > 0 && this.drain === null) {
      this.drain = setTimeout(() => this.flush(), this.sentAt[0]! + PACE_WINDOW_MS - now);
    }
  }

  /** Idempotent, because every failure path calls it and some of them race. */
  close(): void {
    const socket = this.socket;
    this.socket = null;
    this.serverVersion = null;
    this.buffer = Buffer.alloc(0);
    // what was waiting goes with the connection, as `ib_async`'s reset drops its queue
    if (this.drain !== null) clearTimeout(this.drain);
    this.drain = null;
    this.queued = [];
    this.sentAt = [];
    if (socket) {
      socket.removeAllListeners();
      socket.destroy();
    }
  }
}
