import { createConnection } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { IbkrAccountRefused, IbkrClient, IbkrUnreachable } from "./client.ts";
import { type FakeGateway, type FakeOptions, startFakeGateway } from "./fake.ts";
import {
  type Conversation, type Exchange, PLACEHOLDER_ACCOUNTS, loadConversation,
} from "./recordings.ts";

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
    // answers is finished there, with the figures it did send — when the end comes before the
    // timeout. Here it does (0.55s against 5s, paced); live it comes at eleven seconds, after the
    // default eight, so there the timeout finishes such an option
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

describe("one connection per client id", () => {
  // IB Gateway allows one connection per client id. The sweep, the dashboard's poll and a creation
  // probe can all arrive while the client is cold, and each used to open a socket of its own with
  // the same id: the gateway refused the second, and that refusal's teardown closed whatever
  // socket the client held and dropped every caller's listeners.
  const cold = async (options: FakeOptions = {}, requestTimeoutMs = 1500) => {
    const c = await connected({ oneSessionPerClientId: true, ...options }, requestTimeoutMs);
    let opened = 0;
    const counting = new IbkrClient({
      host: "127.0.0.1", port: gateway!.port, clientId: 31419, requestTimeoutMs,
      connect: (host, port) => { opened += 1; return createConnection({ host, port }); },
    });
    c.close();
    client = counting;
    return { c: counting, opened: () => opened };
  };

  it("shares one connect between callers who arrive together", async () => {
    const { c, opened } = await cold();
    const asks = await Promise.allSettled([
      c.fetchQuotes([OPTION]), c.fetchQuotes([OPTION]), c.fetchQuotes([OPTION]), c.reachable(),
    ]);
    expect(asks.map((a) => a.status)).toEqual(["fulfilled", "fulfilled", "fulfilled", "fulfilled"]);
    for (const a of asks.slice(0, 3)) {
      expect((a as PromiseFulfilledResult<any>).value.records.map((r: any) => r.code)).toEqual([OPTION]);
    }
    expect(opened()).toBe(1);
    expect(gateway!.sessionsAsked).toBe(1);
    expect(gateway!.connections).toBe(1);
  });

  it("fails every caller of a refused connect with the refusal, and leaves no socket open", async () => {
    const { c, opened } = await cold({ conversation: "client-id-in-use" });
    const asks = await Promise.allSettled([c.fetchQuotes([OPTION]), c.fetchQuotes([OPTION])]);
    for (const a of asks) {
      expect(a.status).toBe("rejected");
      expect(String((a as PromiseRejectedResult).reason)).toMatch(/refused the session: 326/);
    }
    expect(opened()).toBe(1);
    await waitFor(() => gateway!.connections === 0);
  });

  it("opens no socket that outlives a close made while it was connecting", async () => {
    const { c } = await cold();
    const ask = c.fetchQuotes([OPTION]);
    c.close();
    await expect(ask).rejects.toThrow(/closed/);
    await waitFor(() => gateway!.connections === 0);
    // and the client still works afterwards
    expect((await c.fetchQuotes([OPTION])).records).toHaveLength(1);
  });

  it("tears down only the socket a failed ask used, never one opened since", async () => {
    // Ask A waits on a lookup the gateway never answers. Its socket dies under it, ask B
    // reconnects and is answered, and only then does A give up. A's teardown used to close
    // whatever socket the client held — B's — so the next ask paid a handshake again, and an ask
    // running on it would have lost its listeners.
    const c = await connected({ conversation: "never-answers" }, 600);
    const a = c.fetchQuotes(["US.SPXW261218C8200000"]);
    await waitFor(() => gateway!.lookups === 1);
    gateway!.dropConnections();
    await waitFor(() => !(c as unknown as { socket: { connected: boolean } | null }).socket?.connected);
    expect((await c.fetchQuotes([OPTION])).records.map((r) => r.code)).toEqual([OPTION]);
    expect(gateway!.sessionsAsked).toBe(2);
    await expect(a).rejects.toThrow(/answered none of them/);
    await waitFor(() => gateway!.connections === 1);
    expect((await c.fetchQuotes([OPTION])).records).toHaveLength(1);
    expect(gateway!.sessionsAsked, "B's connection must have survived A's failure").toBe(2);
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

describe("the account read (ADR 0030)", () => {
  // Every conversation here is CONSTRUCTED, in ibapi 9.81's layout, with invented figures and
  // placeholder accounts: nothing of the owner's account is ever committed.

  /** The account subscriptions the stub was sent, in order: [subscribe, account]. */
  const subscriptions = (g: FakeGateway) =>
    g.received.filter((f) => f[0] === "6").map((f) => [f[2], f[3]]);

  /** Until every subscribe has had its unsubscribe, or a second has passed: the unsubscribe is
   *  sent as the read settles, and reaches the stub a moment later. */
  async function unsubscribed(g: FakeGateway): Promise<void> {
    const until = Date.now() + 1000;
    const open = () => subscriptions(g).reduce((n, [on]) => n + (on === "1" ? 1 : -1), 0);
    while (open() > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
  }

  it("answers the totals and every holding, IBKR's marks, the account masked", async () => {
    const c = await connected({ conversation: "account-stocks-and-options" });
    const got = await c.account();
    expect(got).toMatchObject({
      account: "U•••••000", paper: false, base_currency: "USD", updated_at: "14:32",
      // the P&L from $LEDGER's BASE row, which counts the EUR stock's; the USD row does not
      totals: {
        net_liquidation: 94532.1, total_cash: 64829.28, unrealized_pnl: 2137.37,
        realized_pnl: -412.8,
      },
    });
    expect(got.holdings.map((h) => [h.symbol, h.sec_type, h.currency, h.position])).toEqual([
      ["ACME", "STK", "USD", 300], ["GLOBEX", "STK", "USD", 120], ["INITECH", "STK", "EUR", 50],
      ["ACME", "OPT", "USD", 4], ["ACME", "OPT", "USD", -6],
    ]);
    // IB's averageCost for an option is per contract; the answer's is per share
    expect(got.holdings[3]!.average_cost).toBe(2.625);
    // a stock's strike "0" and right "0" are no strike and no side; an option's "45" is 45
    expect(got.holdings[0]).toMatchObject({ strike: null, right: null, multiplier: null });
    expect(got.holdings[3]).toMatchObject({ strike: 45, right: "C", multiplier: 100 });
    expect(got.exchange_rates).toEqual({ USD: 1, EUR: 1.0841, CHF: 1.1307 });
  });

  it("sends exactly a subscribe naming the account, then its unsubscribe", async () => {
    const c = await connected({ conversation: "account-stocks-and-options" });
    await c.account();
    await unsubscribed(gateway!);
    expect(subscriptions(gateway!)).toEqual([["1", "U0000000"], ["0", "U0000000"]]);
  });

  it("calls a DU account paper", async () => {
    const c = await connected({ conversation: "account-paper" });
    expect(await c.account()).toMatchObject({ account: "DU•••••000", paper: true });
  });

  it("fails at the deadline when the download never ends, and unsubscribes anyway", async () => {
    const c = await connected({ conversation: "account-never-ends" }, 300);
    await expect(c.account()).rejects.toThrow(
      "IB Gateway did not finish sending the account within 300ms — its link to IBKR may be "
      + "down while its own socket is still open");
    await unsubscribed(gateway!);
    expect(subscriptions(gateway!)).toEqual([["1", "U0000000"], ["0", "U0000000"]]);
  });

  it("joins a read already running, so two callers send ONE subscribe", async () => {
    const c = await connected({ conversation: "account-stocks-and-options" });
    // the second caller arrives while the first's subscribe is on the wire, before any answer
    const [a, b] = await Promise.all([c.account(), c.account()]);
    expect(b).toEqual(a);
    await unsubscribed(gateway!);
    expect(subscriptions(gateway!)).toEqual([["1", "U0000000"], ["0", "U0000000"]]);
  });

  it("holds a read of ANOTHER account until the running one has unsubscribed", async () => {
    // IB allows a single account subscription per client at a time: a second subscribe while the first
    // runs would take its place, and the first read would never hear its download end
    const c = await connected({ conversation: "account-several" });
    const [first, second] = await Promise.all([c.account("U0000000"), c.account("U0000001")]);
    expect([first.account, second.account]).toEqual(["U•••••000", "U•••••001"]);
    await unsubscribed(gateway!);
    expect(subscriptions(gateway!)).toEqual([
      ["1", "U0000000"], ["0", "U0000000"], ["1", "U0000001"], ["0", "U0000001"],
    ]);
  });

  it("takes the connection afresh after waiting, where the read it waited on lost it", async () => {
    // review round 2: the waiting read held the connection it found before the wait, and
    // subscribed on a dead one — "not connected to IB Gateway"
    const conversation = loadConversation("account-several");
    const withheld = {
      ...conversation,
      exchanges: conversation.exchanges.map((e) => e.request === "reqAccountUpdates"
        && e.account === "U0000000" ? { ...e, replies: e.replies.filter((m) => m[0] !== "54") } : e),
    };
    const c = await connected({ conversation: withheld }, 5000);
    const first = c.account("U0000000");
    const second = c.account("U0000001");
    const until = Date.now() + 1000;
    while (subscriptions(gateway!).length === 0 && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 5));
    }
    gateway!.dropConnections();
    await expect(first).rejects.toThrow("IB Gateway's connection closed during the account read");
    expect(await second).toMatchObject({ account: "U•••••001" });
    await unsubscribed(gateway!);
    expect(subscriptions(gateway!)).toEqual([
      ["1", "U0000000"], ["1", "U0000001"], ["0", "U0000001"],
    ]);
    expect(gateway!.sessionsAsked).toBe(2);
  });

  it("ignores the 2100 that answers an unsubscribe, though it arrives during the next read", async () => {
    // measured on 2026-11-23: every unsubscribe is answered with error 2100 against -1. A read
    // begun in the same turn as the last one's unsubscribe has its subscribe on the wire before
    // that 2100 comes back, so the 2100 arrives DURING it, and must not end it
    const c = await connected({ conversation: "account-stocks-and-options" });
    const first = await c.account();
    const second = await c.account();
    expect(second).toEqual(first);
  });

  it("subscribes afresh for a read that comes after one has finished", async () => {
    const c = await connected({ conversation: "account-paper" });
    await c.account();
    await c.account();
    await unsubscribed(gateway!);
    expect(subscriptions(gateway!)).toEqual([
      ["1", "DU0000000"], ["0", "DU0000000"], ["1", "DU0000000"], ["0", "DU0000000"],
    ]);
  });

  it("refuses several accounts with none named, masked, and subscribes to nothing", async () => {
    const c = await connected({ conversation: "account-several" });
    const err = await c.account().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IbkrAccountRefused);
    expect((err as Error).message)
      .toBe("several accounts on this login; set IBKR_ACCOUNT to one of U•••••000, U•••••001");
    expect(subscriptions(gateway!)).toEqual([]);
  });

  it("reads the one named, of several", async () => {
    const c = await connected({ conversation: "account-several" });
    expect(await c.account("U0000001")).toMatchObject({
      account: "U•••••001", totals: { net_liquidation: 25010 }, holdings: [],
    });
  });

  it("refuses a named account not on the login, naming it masked", async () => {
    const c = await connected({ conversation: "account-several" });
    await expect(c.account("DU0000001")).rejects.toThrow(new IbkrAccountRefused(
      "IBKR_ACCOUNT (DU•••••001) names no account on this login, which has U•••••000, U•••••001"));
  });

  it("ignores what the gateway says about another account while it reads one", async () => {
    const conversation = loadConversation("account-paper");
    const [exchange] = conversation.exchanges;
    const stray = ["7", "8", "100000999", "ACME", "STK", "", "0.0", "0", "", "NASDAQ", "USD",
      "ACME", "NMS", "1", "41.27", "41.27", "40", "1.27", "0.0", "DU0000001"];
    const c = await connected({ conversation: {
      ...conversation, exchanges: [{ ...exchange!, replies: [stray, ...exchange!.replies] }],
    } });
    expect((await c.account()).holdings.map((h) => h.position)).toEqual([-1]);
  });

  it("fails a read at once when the client is closed under it", async () => {
    const c = await connected({ conversation: "account-never-ends" }, 5000);
    const read = c.account();
    await new Promise((r) => setTimeout(r, 50));
    c.close();
    await expect(read).rejects.toThrow("IB Gateway's connection closed during the account read");
  });

  it("throws IbkrUnreachable, in the connect's own words, where the session is refused", async () => {
    // round 4, for the route (#473): a gateway the read cannot reach is neither a refusal to choose
    // an account nor a read that failed once it began
    const c = await connected({ conversation: "client-id-in-use" });
    const err = await c.account().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IbkrUnreachable);
    expect((err as Error).message).toMatch(/^IB Gateway refused the session: 326 /);
  });

  it("throws IbkrUnreachable where nothing listens on the port", async () => {
    const probe = await startFakeGateway(0, {});
    const port = probe.port;
    await probe.close();
    const c = new IbkrClient({ host: "127.0.0.1", port, clientId: 31419, connectTimeoutMs: 1000 });
    try {
      const err = await c.account().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(IbkrUnreachable);
      expect((err as Error).message).toMatch(`could not reach IB Gateway at 127.0.0.1:${port}: `);
    } finally {
      c.close();
    }
  });

  it("does not call a read that failed once it began unreachable", async () => {
    const c = await connected({ conversation: "account-never-ends" }, 300);
    const err = await c.account().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(IbkrUnreachable);
  });

  it("never writes an account id in full: not in an answer, an error, or a log line", async () => {
    const said: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        said.push(args.map(String).join(" "));
      }));
    try {
      for (const [name, wanted] of [
        ["account-stocks-and-options", undefined], ["account-paper", undefined],
        ["account-several", undefined], ["account-several", "U0000001"],
        ["account-several", "DU0000001"], ["account-never-ends", undefined],
      ] as const) {
        const c = await connected({ conversation: name }, 300);
        said.push(await c.account(wanted).then(JSON.stringify, (e: Error) => e.message));
        c.close();
        await gateway!.close();
        gateway = null;
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(said.length).toBeGreaterThanOrEqual(6);
    for (const id of PLACEHOLDER_ACCOUNTS) {
      expect(said.filter((line) => line.includes(id)), id).toEqual([]);
    }
  });
});

describe("the account watch (ADR 0031)", () => {
  // Every conversation here is CONSTRUCTED: the account updates in ibapi 9.81's layout, the P&L
  // streams in ib_async 2.1.0's, every figure invented and every account a placeholder. A stream's
  // figures come at the replay's steps (`gateway.step`), so a picture can be taken between them.

  /** The client's clock in a watch test: its n-th reading is n, so `pnl_at` counts P&L messages. */
  let readings = 0;

  async function watching(conversation: string | Conversation, requestTimeoutMs = 1500) {
    gateway = await startFakeGateway(0, { conversation });
    readings = 0;
    client = new IbkrClient({
      host: "127.0.0.1", port: gateway.port, clientId: 31419, requestTimeoutMs,
      now: () => ++readings,
    });
    return client;
  }

  /** Send step `n`, and wait until the client has read it: every step ends with the account's P&L,
   *  and the client reads its clock once for each. */
  async function step(n: number): Promise<void> {
    await gateway!.step(n);
    await waitFor(() => readings >= gateway!.written.filter((m) => m[0] === "94").length);
  }

  /** What the client sent that is a watch's: the account subscription and the P&L requests. */
  const watchMessages = (g: FakeGateway) =>
    g.received.filter((f) => ["6", "92", "93", "94", "95"].includes(f[0]!));

  it("starts on the download's picture: the account masked, its P&L not yet spoken", async () => {
    const c = await watching("watch-started-and-stopped");
    const watch = await c.watchAccount();
    const first = watch.picture();
    expect(first).toMatchObject({
      account: "U•••••000", paper: false, base_currency: "USD", updated_at: "14:32",
      totals: { net_liquidation: 67431.55, total_cash: 53510.55 }, pnl: null, pnl_at: null,
    });
    // the call the download carries at a position of zero, closed today, is left out (review round
    // 1 of #479): a holding at zero leaves the picture, at the first download as at any update
    expect(first.holdings.map((h) => [h.symbol, h.sec_type, h.market_value, h.daily_pnl]))
      .toEqual([["ACME", "STK", 12381, null], ["ACME", "OPT", 1540, null]]);
    expect(watch.lost).toBeNull();
  });

  it("subscribes to the account and its P&L, then to each holding's by its conId", async () => {
    const c = await watching("watch-started-and-stopped");
    await c.watchAccount();
    await waitFor(() => watchMessages(gateway!).length >= 4);
    expect(watchMessages(gateway!)).toEqual([
      ["6", "2", "1", "U0000000"], ["92", "1", "U0000000", ""],
      ["94", "2", "U0000000", "", "100000101"], ["94", "3", "U0000000", "", "100000201"],
    ]);
  });

  it("holds the latest picture: the account's P&L and each holding's, its value and mark", async () => {
    const c = await watching("watch-started-and-stopped");
    const watch = await c.watchAccount();
    await step(1);
    expect(watch.picture()).toMatchObject({
      pnl: { daily_pnl: 152.4, unrealized_pnl: 1436.5, realized_pnl: 120 }, pnl_at: 1,
      // the totals stay the account updates': IBKR pushes those on its own clock
      totals: { net_liquidation: 67431.55, unrealized_pnl: 1436.5 },
    });
    await step(2);
    const [stock, call] = watch.picture().holdings;
    // the stock's mark is its stream's value over its position: 12396 / 300
    expect(stock).toMatchObject({ market_value: 12396, market_price: 41.32, unrealized_pnl: 961.5,
      daily_pnl: 111 });
    // the call's stream spoke once, at the first step: its mark per share, the multiplier out
    expect(call).toMatchObject({ market_value: 1540, market_price: 3.85, daily_pnl: 56.4 });
    expect(watch.picture()).toMatchObject({ pnl: { daily_pnl: 167.4 }, pnl_at: 2 });
  });

  it("hands out a copy, which the caller may keep and change", async () => {
    const c = await watching("watch-started-and-stopped");
    const watch = await c.watchAccount();
    await step(1);
    const kept = watch.picture();
    kept.holdings[0]!.market_value = 0;
    kept.pnl!.daily_pnl = 0;
    kept.totals.net_liquidation = 0;
    expect(watch.picture()).toMatchObject({
      pnl: { daily_pnl: 152.4 }, totals: { net_liquidation: 67431.55 },
    });
    expect(watch.picture().holdings[0]!.market_value).toBe(12381);
  });

  it("follows a holding that appears, and stops one whose position goes to zero", async () => {
    const c = await watching("watch-holdings-come-and-go");
    const watch = await c.watchAccount();
    const held = () => watch.picture().holdings.map((h) => [h.symbol, h.sec_type, h.position]);
    expect(held()).toEqual([["ACME", "STK", 300], ["ACME", "OPT", -6]]);
    await step(1);
    expect(held()).toEqual([["ACME", "STK", 300], ["ACME", "OPT", -6], ["GLOBEX", "STK", 120]]);
    expect(watch.picture().updated_at).toBe("14:35");
    await step(2);
    expect(held()).toEqual([["ACME", "STK", 300], ["GLOBEX", "STK", 120]]);
    expect(watch.picture().holdings[1]).toMatchObject({ market_value: 10446, daily_pnl: -12 });
    await step(3);
    await watch.stop();
    await waitFor(() => watchMessages(gateway!).some((f) => f[0] === "6" && f[2] === "0"));
    expect(watchMessages(gateway!)).toEqual([
      ["6", "2", "1", "U0000000"], ["92", "1", "U0000000", ""],
      ["94", "2", "U0000000", "", "100000101"], ["94", "3", "U0000000", "", "100000202"],
      ["94", "4", "U0000000", "", "100000102"], ["95", "3"],
      ["95", "2"], ["95", "4"], ["93", "1"], ["6", "2", "0", "U0000000"],
    ]);
  });

  it("stops with the cancels, then the unsubscribe, once however often it is asked", async () => {
    const c = await watching("watch-started-and-stopped");
    const watch = await c.watchAccount();
    await step(1);
    await watch.stop();
    await watch.stop();
    await waitFor(() => watchMessages(gateway!).some((f) => f[0] === "6" && f[2] === "0"));
    expect(watchMessages(gateway!).slice(4)).toEqual([
      ["95", "2"], ["95", "3"], ["93", "1"], ["6", "2", "0", "U0000000"],
    ]);
    // stopped is not lost, and the picture is the last one
    expect(watch.lost).toBeNull();
    expect(watch.picture()).toMatchObject({ pnl: { daily_pnl: 152.4 } });
  });

  it("hears nothing more once stopped, and a new watch may start", async () => {
    const c = await watching("watch-started-and-stopped");
    const watch = await c.watchAccount();
    await step(1);
    await watch.stop();
    await gateway!.step(2);
    await new Promise((r) => setTimeout(r, 50));
    expect(watch.picture()).toMatchObject({ pnl: { daily_pnl: 152.4 }, pnl_at: 1 });
    const again = await c.watchAccount();
    expect(again.picture()).toMatchObject({ account: "U•••••000", pnl: null });
  });

  it("says at once that it is lost when the gateway's connection drops, and keeps its picture", async () => {
    const c = await watching("watch-lost");
    const watch = await c.watchAccount();
    await step(1);
    const told: Error[] = [];
    watch.onLost((err) => told.push(err));
    const sentBefore = gateway!.received.length;
    gateway!.dropConnections();
    await waitFor(() => watch.lost !== null);
    expect(watch.lost!.message).toBe("IB Gateway's connection closed under the account watch");
    expect(told).toEqual([watch.lost]);
    expect(watch.picture()).toMatchObject({ pnl: { daily_pnl: -33 }, pnl_at: 1 });
    // a listener added once it is lost is told at once; stopping it sends nothing
    const late: Error[] = [];
    watch.onLost((err) => late.push(err));
    expect(late).toEqual([watch.lost]);
    await watch.stop();
    expect(gateway!.received.length).toBe(sentBefore);
  });

  it("is lost when the client is closed under it", async () => {
    const c = await watching("watch-lost");
    const watch = await c.watchAccount();
    const told: Error[] = [];
    watch.onLost((err) => told.push(err));
    c.close();
    expect(told.map((e) => e.message)).toEqual(["IB Gateway's connection closed under the account watch"]);
  });

  it("is lost when a price read fails and drops the connection it shares", async () => {
    // the price read tears its connection down so the next one reconnects; the watch was on it
    const c = await watching("watch-lost", 300);
    const watch = await c.watchAccount();
    await expect(c.fetchQuotes([OPTION])).rejects.toThrow(/answered none/);
    expect(watch.lost?.message).toBe("IB Gateway's connection closed under the account watch");
  });

  it("reads a figure IB has not set, and an empty one, as none — keeping the row's", async () => {
    const c = await watching("watch-unset-figures");
    const watch = await c.watchAccount();
    await step(1);
    const one = watch.picture();
    expect(one.pnl).toEqual({ daily_pnl: null, unrealized_pnl: 1436.5, realized_pnl: 0 });
    expect(one.holdings[0]).toMatchObject({ daily_pnl: null, market_value: 12381 });
    // the call's value and unrealised P&L unset: the account update's stand
    expect(one.holdings[1]).toMatchObject({ market_value: 1540, market_price: 3.85,
      unrealized_pnl: 490, daily_pnl: null });
    await step(2);
    expect(watch.picture().pnl).toEqual({ daily_pnl: null, unrealized_pnl: 1436.5, realized_pnl: null });
  });

  it("refuses as the account read does, every id masked, and subscribes to nothing", async () => {
    const c = await watching("watch-several");
    const err = await c.watchAccount().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IbkrAccountRefused);
    expect((err as Error).message)
      .toBe("several accounts on this login; set IBKR_ACCOUNT to one of U•••••000, U•••••001");
    await expect(c.watchAccount("DU0000001")).rejects.toThrow(new IbkrAccountRefused(
      "IBKR_ACCOUNT (DU•••••001) names no account on this login, which has U•••••000, U•••••001"));
    expect(watchMessages(gateway!)).toEqual([]);
    expect(await c.watchAccount("U0000001").then((w) => w.picture().account)).toBe("U•••••001");
  });

  it("fails at the read's deadline, in its words, and cancels and unsubscribes on the way out", async () => {
    const c = await watching("watch-never-ends", 300);
    await expect(c.watchAccount()).rejects.toThrow(
      "IB Gateway did not finish sending the account within 300ms — its link to IBKR may be "
      + "down while its own socket is still open");
    await waitFor(() => watchMessages(gateway!).length >= 4);
    expect(watchMessages(gateway!)).toEqual([
      ["6", "2", "1", "U0000000"], ["92", "1", "U0000000", ""], ["93", "1"],
      ["6", "2", "0", "U0000000"],
    ]);
  });

  it("fails in the read's words where the connection closes before the first picture", async () => {
    const c = await watching("watch-never-ends", 5000);
    const start = c.watchAccount();
    await waitFor(() => watchMessages(gateway!).length >= 2);
    gateway!.dropConnections();
    await expect(start).rejects.toThrow("IB Gateway's connection closed during the account read");
  });

  it("throws IbkrUnreachable, in the connect's own words, where the session is refused", async () => {
    const c = await watching("client-id-in-use");
    const err = await c.watchAccount().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IbkrUnreachable);
    expect((err as Error).message).toMatch(/^IB Gateway refused the session: 326 /);
  });

  it("waits for a bounded read that is running: IB allows one account subscription", async () => {
    const c = await watching("watch-started-and-stopped");
    const [read, watch] = await Promise.all([c.account(), c.watchAccount()]);
    expect(read.account).toBe("U•••••000");
    expect(watch.picture().account).toBe("U•••••000");
    expect(watchMessages(gateway!).slice(0, 3)).toEqual([
      ["6", "2", "1", "U0000000"], ["6", "2", "0", "U0000000"], ["6", "2", "1", "U0000000"],
    ]);
  });

  it("answers a bounded read of the watched account from the watch, sending nothing", async () => {
    // a subscribe and an unsubscribe of its own would end the watch's subscription
    const c = await watching("watch-started-and-stopped");
    const watch = await c.watchAccount();
    await step(1);
    const before = watchMessages(gateway!).length;
    const read = await c.account();
    expect(watchMessages(gateway!).length).toBe(before);
    expect(read).not.toHaveProperty("pnl");
    expect(read.holdings[0]).not.toHaveProperty("daily_pnl");
    expect(read.holdings[0]).toMatchObject({ market_value: 12381 });
    expect(read.totals).toEqual(watch.picture().totals);
  });

  it("holds a bounded read begun during a watch's start until the start, and sends nothing of its own", async () => {
    // review round 1 of #479: answered before the download ended, it would be an empty account
    const c = await watching("watch-started-and-stopped");
    const [watch, read] = await Promise.all([c.watchAccount(), c.account()]);
    expect(read.holdings.map((h) => h.symbol)).toEqual(["ACME", "ACME"]);
    expect(read.totals).toEqual(watch.picture().totals);
    expect(watchMessages(gateway!).filter((f) => f[0] === "6")).toEqual([["6", "2", "1", "U0000000"]]);
  });

  it("logs a lost listener that throws, and still tells the others", async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    try {
      const c = await watching("watch-lost");
      const watch = await c.watchAccount();
      const told: string[] = [];
      watch.onLost(() => { throw new Error("a listener's own fault"); });
      watch.onLost((err) => told.push(err.message));
      c.close();
      expect(told).toEqual(["IB Gateway's connection closed under the account watch"]);
      expect(errors).toEqual([expect.stringContaining("a listener's own fault")]);
    } finally {
      spy.mockRestore();
    }
  });

  it("refuses a second watch, and a bounded read of another account, while one is held", async () => {
    const c = await watching("watch-several");
    await c.watchAccount("U0000001");
    await expect(c.watchAccount("U0000001")).rejects
      .toThrow("this client already holds a watch of U•••••001; stop it first");
    await expect(c.account("U0000000")).rejects
      .toThrow("IB Gateway's one account subscription is held by a watch of U•••••001; stop it first");
  });

  it("never writes an account id in full: not in a picture, an error, or a log line", async () => {
    const said: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        said.push(args.map(String).join(" "));
      }));
    try {
      for (const [name, wanted] of [
        ["watch-started-and-stopped", undefined], ["watch-several", undefined],
        ["watch-several", "DU0000001"], ["watch-several", "U0000001"], ["watch-never-ends", undefined],
        ["watch-lost", undefined],
      ] as const) {
        const c = await watching(name, 300);
        said.push(await c.watchAccount(wanted).then(async (w) => {
          await gateway!.step(1);
          gateway!.dropConnections();
          await waitFor(() => w.lost !== null);
          return JSON.stringify(w.picture()) + w.lost!.message;
        }, (e: Error) => e.message));
        c.close();
        await gateway!.close();
        gateway = null;
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(said.length).toBeGreaterThanOrEqual(6);
    for (const id of PLACEHOLDER_ACCOUNTS) {
      expect(said.filter((line) => line.includes(id)), id).toEqual([]);
    }
  });
});
