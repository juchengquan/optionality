/** A stub IB Gateway, so the socket can be exercised without a real one.
 *
 *  ## What this is and is not evidence of
 *
 *  A run against this proves the CLIENT works. It is never evidence about IB Gateway, for the
 *  reason `ibkr-fake-gateway.ts` already carries: a stub written from the same reading as the
 *  decoder agrees with it, and agrees wrongly if the reading was wrong.
 *
 *  So it says nothing of its own. Everything it sends comes from a conversation under
 *  `testdata/vendors/ibkr-gateway/` — recorded from the real gateway, or constructed and labelled
 *  so, each file saying which and why — and the same files are what a Python stub replays to
 *  `ib_async` (ADR 0021, Decision 7). Keeping the replies OUT of this file is the point: one
 *  truth, two clients, and nothing in either stub that the other does not also send.
 *
 *  It replaced a stub that carried its replies inline, and the move found three things wrong
 *  with them that a recording does not allow: a contract reply cut to the fifteen fields this
 *  client reads (`ib_async` reads all thirty-nine, and ran off the end), nextValidId sent before
 *  managedAccounts (the real gateway sends them the other way round), and a gateway clock written
 *  in a format the gateway does not use.
 *
 *  ## How it answers
 *
 *  The greeting, then the recording's session messages when startApi arrives. A contract lookup
 *  or a market-data request is answered with the exchange whose contract it names — and, for
 *  market data, that asked the same way, a snapshot or a stream, because those are two questions
 *  with two answers (a snapshot of SPX carries no price at all) — with its own id put where the
 *  recording says `$reqId`; a request no exchange names is never answered, as a
 *  gateway that does not answer is the only honest reply to a question nobody recorded. Where a
 *  recording holds several exchanges for one request and contract, they answer in turn and the
 *  last answers every request after it, counted over the stub's life rather than per connection:
 *  a link that drops between two asks is a change in the gateway, and reconnecting does not undo
 *  it. A cancel gets what the gateway said to that cancel, and reqMarketDataType gets nothing, as
 *  from the real one.
 *
 *  Every reply goes at once, unless `pace` says otherwise: then each is sent at its recorded
 *  `atMs` times `pace` after the request, and a cancel stops what is still to come for that
 *  request, as the gateway stops a cancelled one. The corpus is replayed at once, because a
 *  timer racing a socket would make it flaky; pacing is for a client test whose claim is WHEN.
 *
 *  It still cannot speak for an account's entitlements, a dead session, or a market that is open.
 */
import { createServer, type Server, type Socket } from "node:net";

import {
  CONTRACT_KEYS, type ContractKey, type Conversation, type Exchange, SNAPSHOT_AT, fill,
  loadConversation,
} from "./recordings.ts";
import { frame, readFields, readFrames, toFields } from "./wire.ts";

/** What the stub replays when nobody says otherwise: one option, resolved and priced, recorded
 *  from the real gateway on 2026-11-09. */
export const DEFAULT_CONVERSATION = "normal-with-greeks";

export interface FakeOptions {
  /** The conversation to replay, by name under `testdata/vendors/ibkr-gateway/` or as data. */
  conversation?: string | Conversation;
  /** Claim this protocol version in place of the recording's, so the client's refusal of a
   *  gateway below its floor can be tested. The one thing this stub says that no recording
   *  holds, and it is a number rather than a reply: no gateway here speaks below 157. */
  serverVersion?: number;
  /** Send each reply at its recorded `atMs` times this, rather than every reply at once. */
  pace?: number;
}

/** Listening, with the port it actually got (0 asks the OS for a free one). */
export interface FakeGateway {
  server: Server;
  port: number;
  /** what it is replaying */
  conversation: Conversation;
  /** How many contract lookups it has been asked, so a test can prove the conid cache saves one. */
  lookups: number;
  /** Every message a client sent after its version range, in order, over the stub's life — so a
   *  test can hold a client to what it sends, as the Python stub's `received` does. */
  received: string[][];
  close: () => Promise<void>;
}

/** Message ids the stub reads. Everything else a client sends is accepted and not answered. */
const START_API = "71", REQ_MKT_DATA = "1", CANCEL_MKT_DATA = "2", REQ_CONTRACT_DATA = "9";

/** Where both requests carry the contract fields, at the versions this client and `ib_async`
 *  send at protocol 157: reqContractDetails is version 8 and reqMktData version 11, and after
 *  the message id, version and request id both lay out conId, symbol, secType and the rest
 *  identically (`messages.ts`'s `contractFields`). */
const AT: Record<ContractKey, number> = {
  symbol: 4, secType: 5, lastTradeDateOrContractMonth: 6, strike: 7, right: 8, exchange: 10,
  tradingClass: 14,
};

/** Whether a request names this exchange's contract. The strike by value — "8100.0" from this
 *  client and "8100" from another are one double to the gateway — and the rest as exact text. A
 *  market-data request must also ask the way the recording did, a snapshot or a stream, which
 *  both carry at the same field (`SNAPSHOT_AT`). */
function names(exchange: Exchange, fields: string[]): boolean {
  if (exchange.request === "reqMktData" && fields[SNAPSHOT_AT] !== exchange.sent[SNAPSHOT_AT]) {
    return false;
  }
  return CONTRACT_KEYS.every((key) => key === "strike"
    ? Number(fields[AT[key]]) === Number(exchange.contract[key])
    : fields[AT[key]] === exchange.contract[key]);
}

export function startFakeGateway(port = 0, options: FakeOptions = {}): Promise<FakeGateway> {
  const conversation = typeof options.conversation === "object"
    ? options.conversation : loadConversation(options.conversation ?? DEFAULT_CONVERSATION);
  const counts = { lookups: 0 };
  const received: string[][] = [];
  const open = new Set<Socket>();
  /** how many requests each request-and-contract has had, keyed by the first exchange naming it */
  const turns = new Map<Exchange, number>();

  const server = createServer((socket) => {
    open.add(socket);
    socket.on("close", () => open.delete(socket));
    let buffer: Buffer = Buffer.alloc(0);
    let greeted = false;
    /** market-data requests answered on this connection, by id, for what a cancel is told */
    const answered = new Map<string, Exchange>();
    /** replies still to be sent, by request id, when pacing */
    const pending = new Map<string, ReturnType<typeof setTimeout>[]>();
    const write = (m: string[], reqId?: string) => {
      if (!socket.destroyed) socket.write(frame(toFields(reqId === undefined ? m : fill(m, reqId))));
    };
    const send = (messages: string[][], reqId?: string) => {
      for (const m of messages) write(m, reqId);
    };
    const reply = (exchange: Exchange, reqId: string) => {
      const pace = options.pace;
      if (pace === undefined || exchange.atMs.length === 0) return send(exchange.replies, reqId);
      const timers = exchange.replies.map((m, i) =>
        setTimeout(() => write(m, reqId), exchange.atMs[i]! * pace));
      pending.set(reqId, [...(pending.get(reqId) ?? []), ...timers]);
    };
    const stop = (reqId?: string) => {
      for (const [id, timers] of pending) {
        if (reqId !== undefined && id !== reqId) continue;
        for (const timer of timers) clearTimeout(timer);
        pending.delete(id);
      }
    };

    socket.on("close", () => stop());
    socket.on("error", () => { /* a test closing its end is not a fault */ });
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      // the client's first bytes are "API\0" raw, before any frame
      if (!greeted && buffer.length >= 4 && buffer.subarray(0, 4).toString("ascii") === "API\0") {
        buffer = buffer.subarray(4);
      }
      const { frames, rest } = readFrames(buffer);
      buffer = rest;

      for (const payload of frames) {
        if (!greeted) {
          greeted = true;
          const [version, ...clock] = conversation.handshake.greeting;
          send([[String(options.serverVersion ?? version), ...clock]]);
          continue;
        }
        const f = readFields(payload);
        const reqId = f[2] ?? "";
        received.push(f);

        if (f[0] === START_API) {
          send(conversation.handshake.onStartApi);
          continue;
        }
        if (f[0] === REQ_CONTRACT_DATA || f[0] === REQ_MKT_DATA) {
          if (f[0] === REQ_CONTRACT_DATA) counts.lookups += 1;
          const request = f[0] === REQ_CONTRACT_DATA ? "reqContractDetails" : "reqMktData";
          const recorded = conversation.exchanges
            .filter((e) => e.request === request && names(e, f));
          if (recorded.length === 0) continue;         // nobody recorded an answer to this
          const turn = turns.get(recorded[0]!) ?? 0;
          turns.set(recorded[0]!, turn + 1);
          const exchange = recorded[Math.min(turn, recorded.length - 1)]!;
          if (request === "reqMktData") answered.set(reqId, exchange);
          reply(exchange, reqId);
          continue;
        }
        if (f[0] === CANCEL_MKT_DATA) {
          stop(reqId);
          send(answered.get(reqId)?.onCancel ?? [], reqId);
          answered.delete(reqId);
        }
        // reqMarketDataType, and anything else, gets no answer, as from the real gateway
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const got = typeof address === "object" && address ? address.port : port;
      resolve({
        server,
        port: got,
        conversation,
        get lookups() { return counts.lookups; },
        received,
        close: () => new Promise<void>((done) => {
          // destroyed, not just closed: `server.close()` waits for open connections to end, so a
          // client still holding one makes it hang for ever — which it did, as a 10s hook timeout
          for (const socket of open) socket.destroy();
          server.close(() => done());
        }),
      });
    });
  });
}
