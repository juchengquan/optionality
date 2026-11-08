/** A stub IB Gateway, so the socket can be exercised without a real one.
 *
 *  ## What this is and is not evidence of
 *
 *  A run against this proves the CLIENT works. It is never evidence about IB Gateway, for the
 *  reason `ibkr-fake-gateway.ts` already carries: a stub I wrote from my own reading will agree
 *  with a decoder I wrote from the same reading, and agree wrongly if the reading was wrong.
 *
 *  So nothing here is invented. Every reply is a byte sequence that was validated twice over on
 *  2026-11-08: what the client SENDS was captured from the official Python client with its
 *  sendMsg intercepted at protocol 157, and what the gateway REPLIES is the message the real
 *  gateway on this machine sent for the same contract. The sequencing — greeting, then startApi,
 *  then an unprompted next-valid-id — is what the probes observed, not what the docs describe.
 *
 *  It still cannot speak for an account's entitlements, a dead session, or a market that is open.
 */
import { createServer, type Server } from "node:net";

import { MAX_SERVER_VERSION } from "./handshake.ts";
import { frame, readFields, readFrames, toFields } from "./wire.ts";

/** The contract the probes asked about, and the conId the real gateway returned for it. */
export const FAKE_CONID = 902390015;

/** The greeks the real gateway sent for SPXW 20261218 C 8100, frozen, on 2026-11-08.
 *
 *  Corrected after running our own client against the gateway: `optPrice` and `undPrice` were
 *  INVENTED in the first draft (4.05 and 6702.5) under a comment claiming they were measured.
 *  The real reading carries an option price of 3.6244 and NO underlying price at all — which is
 *  consistent with the 10090 the gateway returns about the SPX index itself, and is worth having
 *  in the fixture rather than a plausible number: a null here is a real shape the client meets.
 */
export const FAKE_GREEKS = {
  impliedVol: 0.13679778548286392, delta: 0.02806614063578037,
  gamma: 0.00018826189971762677, vega: 1.8321828845155324, theta: -0.28028107934963487,
  optPrice: 3.624407920679289,
  /** -1 on the wire, which `notComputed` turns into null. The index is not priced here. */
  undPriceWire: -1,
} as const;

export interface FakeOptions {
  /** Refuse the session the way a duplicate client id does, to exercise that path. */
  refuseSession?: string;
  /** Answer the handshake and then say nothing, which is the hang the 2026-10-16 incident was. */
  silent?: boolean;
  /** Claim a protocol below the floor, so the client's refusal can be tested. */
  serverVersion?: number;
  /** Answer market data with no figures at all — "subscribed, nothing yet". */
  noFigures?: boolean;
  /** Answer bid and ask with -1, which is what the real gateway sends for a price it does not
   *  have: live mode on a shut market, and SKEW outside its calculation window. */
  noPrices?: boolean;
  /** Complete the handshake, accept every request, and answer NOTHING — the shape measured on
   *  2026-11-08 when the gateway's link to IBKR dropped while its own socket stayed open. The
   *  dangerous one: reporting those contracts as unknown would quarantine every rule. */
  deaf?: boolean;
}

/** Listening, with the port it actually got (0 asks the OS for a free one). */
export interface FakeGateway {
  server: Server;
  port: number;
  /** How many contract lookups it has answered, so a test can prove the conid cache saves one. */
  lookups: number;
  close: () => Promise<void>;
}

export function startFakeGateway(port = 0, options: FakeOptions = {}): Promise<FakeGateway> {
  const counts = { lookups: 0 };
  const open = new Set<import("node:net").Socket>();
  const server = createServer((socket) => {
    open.add(socket);
    socket.on("close", () => open.delete(socket));
    let buffer: Buffer = Buffer.alloc(0);
    let greeted = false;

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
          const version = options.serverVersion ?? MAX_SERVER_VERSION;
          socket.write(frame(`${version}\u000020261108 10:35:00 Asia/Singapore\u0000`));
          continue;
        }
        const f = readFields(payload);
        const id = Number(f[0]);

        if (id === 71) {                                  // startApi
          if (options.refuseSession) {
            // reqId -1 is how the gateway reports a fault that belongs to no request
            socket.write(frame(toFields([4, 2, -1, 326, options.refuseSession])));
            continue;
          }
          if (options.silent) continue;                   // accepted, then nothing — the hang
          socket.write(frame(toFields([9, 1, 1])));       // nextValidId: the session is up
          continue;
        }

        if (options.deaf) continue;                       // accepted, and never answered

        if (id === 9) {                                   // reqContractDetails
          counts.lookups += 1;
          const reqId = Number(f[2]);
          socket.write(frame(toFields([
            10, 8, reqId, "SPX", "OPT", "20261218", "8100.0", "C", "SMART", "USD",
            "SPXW  261218C08100000", "SPX", "SPXW", FAKE_CONID, "0.05",
          ])));
          socket.write(frame(toFields([52, 1, reqId])));  // contractDetailsEnd
          continue;
        }

        if (id === 1) {                                   // reqMktData
          const reqId = Number(f[2]);
          socket.write(frame(toFields([58, 1, reqId, 2]))); // dataType: frozen, as asked
          if (options.noFigures) continue;
          const [bid, ask] = options.noPrices ? ["-1", "-1"] : ["3.5", "4.1"];
          socket.write(frame(toFields([1, 6, reqId, 1, bid, 0, 0])));   // bid
          socket.write(frame(toFields([1, 6, reqId, 2, ask, 0, 0])));   // ask
          socket.write(frame(toFields([
            21, reqId, 13, 0, FAKE_GREEKS.impliedVol, FAKE_GREEKS.delta, FAKE_GREEKS.optPrice,
            0, FAKE_GREEKS.gamma, FAKE_GREEKS.vega, FAKE_GREEKS.theta, FAKE_GREEKS.undPriceWire,
          ])));
          continue;
        }
        // reqMarketDataType and cancelMktData need no answer, as the real gateway gives none
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
