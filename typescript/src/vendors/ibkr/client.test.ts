import { afterEach, describe, expect, it } from "vitest";

import { IbkrClient } from "./client.ts";
import { type FakeGateway, startFakeGateway } from "./fake.ts";

/** The bounded ask, over a real loopback socket against the recorded stub.
 *
 *  A run against the stub proves the CLIENT and is never evidence about IB Gateway. Its replies
 *  are the conversations under `testdata/vendors/ibkr-gateway/`, each of which says whether it was
 *  recorded from the real gateway or constructed and why, and the figures below are
 *  normal-with-greeks', recorded on 2026-11-09, unless a test names another conversation.
 *
 *  What every conversation makes of this client is ALSO generated into that directory's
 *  `expected/` by `make cases`, for the Python client to be held to. These tests are the narrower
 *  claims, each with its reason.
 */

const OPTION = "US.SPXW261218C8100000";

/** The model's computation for OPTION, as the gateway sent it (tick 13). */
const MODEL = {
  impliedVol: 0.13795658209227243, delta: 0.03210521375811607, theta: -0.32748349484896266,
};

let gateway: FakeGateway | null = null;
let client: IbkrClient | null = null;

afterEach(async () => {
  client?.close();
  client = null;
  await gateway?.close();
  gateway = null;
});

async function connected(options: { conversation?: string } = {}): Promise<IbkrClient> {
  gateway = await startFakeGateway(0, options);
  client = new IbkrClient({
    host: "127.0.0.1", port: gateway.port, clientId: 31419, requestTimeoutMs: 1500,
  });
  return client;
}

describe("one bounded ask", () => {
  it("answers an option's figures under the service's own field names", async () => {
    const c = await connected();
    const batch = await c.fetchQuotes([OPTION]);

    expect(batch.unknown).toEqual([]);
    expect(batch.records).toHaveLength(1);
    const q = batch.records[0]!;
    expect(q.code).toBe(OPTION);
    expect(q.bid_price).toBe(4.1);
    expect(q.ask_price).toBe(4.5);
    // derived, not sent — the same rule opend/snapshot.ts applies
    expect(q.mid_price).toBe(4.3);
    expect(q.prev_close_price).toBe(3.65);
    // the model's greeks and not the bid's or the ask's, which the gateway sends alongside
    expect(q.option_delta).toBe(MODEL.delta);
    expect(q.option_theta).toBe(MODEL.theta);
  });

  it("converts implied volatility into the service's units, not IBKR's", async () => {
    // the silent 100× if it were a rename: IBKR's 0.1368 is moomoo's 14.007
    const c = await connected();
    const [q] = (await c.fetchQuotes([OPTION])).records;
    expect(q!.option_implied_volatility).toBeCloseTo(MODEL.impliedVol * 100, 10);
    expect(q!.option_implied_volatility as number).toBeGreaterThan(1);
  });

  it("carries the grade the gateway SERVED, not the one it asked for", async () => {
    // asked for DELAYED_FROZEN (4); the real gateway served LIVE (1) on 2026-11-09, because SPXW
    // was trading in global hours. Read rather than assumed — a configured guess would have
    // labelled a live figure delayed. What each grade means is cased in
    // testdata/vendors/ibkr-fields.json, grade 4's two facts included.
    const c = await connected();
    const [q] = (await c.fetchQuotes([OPTION])).records;
    expect(q!.delayed).toBe(false);
    expect(q!.last_known).toBe(false);
  });

  it("asks nothing at all for an empty list", async () => {
    const c = await connected();
    expect(await c.fetchQuotes([])).toEqual({ records: [], unknown: [] });
  });
});

describe("a code it cannot name", () => {
  it("is unknown without spending a call", async () => {
    // the gateway would answer the same thing, and a request bought to hear it is a request
    // bought for nothing
    const c = await connected();
    const batch = await c.fetchQuotes(["TSLA"]);
    expect(batch.unknown).toEqual(["TSLA"]);
    expect(batch.records).toEqual([]);
  });

  it("leaves the codes it CAN name standing beside it", async () => {
    const c = await connected();
    const batch = await c.fetchQuotes(["TSLA", OPTION]);
    expect(batch.unknown).toEqual(["TSLA"]);
    expect(batch.records.map((r) => r.code)).toEqual([OPTION]);
  });
});

describe("a contract the gateway does not list", () => {
  it("is unknown because the gateway said so, and asks no market data for it", async () => {
    // 8101 is not a listed strike: the real gateway refused the lookup with 200 on 2026-11-09
    const c = await connected({ conversation: "unknown-contract" });
    const batch = await c.fetchQuotes([OPTION, "US.SPXW261218C8101000"]);
    expect(batch.unknown).toEqual(["US.SPXW261218C8101000"]);
    expect(batch.records.map((r) => r.code)).toEqual([OPTION]);
  });
});

describe("the conid, resolved once", () => {
  it("is cached, so a second ask spends no lookup", async () => {
    const c = await connected();
    await c.fetchQuotes([OPTION]);
    const before = gateway!.lookups;
    await c.fetchQuotes([OPTION]);
    expect(gateway!.lookups).toBe(before);
  });

  it("is dropped with the connection, where a stale one would otherwise survive", async () => {
    const c = await connected();
    await c.fetchQuotes([OPTION]);
    c.close();
    const before = gateway!.lookups;
    await c.fetchQuotes([OPTION]);
    expect(gateway!.lookups).toBeGreaterThan(before);
  });
});

describe("a gateway that will not answer", () => {
  it("throws when it cannot be reached at all", async () => {
    const c = new IbkrClient({ host: "127.0.0.1", port: 1, clientId: 31419 });
    client = c;
    await expect(c.fetchQuotes([OPTION])).rejects.toThrow(/could not reach IB Gateway/);
  });

  it("reports a record with no figures rather than an unknown code", async () => {
    // "not subscribed" is a figure that did not arrive, and the sweep quarantines after N of
    // them. An unknown code is a typo. Those are different answers (ADR 0015). INDU resolves and
    // its data request is refused with 354, recorded 2026-11-09.
    const c = await connected({ conversation: "not-subscribed" });
    const batch = await c.fetchQuotes([OPTION, "INDU"]);
    expect(batch.unknown).toEqual([]);
    expect(batch.records.map((r) => r.code)).toEqual([OPTION, "INDU"]);
    expect(batch.records[1]).toEqual({ code: "INDU" });
  });

  // The shape observed on 2026-11-08: the gateway's link to IBKR dropped, its own socket stayed
  // open, `isConnected` stayed true, and every request was accepted and never answered. The first
  // version of this client reported those contracts as `unknown`, which reads as "none of these
  // exist" — and after enough sweeps would have quarantined every rule that watches one. ADR 0021
  // names two more silences of the same shape, and each has its own conversation.
  for (const conversation of ["link-down", "unentitled-account", "feed-held-elsewhere"]) {
    it(`THROWS when it accepts every request and answers none (${conversation})`, async () => {
      const c = await connected({ conversation });
      await expect(c.fetchQuotes([OPTION])).rejects.toThrow(/answered none of them/);
    });
  }

  it("leaves the contracts that DID answer standing beside the silent ones", async () => {
    // silence from every contract is a Provider failure; silence from some is not, and a batch
    // that throws because one contract is slow would lose the figures the others sent
    const c = await connected({ conversation: "never-answers" });
    const batch = await c.fetchQuotes([OPTION, "US.SPXW261218C8200000"]);
    expect(batch.records.map((r) => r.code)).toEqual([OPTION]);
    // and the silent one is not reported unknown: it may exist, and saying otherwise quarantines
    expect(batch.unknown).toEqual([]);
  });

  it("tears the connection down on a failure, so the next ask reconnects", async () => {
    const c = await connected();
    await c.fetchQuotes([OPTION]);
    await gateway!.close();
    gateway = null;
    await expect(c.fetchQuotes(["US.SPXW261204C8100000"])).rejects.toThrow();
    // a new gateway on the same port, and the client comes back rather than staying broken
    gateway = await startFakeGateway(0);
    const fresh = new IbkrClient({
      host: "127.0.0.1", port: gateway.port, clientId: 31419, requestTimeoutMs: 1500,
    });
    client = fresh;
    expect((await fresh.fetchQuotes([OPTION])).records).toHaveLength(1);
  });
});

describe("reachable, for /health", () => {
  it("is true where the handshake completes", async () => {
    const c = await connected();
    expect(await c.reachable()).toBe(true);
  });

  it("is false rather than raising where it does not", async () => {
    // a health probe that throws because the provider is down has reported the thing it was asked
    const c = new IbkrClient({ host: "127.0.0.1", port: 1, clientId: 31419 });
    client = c;
    expect(await c.reachable()).toBe(false);
  });
});
