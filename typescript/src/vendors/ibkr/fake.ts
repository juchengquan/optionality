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
 *  or a market-data request is answered with the exchange whose contract it names, with its own
 *  id put where the recording says `$reqId`; a request no exchange names is never answered, as a
 *  gateway that does not answer is the only honest reply to a question nobody recorded. A cancel
 *  gets what the gateway said to that cancel, and reqMarketDataType gets nothing, as from the
 *  real one.
 *
 *  It still cannot speak for an account's entitlements, a dead session, or a market that is open.
 */
import { createServer, type Server, type Socket } from "node:net";

import {
  CONTRACT_KEYS, type ContractKey, type Conversation, type Exchange, fill, loadConversation,
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
}

/** Listening, with the port it actually got (0 asks the OS for a free one). */
export interface FakeGateway {
  server: Server;
  port: number;
  /** what it is replaying */
  conversation: Conversation;
  /** How many contract lookups it has been asked, so a test can prove the conid cache saves one. */
  lookups: number;
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
 *  client and "8100" from another are one double to the gateway — and the rest as exact text. */
function names(exchange: Exchange, fields: string[]): boolean {
  return CONTRACT_KEYS.every((key) => key === "strike"
    ? Number(fields[AT[key]]) === Number(exchange.contract[key])
    : fields[AT[key]] === exchange.contract[key]);
}

export function startFakeGateway(port = 0, options: FakeOptions = {}): Promise<FakeGateway> {
  const conversation = typeof options.conversation === "object"
    ? options.conversation : loadConversation(options.conversation ?? DEFAULT_CONVERSATION);
  const counts = { lookups: 0 };
  const open = new Set<Socket>();

  const server = createServer((socket) => {
    open.add(socket);
    socket.on("close", () => open.delete(socket));
    let buffer: Buffer = Buffer.alloc(0);
    let greeted = false;
    /** market-data requests answered on this connection, by id, for what a cancel is told */
    const answered = new Map<string, Exchange>();
    const send = (messages: string[][], reqId?: string) => {
      for (const m of messages) {
        socket.write(frame(toFields(reqId === undefined ? m : fill(m, reqId))));
      }
    };

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

        if (f[0] === START_API) {
          send(conversation.handshake.onStartApi);
          continue;
        }
        if (f[0] === REQ_CONTRACT_DATA || f[0] === REQ_MKT_DATA) {
          if (f[0] === REQ_CONTRACT_DATA) counts.lookups += 1;
          const request = f[0] === REQ_CONTRACT_DATA ? "reqContractDetails" : "reqMktData";
          const exchange = conversation.exchanges
            .find((e) => e.request === request && names(e, f));
          if (!exchange) continue;                      // nobody recorded an answer to this
          if (request === "reqMktData") answered.set(reqId, exchange);
          send(exchange.replies, reqId);
          continue;
        }
        if (f[0] === CANCEL_MKT_DATA) {
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
