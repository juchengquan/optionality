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

async function connected(
  conversation?: string, pace?: number,
): Promise<{ socket: TwsSocket; seen: Incoming[] }> {
  gateway = await startFakeGateway(0, {
    ...(conversation ? { conversation } : {}), ...(pace === undefined ? {} : { pace }),
  });
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

  it("answers several exchanges for one request in turn, the last every time after", async () => {
    // how a file says "answered once, then silent": link-down-between-asks holds two market-data
    // exchanges for one contract, the recorded answer and then none, and one lookup
    const { socket, seen } = await connected("link-down-between-asks");
    socket.send(reqMktData(1, SPXW, true));
    await waitFor(() => seen.some((m) => m.kind === "snapshotEnd" && m.reqId === 1));
    socket.send(reqMktData(2, SPXW, true));
    socket.send(reqMktData(3, SPXW, true));
    // a lone exchange still answers every request that names it, as every other file relies on
    socket.send(reqContractDetails(4, SPXW));
    socket.send(reqContractDetails(5, SPXW));
    await waitFor(() => seen.some((m) => m.kind === "contractEnd" && m.reqId === 5));
    expect(seen.filter((m) => m.kind === "contractEnd").map((m) => "reqId" in m && m.reqId))
      .toEqual([4, 5]);
    // the stub answers in the order it is asked, so anything for 2 or 3 would be here by now
    expect(seen.filter((m) => "reqId" in m && (m.reqId === 2 || m.reqId === 3))).toEqual([]);
  });

  it("answers a market-data request only with an exchange that asked the same way", async () => {
    // a snapshot and a stream of one contract are two questions with two different answers — a
    // snapshot of SPX carries no price at all and its stream does — so a recording of one never
    // stands in for the other. normal-with-greeks holds the option as a snapshot.
    const { socket, seen } = await connected();
    socket.send(reqMktData(7, SPXW, false));
    socket.send(reqMktData(8, SPXW, true));
    await waitFor(() => seen.some((m) => m.kind === "snapshotEnd" && m.reqId === 8));
    expect(seen.filter((m) => "reqId" in m && m.reqId === 7)).toEqual([]);
  });

  it("keeps every message a client sent after its greeting, in order", async () => {
    // so a test can hold a client to what it sends, as the Python stub's `received` does
    const { socket } = await connected();
    const before = gateway!.received.length;
    socket.send(reqContractDetails(3, SPXW));
    socket.send(cancelMktData(4));
    await waitFor(() => gateway!.received.length >= before + 2);
    expect(gateway!.received[0]![0]).toBe("71");            // startApi, sent as the socket connects
    expect(gateway!.received.slice(before).map((m) => [m[0], m[2]]))
      .toEqual([["9", "3"], ["2", "4"]]);
  });

  it("sends each reply at its recorded time, scaled, when told to pace", async () => {
    // when a figure arrives is what a client's completion rule is about, and a replay that
    // delivers everything at once cannot show it. Normal-with-greeks' model greeks came 1945ms
    // after the request and the snapshot's end 11104ms after; at a tenth, 195ms and 1110ms.
    const { socket, seen } = await connected(undefined, 0.1);
    const asked = Date.now();
    const at: Record<string, number> = {};
    socket.send(reqMktData(7, SPXW, true));
    await waitFor(() => {
      for (const m of seen) {
        const key = m.kind === "greeks" ? `greeks ${m.tickType}` : m.kind;
        at[key] ??= Date.now() - asked;
      }
      return seen.some((m) => m.kind === "snapshotEnd");
    }, 3000);
    expect(at["greeks 13"]).toBeGreaterThanOrEqual(150);
    expect(at["snapshotEnd"]).toBeGreaterThanOrEqual(1000);
    expect(at["dataType"]).toBeLessThan(at["greeks 13"]!);
  });

  it("answers a cancel that cuts a paced answer short with nothing, and sends no more", async () => {
    // what the gateway did to a snapshot cancelled 1.5s in, before its end, on 2026-11-10: no
    // reply to the cancel and nothing after it. The recorded error 300 answered a cancel sent
    // AFTER the end, and is no reply to this one.
    const { socket, seen } = await connected(undefined, 0.1);
    socket.send(reqMktData(7, SPXW, true));
    await waitFor(() => seen.some((m) => m.kind === "price"));
    socket.send(cancelMktData(7));
    await new Promise((r) => setTimeout(r, 1300));
    // the snapshot's end was due at 1110ms
    expect(seen.some((m) => m.kind === "snapshotEnd")).toBe(false);
    expect(seen.some((m) => m.kind === "error" && m.code === 300)).toBe(false);
  });

  it("answers a cancel after the last paced reply with what the gateway said to it", async () => {
    const { socket, seen } = await connected(undefined, 0.1);
    socket.send(reqMktData(7, SPXW, true));
    await waitFor(() => seen.some((m) => m.kind === "snapshotEnd"), 3000);
    socket.send(cancelMktData(7));
    await waitFor(() => seen.some((m) => m.kind === "error" && m.code === 300));
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
