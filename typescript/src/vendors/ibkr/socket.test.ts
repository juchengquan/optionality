import { afterEach, describe, expect, it } from "vitest";

import { type FakeGateway, startFakeGateway } from "./fake.ts";
import type { Incoming } from "./messages.ts";
import { reqContractDetails, reqMktData } from "./messages.ts";
import { TwsSocket } from "./socket.ts";

/** The socket, over a REAL loopback socket rather than a mock.
 *
 *  Framing is the thing most likely to be wrong, and a mock that hands over whole messages is
 *  precisely the thing that cannot catch a framing mistake: a socket delivers bytes, and one
 *  message can arrive in two pieces. So these tests go through the kernel.
 *
 *  The stub replays the conversations under `testdata/vendors/ibkr-gateway/`; the figures below
 *  are normal-with-greeks', recorded from the real gateway on 2026-11-09 unless a test names
 *  another conversation.
 */

/** The conId the real gateway gave SPXW 20261218 C 8100, on 2026-11-08 and again on 2026-11-09. */
const CONID = 902390015;

const SPXW = {
  symbol: "SPX", secType: "OPT" as const, lastTradeDateOrContractMonth: "20261218",
  strike: 8100, right: "C" as const,
  tradingClass: "SPXW", exchange: "SMART", currency: "USD", multiplier: "100",
};

/** The Dow, on the exchange that calculates it — which this account resolves and may not read. */
const INDU = {
  symbol: "INDU", secType: "IND" as const, lastTradeDateOrContractMonth: "", strike: 0,
  right: "" as const, tradingClass: "", exchange: "CME", currency: "USD", multiplier: "",
};

let gateway: FakeGateway | null = null;
let client: TwsSocket | null = null;

afterEach(async () => {
  client?.close();
  client = null;
  await gateway?.close();
  gateway = null;
});

async function connected(options = {}): Promise<{ socket: TwsSocket; seen: Incoming[] }> {
  gateway = await startFakeGateway(0, options);
  const seen: Incoming[] = [];
  const socket = new TwsSocket({ host: "127.0.0.1", port: gateway.port, clientId: 31419 });
  client = socket;
  await socket.connect((m) => seen.push(m));
  return { socket, seen };
}

describe("the handshake", () => {
  it("completes and learns the gateway's protocol version", async () => {
    const { socket } = await connected();
    expect(socket.connected).toBe(true);
    expect(socket.serverVersion).toBe(157);
  });

  it("waits for the session, not merely for the greeting", async () => {
    // the gateway answers the version exchange before it has decided anything about the client
    // id. A connect that resolved there would report success and fail the first request.
    gateway = await startFakeGateway(0, { conversation: "session-never-starts" });
    const socket = new TwsSocket({
      host: "127.0.0.1", port: gateway.port, clientId: 31419, connectTimeoutMs: 300,
    });
    client = socket;
    await expect(socket.connect(() => {})).rejects.toThrow(/did not complete the handshake/);
    expect(socket.connected).toBe(false);
  });

  it("reports a refused session as a refusal, not as an absent gateway", async () => {
    // a duplicate client id is the common one, and it otherwise reads exactly like "nothing
    // listening" — which sends you looking in the wrong place
    gateway = await startFakeGateway(0, { conversation: "client-id-in-use" });
    const socket = new TwsSocket({ host: "127.0.0.1", port: gateway.port, clientId: 31419 });
    client = socket;
    await expect(socket.connect(() => {}))
      .rejects.toThrow(/refused the session: 326 .*client id is already in use/);
  });

  it("refuses a gateway whose protocol is below the floor", async () => {
    // 155 is where the greeks message changes shape, and a decoder for it could never be tested
    gateway = await startFakeGateway(0, { serverVersion: 155 });
    const socket = new TwsSocket({ host: "127.0.0.1", port: gateway.port, clientId: 31419 });
    client = socket;
    await expect(socket.connect(() => {})).rejects.toThrow(/speaks protocol 155/);
  });

  it("says what a logged-out gateway looks like when the connection is refused", async () => {
    // measured on 2026-11-08: logging out closes the API socket entirely, so this is the real
    // shape of a dead session rather than a hypothetical
    const socket = new TwsSocket({ host: "127.0.0.1", port: 1, clientId: 31419 });
    client = socket;
    await expect(socket.connect(() => {})).rejects.toThrow(/could not reach IB Gateway/);
  });

  it("leaves nothing behind when it fails, so the next attempt starts clean", async () => {
    gateway = await startFakeGateway(0, { serverVersion: 155 });
    const socket = new TwsSocket({ host: "127.0.0.1", port: gateway.port, clientId: 31419 });
    client = socket;
    await expect(socket.connect(() => {})).rejects.toThrow();
    expect(socket.connected).toBe(false);
    // `already connected` would be thrown if the failed socket were still held
    await expect(socket.connect(() => {})).rejects.toThrow(/speaks protocol 155/);
  });
});

describe("asking", () => {
  it("carries a contract lookup and reads the conId back", async () => {
    const { socket, seen } = await connected();
    socket.send(reqContractDetails(1, SPXW));
    await waitFor(() => seen.some((m) => m.kind === "contractEnd"));

    const answer = seen.find((m) => m.kind === "contract");
    expect(answer).toEqual({
      kind: "contract", reqId: 1, conId: CONID, localSymbol: "SPXW  261218C08100000",
    });
  });

  it("reads prices and greeks off one data request", async () => {
    const { socket, seen } = await connected();
    socket.send(reqMktData(7, SPXW, true));
    await waitFor(() => seen.some((m) => m.kind === "snapshotEnd"));

    // bid, ask, and the previous close, in the order the gateway sent them
    expect(seen.filter((m) => m.kind === "price").map((m) => m.kind === "price" && m.price))
      .toEqual([4.1, 4.5, 3.65]);
    // the model's computation (tick 13), which is the one the client reads — the gateway also
    // sends one for each side of the book, and a last-price one full of not-computed sentinels
    const greeks = seen.find((m) => m.kind === "greeks" && m.tickType === 13);
    if (greeks?.kind !== "greeks") throw new Error("no model greeks arrived");
    expect(greeks.figures.delta).toBeCloseTo(0.0321052, 7);
    expect(greeks.figures.undPrice).toBeCloseTo(7418.19, 2);
  });

  it("reads which grade of data was granted, rather than assuming what was asked", async () => {
    // the client asked for DELAYED_FROZEN (4); in global trading hours the gateway served LIVE
    const { socket, seen } = await connected();
    socket.send(reqMktData(7, SPXW, true));
    await waitFor(() => seen.some((m) => m.kind === "dataType"));
    expect(seen.find((m) => m.kind === "dataType")).toEqual({ kind: "dataType", reqId: 7, type: 1 });
  });

  it("delivers a reply that arrives in two pieces as one message", async () => {
    // the whole reason these tests use a kernel socket. A long message straddling two packets is
    // the bug that works in every test and fails on a busy afternoon.
    const { socket, seen } = await connected();
    socket.send(reqContractDetails(1, SPXW));
    await waitFor(() => seen.some((m) => m.kind === "contract"));
    const answer = seen.find((m) => m.kind === "contract");
    if (answer?.kind !== "contract") throw new Error("no contract arrived");
    // 902390015 would be unreadable if a frame had been split and mis-joined
    expect(answer.conId).toBe(CONID);
  });

  it("delivers a price the gateway does not have as null, through the socket", async () => {
    // the decoder's own test covers the sentinel; this proves it survives the whole path, which
    // is where a number would quietly become -1.00 on a dashboard
    const { socket, seen } = await connected({ conversation: "no-prices" });
    socket.send(reqMktData(7, SPXW, true));
    await waitFor(() => seen.some((m) => m.kind === "snapshotEnd"));
    const prices = seen.filter((m) => m.kind === "price").map((m) => m.kind === "price" && m.price);
    // bid and ask arrived as -1; the previous close beside them is a real figure
    expect(prices).toEqual([null, null, 3.65]);
  });

  it("refuses to send when there is no session", () => {
    const socket = new TwsSocket({ host: "127.0.0.1", port: 1, clientId: 31419 });
    expect(() => socket.send(reqMktData(1, SPXW, true))).toThrow(/not connected/);
  });

  it("delivers a data request the account may not read as an error with no figures", async () => {
    // INDU resolves and is then refused with 354, recorded 2026-11-09. "Not subscribed" is NOT
    // a contract that does not exist, and the difference is what `hasFigures` keeps (ADR 0015)
    const { socket, seen } = await connected({ conversation: "not-subscribed" });
    socket.send(reqMktData(7, INDU, true));
    await waitFor(() => seen.some((m) => m.kind === "error" && m.reqId === 7));
    expect(seen.find((m) => m.kind === "error" && m.reqId === 7)).toMatchObject({ code: 354 });
    expect(seen.some((m) => m.kind === "price" || m.kind === "greeks")).toBe(false);
  });
});

describe("closing", () => {
  it("is idempotent, because every failure path calls it and some of them race", async () => {
    const { socket } = await connected();
    socket.close();
    socket.close();
    expect(socket.connected).toBe(false);
  });
});

async function waitFor(done: () => boolean, ms = 2000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (done()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timed out waiting for the gateway's reply");
}
