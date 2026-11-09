import { afterEach, describe, expect, it } from "vitest";

import { createConnection } from "node:net";

import { type FakeGateway, startFakeGateway } from "./fake.ts";
import { greeting, startApi } from "./handshake.ts";
import type { Incoming } from "./messages.ts";
import { cancelMktData, reqContractDetails, reqMktData } from "./messages.ts";
import { loadConversation } from "./recordings.ts";
import { TwsSocket } from "./socket.ts";
import { frame, readFields, readFrames } from "./wire.ts";

/** The stub's own rules for replaying a recording.
 *
 *  These are the rules the Python stub of ADR 0021's phase 4 must follow too, since both replay
 *  the same files: answer a request only with the exchange whose contract it names, put the
 *  request's own id where the recording says `$reqId`, and say nothing to a request the recording
 *  does not hold. `testdata/vendors/ibkr-gateway/README.md` states them for that reader.
 */

const SPXW = {
  symbol: "SPX", secType: "OPT" as const, lastTradeDateOrContractMonth: "20261218",
  strike: 8100, right: "C" as const,
  tradingClass: "SPXW", exchange: "SMART", currency: "USD", multiplier: "100",
};

let gateway: FakeGateway | null = null;
let client: TwsSocket | null = null;

afterEach(async () => {
  client?.close();
  client = null;
  await gateway?.close();
  gateway = null;
});

async function connected(conversation?: string): Promise<{ socket: TwsSocket; seen: Incoming[] }> {
  gateway = await startFakeGateway(0, conversation ? { conversation } : {});
  const seen: Incoming[] = [];
  const socket = new TwsSocket({ host: "127.0.0.1", port: gateway.port, clientId: 31419 });
  client = socket;
  await socket.connect((m) => seen.push(m));
  return { socket, seen };
}

describe("replaying a recording", () => {
  it("replays normal-with-greeks unless told otherwise", async () => {
    await connected();
    expect(gateway!.conversation.conversation).toBe("normal-with-greeks");
  });

  it("sends the session's messages in the order the gateway did", async () => {
    // managedAccounts BEFORE nextValidId, then the farm notices against -1, as recorded on
    // 2026-11-09. The stub this replaced sent nextValidId first, which no capture ever showed.
    // Read off a raw socket rather than through TwsSocket, which ends its handshake at
    // nextValidId and so never shows what came before it.
    gateway = await startFakeGateway(0);
    const frames = await rawSession(gateway.port, 7);
    expect(frames.map((f) => f[0])).toEqual(["157", "15", "9", "4", "4", "4", "4", "4"]);
    expect(frames.slice(3).every((f) => f[2] === "-1")).toBe(true);
  });

  it("answers with the request's own id where the recording says $reqId", async () => {
    const { socket, seen } = await connected();
    socket.send(reqContractDetails(42, SPXW));
    await waitFor(() => seen.some((m) => m.kind === "contractEnd"));
    expect(seen.find((m) => m.kind === "contract")).toMatchObject({ reqId: 42, conId: 902390015 });
  });

  it("matches a strike by its value, so 8100 and 8100.0 are one contract", async () => {
    // the TypeScript writes "8100.0" and a Python client may not; the gateway reads a double
    const { socket, seen } = await connected();
    socket.send(reqContractDetails(5, { ...SPXW, strike: 8100.0 }));
    await waitFor(() => seen.some((m) => m.kind === "contractEnd"));
    expect(seen.some((m) => m.kind === "contract")).toBe(true);
  });

  it("says nothing to a request the recording does not hold", async () => {
    // a contract nobody recorded has no recorded answer, and inventing one is what this replaced
    const { socket, seen } = await connected();
    socket.send(reqContractDetails(9, { ...SPXW, strike: 8200 }));
    socket.send(reqContractDetails(10, SPXW));
    await waitFor(() => seen.some((m) => m.kind === "contractEnd"));
    expect(seen.filter((m) => "reqId" in m && m.reqId === 9)).toEqual([]);
    expect(gateway!.lookups).toBe(2);
  });

  it("answers a cancel with what the gateway said to it, once the snapshot has ended", async () => {
    const { socket, seen } = await connected();
    socket.send(reqMktData(7, SPXW, true));
    await waitFor(() => seen.some((m) => m.kind === "snapshotEnd"));
    socket.send(cancelMktData(7));
    await waitFor(() => seen.some((m) => m.kind === "error" && m.code === 300));
    expect(seen.find((m) => m.kind === "error" && m.code === 300))
      .toEqual({ kind: "error", reqId: 7, code: 300, message: "Can't find EId with tickerId:7" });
  });

  it("replays a conversation given as data, not only by name", async () => {
    const recorded = loadConversation("normal-with-greeks");
    gateway = await startFakeGateway(0, {
      conversation: { ...recorded, conversation: "inline", exchanges: [] },
    });
    expect(gateway.conversation.conversation).toBe("inline");
  });
});

async function waitFor(done: () => boolean, ms = 2000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (done()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timed out waiting for the stub's reply");
}

/** Greet, start the API, and return every frame the stub sends until it has sent `count`. */
function rawSession(port: number, count: number): Promise<string[][]> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let buffer: Buffer = Buffer.alloc(0);
    const got: string[][] = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`the stub sent ${got.length} frame(s)`));
    }, 2000);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const { frames, rest } = readFrames(buffer);
      buffer = rest;
      for (const payload of frames) {
        got.push(readFields(payload));
        if (got.length === 1) socket.write(frame(startApi(31419)));
      }
      if (got.length >= count + 1) {
        clearTimeout(timer);
        socket.destroy();
        resolve(got);
      }
    });
    socket.write(greeting());
  });
}
