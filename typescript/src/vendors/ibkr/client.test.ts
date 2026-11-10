import { afterEach, describe, expect, it } from "vitest";

import { IbkrClient } from "./client.ts";
import { type FakeGateway, type FakeOptions, startFakeGateway } from "./fake.ts";
import { type Conversation, type Exchange, loadConversation } from "./recordings.ts";

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

async function connected(
  options: FakeOptions = {}, requestTimeoutMs = 1500, quietMs?: number,
): Promise<IbkrClient> {
  gateway = await startFakeGateway(0, options);
  client = new IbkrClient({
    host: "127.0.0.1", port: gateway.port, clientId: 31419, requestTimeoutMs,
    ...(quietMs === undefined ? {} : { quietMs }),
  });
  return client;
}

/** How long an ask took, and what it came to. */
async function timed(c: IbkrClient, codes: string[]) {
  const started = Date.now();
  const batch = await c.fetchQuotes(codes);
  return { batch, ms: Date.now() - started };
}

/** A recording with one market-data exchange's replies changed, for a claim no capture shows. */
function edited(
  name: string, contract: { symbol: string; secType: string },
  change: (e: Exchange) => Pick<Exchange, "replies" | "atMs">,
): Conversation {
  const recorded = loadConversation(name);
  const named = (e: Exchange) => e.request === "reqMktData"
    && e.contract.symbol === contract.symbol && e.contract.secType === contract.secType;
  return {
    ...recorded, conversation: `${name}, edited`,
    exchanges: recorded.exchanges.map((e) => named(e) ? { ...e, ...change(e) } : e),
  };
}

/** What the client sent, by message id, from the `from`th message on, once `count` have arrived. */
async function sent(from: number, count: number): Promise<string[]> {
  await waitFor(() => gateway!.received.length >= from + count);
  return gateway!.received.slice(from).map((m) => m[0]!);
}

async function waitFor(done: () => boolean, ms = 2000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (done()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timed out waiting for the stub");
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

  it("asks an index as a STREAM, and answers the figures its first burst carries", async () => {
    // A snapshot of SPX or VIX carries no figure at any hour: its high, low and close come with
    // their prices EMPTY, then the snapshot's end eleven seconds later, because the account has
    // no snapshot permission for an index (the gateway's parameters say 0, the option's 3).
    // Recorded in the session on 2026-11-10, with the stream that does answer, in one burst.
    const c = await connected({ conversation: "index-in-the-session" });
    const batch = await c.fetchQuotes([OPTION, "SPX", "VIX"]);
    expect(batch.unknown).toEqual([]);
    // a replay delivers the whole three seconds at once, so SPX's last is its last update's
    expect(batch.records.find((r) => r.code === "SPX")).toEqual({
      code: "SPX", delayed: false, last_known: false, last_price: 7499.46, prev_close_price: 7549.94,
    });
    expect(batch.records.find((r) => r.code === "VIX")).toEqual({
      code: "VIX", delayed: false, last_known: false, last_price: 20.49, prev_close_price: 19.92,
    });
  });

  it("cancels every stream it opens, so no subscription outlives the ask", async () => {
    // a stream left running is a running board of prices, which would make a dead session look
    // like a calm market — and holds one of the account's market-data lines for ever
    const c = await connected({ conversation: "index-in-the-session" });
    await c.fetchQuotes(["SPX", "VIX"]);
    await waitFor(() => gateway!.received.filter((m) => m[0] === "2").length >= 2);
    const streams = gateway!.received.filter((m) => m[0] === "1").map((m) => [m[2], m[17]]);
    expect(streams.map(([, snapshot]) => snapshot)).toEqual(["0", "0"]);
    expect(gateway!.received.filter((m) => m[0] === "2").map((m) => m[2]).sort())
      .toEqual(streams.map(([id]) => id).sort());
  });

  it("asks nothing at all for an empty list", async () => {
    const c = await connected();
    expect(await c.fetchQuotes([])).toEqual({ records: [], unknown: [] });
  });
});

describe("when an ask is finished (#257)", () => {
  // The replies are PACED here, each sent at its recorded time scaled down, because when a
  // figure arrives is the whole question; the corpus replays everything at once.

  it("waits for an option's greeks through a pause longer than the quiet window", async () => {
    // the model's greeks come 0.3 to 1.7 seconds after the book, and in five of six live captures
    // a pause longer than the 250ms window came first, so the client finished without them. At a
    // quarter of the recorded times the pause before them is still 364ms.
    const c = await connected({ pace: 0.25 }, 5000);
    const { batch, ms } = await timed(c, [OPTION]);
    expect(batch.records[0]!.option_delta).toBe(MODEL.delta);
    // and on the greeks and the quiet after them: the snapshot's end is 2.8s away at this pace
    expect(ms).toBeLessThan(2000);
  });

  it("waits for a DELAYED option's model greeks, which are tick 83", async () => {
    // Graded delayed, the gateway sends the delayed ids: 66/67/75 for the book and close, 80-83
    // for the computations, 83 the model's. This table once read 53 as the delayed model, which is
    // the CUSTOM computation, so a delayed option waited out the timeout for greeks it already
    // had. Constructed from normal-with-greeks: no capture holds a delayed option (the paper login
    // here is served live), and the ids are IBKR's and ib_async's.
    const delayedIds: Record<string, string> = {
      1: "66", 2: "67", 9: "75", 10: "80", 11: "81", 12: "82", 13: "83",
    };
    const delayed = edited("normal-with-greeks", { symbol: "SPX", secType: "OPT" }, (e) => ({
      replies: e.replies.map((m) => {
        if (m[0] === "58") return [m[0], m[1]!, m[2]!, "3"];
        if (m[0] === "1") return [...m.slice(0, 3), delayedIds[m[3]!] ?? m[3]!, ...m.slice(4)];
        if (m[0] === "21") return [m[0], m[1]!, delayedIds[m[2]!] ?? m[2]!, ...m.slice(3)];
        return m;
      }),
      atMs: e.atMs,
    }));
    const c = await connected({ conversation: delayed, pace: 0.25 }, 5000);
    const { batch, ms } = await timed(c, [OPTION]);
    expect(batch.records[0]).toMatchObject({
      delayed: true, bid_price: 4.1, ask_price: 4.5, option_delta: MODEL.delta,
    });
    expect(ms).toBeLessThan(2000);
  });

  it("restarts the quiet on every NEW figure, so one that comes late is late rather than lost", async () => {
    // The book at 100ms, the model's greeks at 200 (the ask is complete, and the quiet starts),
    // the ask side at 600 and the close at 1000 — each inside the half-second quiet the figure
    // before it restarted, and the close outside the one the greeks started. Constructed: the
    // shape is a capture's (2026-11-10, 17:13:54Z: book 0.72s, greeks 1.40s, no close by 1.5s),
    // the times are chosen to sit well clear of the window either way.
    const late = edited("normal-with-greeks", { symbol: "SPX", secType: "OPT" }, (e) => {
      const find = (test: (m: string[]) => boolean) => e.replies.find(test)!;
      const at: [string[], number][] = [
        [find((m) => m[0] === "58"), 50],
        [find((m) => m[0] === "1" && m[3] === "1"), 100],
        [find((m) => m[0] === "21" && m[2] === "13"), 200],
        [find((m) => m[0] === "1" && m[3] === "2"), 600],
        [find((m) => m[0] === "1" && m[3] === "9"), 1000],
        [find((m) => m[0] === "57"), 6000],
      ];
      return { replies: at.map(([m]) => m), atMs: at.map(([, ms]) => ms) };
    });
    const c = await connected({ conversation: late, pace: 1 }, 8000, 500);
    const { batch, ms } = await timed(c, [OPTION]);
    expect(batch.records[0]).toMatchObject({
      bid_price: 4.1, ask_price: 4.5, prev_close_price: 3.65, option_delta: MODEL.delta,
    });
    // finished on the quiet after the close, not on the snapshot's end
    expect(ms).toBeLessThan(4000);
  });

  it("finishes when the gateway says the snapshot has ended, greeks or none", async () => {
    // the one delimiter the protocol has: nothing more is coming, so an option whose model never
    // answers is finished there, with the figures it did send, rather than by the timeout
    const noModel = edited("normal-with-greeks", { symbol: "SPX", secType: "OPT" }, (e) => {
      const keep = e.replies.map((m) => !(m[0] === "21" && m[2] === "13"));
      return {
        replies: e.replies.filter((_, i) => keep[i]), atMs: e.atMs.filter((_, i) => keep[i]),
      };
    });
    const c = await connected({ conversation: noModel, pace: 0.05 }, 5000);
    const { batch, ms } = await timed(c, [OPTION]);
    expect(batch.records[0]).toMatchObject({ bid_price: 4.1, ask_price: 4.5, prev_close_price: 3.65 });
    expect(batch.records[0]!.option_delta).toBeUndefined();
    expect(ms).toBeLessThan(2500);
  });

  it("is not held open by a stream repeating figures it has already sent", async () => {
    // A stream keeps sending, and a repeat is the running board rather than more of the answer,
    // so the quiet is measured from the last NEW figure. SPX's recorded update, sent every 100ms
    // for three seconds: busier than any window, and every message would restart one.
    const busy = edited("index-in-the-session", { symbol: "SPX", secType: "IND" }, (e) => {
      const burst = e.atMs.filter((t) => t === e.atMs[0]).length;
      const update = e.replies.slice(burst, burst + 4);
      const replies = [...e.replies.slice(0, burst)];
      const atMs = [...e.atMs.slice(0, burst)];
      for (let t = 600; t <= 3600; t += 100) {
        replies.push(...update);
        atMs.push(t, t, t, t);
      }
      return { replies, atMs };
    });
    const c = await connected({ conversation: busy, pace: 1 }, 5000);
    const { batch, ms } = await timed(c, ["SPX"]);
    expect(batch.records[0]).toMatchObject({ prev_close_price: 7549.94 });
    // the burst's last, or the first update's if it was read inside the quiet: which one is a
    // race between two timers 16ms apart, and not what this test is about
    expect([7499.18, 7499.44]).toContain(batch.records[0]!.last_price);
    // the burst at 0.5s and a quarter-second of quiet, not the 3.6s the updates last
    expect(ms).toBeLessThan(2000);
  });

  it("asks every contract side by side, so a batch costs its slowest contract", async () => {
    // one after another, every option's wait for its greeks would be paid again; side by side it
    // is paid once. Every market-data request goes out before any is cancelled, which is to say
    // before any is finished. On a warm cache, so no lookup's timing can interleave.
    const c = await connected({ conversation: "index-in-the-session" });
    await c.fetchQuotes([OPTION, "SPX", "VIX"]);
    await waitFor(() => gateway!.received.filter((m) => m[0] === "2").length >= 3);
    const from = gateway!.received.length;
    await c.fetchQuotes([OPTION, "SPX", "VIX"]);
    expect(await sent(from, 6)).toEqual(["1", "1", "1", "2", "2", "2"]);
  });
});

describe("the pace (#257's review)", () => {
  it("puts a big batch on the wire at the gateway's pace, 45 messages a second", async () => {
    // Side by side, a cold batch is a lookup per contract at once. ib_async holds itself to 45 a
    // second, startApi counted, and so does this client, so the two put the same messages out at
    // the same moments. Sixty contracts nobody recorded: none answers, and the ask then throws.
    const c = await connected({}, 1500);
    const codes = Array.from({ length: 60 }, (_, i) => `US.SPXW261218C${9001 + i}000`);
    const asked = c.fetchQuotes(codes).catch((err: unknown) => err);
    await new Promise((r) => setTimeout(r, 400));
    expect(gateway!.received.map((m) => m[0]).slice(0, 2)).toEqual(["71", "59"]);
    expect(gateway!.received.length).toBe(45);            // startApi, the data type, 43 lookups
    expect(await asked).toBeInstanceOf(Error);
    expect(gateway!.received.length).toBe(62);            // the other 17 a second later
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

  it("THROWS when the link drops behind a warm conid cache, never an empty batch", async () => {
    // The service holds its session for days, so this is where it meets the 2026-11-08 silence:
    // on a later ask, behind a conid it already has, with no lookup asked to go unanswered. The
    // first version of the rule counted a cached conid as an answer, and returned an EMPTY batch
    // here; as the Provider, that is every watched figure missing, quarantined one rule at a time.
    const c = await connected({ conversation: "link-down-between-asks" });
    expect((await c.fetchQuotes([OPTION])).records.map((r) => r.code)).toEqual([OPTION]);
    const lookups = gateway!.lookups;
    await expect(c.fetchQuotes([OPTION])).rejects.toThrow(/answered none of them/);
    // and the silence really was met behind the cache, not at a lookup
    expect(gateway!.lookups).toBe(lookups);
  });

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
