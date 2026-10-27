/** The IBKR client against a stub gateway (ADR 0015, PR 5 of the plan).
 *
 *  Nobody here has an account, so every one of these drives a stub `fetch` — the way the bot tests
 *  drive a fake Telegram and the OpenD tests drive a fake websocket client. What that proves is
 *  the SHAPE of this client: how many calls a sweep costs, that one unknown contract cannot take
 *  the watchlist hostage, that a dead session reads as an outage rather than as a watchlist of
 *  unknown contracts.
 *
 *  What it CANNOT prove is listed in the module header and in PR 6: whether greeks arrive on the
 *  owner's entitlements, what the pre-flight really costs, what a dead session really answers, and
 *  whether the figures agree with moomoo's on the same contract at the same instant. A green suite
 *  here is not first contact, and this file does not pretend otherwise.
 */
import { describe, expect, it, vi } from "vitest";

import { IbkrClient } from "./client.ts";

const CALL = "US.SPXW261030C8100000";
const PUT = "US.SPXW261030P7900000";

interface Script {
  /** one entry per snapshot request, in order; the last is repeated */
  snapshots?: unknown[][];
  status?: Record<string, number>;
  authenticated?: boolean;
  connected?: boolean;
}

/** A gateway that answers the four endpoints this client knows, and records every path. */
function gateway(script: Script = {}) {
  const paths: string[] = [];
  let snapshots = 0;
  const fetch = async (url: string | URL, init?: { method?: string }) => {
    const path = String(url).replace("https://gw:5000/v1/api", "");
    paths.push(`${init?.method ?? "GET"} ${path}`);
    const status = script.status?.[path.split("?")[0]!] ?? 200;
    const body = (() => {
      if (path.startsWith("/iserver/secdef/search")) {
        return [{ conid: 416904, symbol: "SPX" }];
      }
      if (path.startsWith("/iserver/secdef/info")) {
        const strike = new URL(`http://x${path}`).searchParams.get("strike");
        return [{
          conid: strike === "8100" ? 712345 : 712346, maturityDate: "20261030",
          tradingClass: "SPXW", multiplier: "100",
        }];
      }
      if (path.startsWith("/iserver/marketdata/snapshot")) {
        const which = Math.min(snapshots, (script.snapshots?.length ?? 1) - 1);
        snapshots += 1;
        return script.snapshots?.[which] ?? [{ conid: 712345, "84": "4.30", "86": "4.70" }];
      }
      if (path === "/iserver/auth/status") {
        return { authenticated: script.authenticated ?? true, connected: script.connected ?? true };
      }
      return {};
    })();
    return {
      ok: status >= 200 && status < 300, status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response;
  };
  return { fetch: fetch as unknown as typeof globalThis.fetch, paths, snapshotCount: () => snapshots };
}

function client(script: Script = {}, over: Record<string, unknown> = {}) {
  const gw = gateway(script);
  return {
    gw,
    client: new IbkrClient({
      baseUrl: "https://gw:5000/v1/api", fetch: gw.fetch,
      // off unless a test is about it: an interval that outlives the test leaks into the next
      tickleEverySeconds: 0, emptyRetryMs: 0, ...over,
    }),
  };
}

describe("one batch", () => {
  it("asks for every contract in a single snapshot call", async () => {
    // the ratified invariant: every call to the Provider is a single bounded one (CLAUDE.md).
    // Twelve contracts sit well inside the endpoint's 100-conid limit.
    const { client: ibkr, gw } = client();
    const batch = await ibkr.batch([CALL, PUT]);
    const snaps = gw.paths.filter((p) => p.includes("marketdata/snapshot"));
    expect(snaps.length).toBe(1);
    expect(snaps[0]).toContain("conids=712345,712346");
    expect(batch.unknown).toEqual([]);
  });

  it("asks the gateway nothing at all for an empty batch", async () => {
    const { client: ibkr, gw } = client();
    expect(await ibkr.batch([])).toEqual({ records: [], unknown: [] });
    expect(gw.paths).toEqual([]);
  });

  it("pre-flights once, before the first snapshot and not again", async () => {
    // the reference says /iserver/accounts must be called before market data, and a secdef
    // search before any derivative. Both happen here; how much they really cost is PR 6.
    const { client: ibkr, gw } = client();
    await ibkr.batch([CALL]);
    await ibkr.batch([CALL]);
    const accounts = gw.paths.filter((p) => p.includes("/iserver/accounts"));
    expect(accounts.length).toBe(1);
    expect(gw.paths.indexOf(accounts[0]!)).toBeLessThan(
      gw.paths.findIndex((p) => p.includes("marketdata/snapshot")),
    );
  });

  it("names the figures by the service's keys, not the gateway's numbers", async () => {
    const { client: ibkr } = client({
      snapshots: [[{ conid: 712345, "84": "4.30", "86": "4.70", "7308": "0.17" }]],
    });
    const { records } = await ibkr.batch([CALL]);
    expect(records).toEqual([{
      code: CALL, bid_price: 4.3, ask_price: 4.7, mid_price: 4.5, option_delta: 0.17,
      name: "SPXW 261030 8100.00C", option_type: "CALL", option_strike_price: 8100,
      option_contract_size: 100,
    }]);
  });

  it("spends no snapshot call when nothing resolved", async () => {
    // a watchlist of codes the gateway cannot place is a quarantine waiting to happen (#167), and
    // asking for quotes on an empty list of conids is a request against the rate budget that can
    // only answer nothing
    const { client: ibkr, gw } = client();
    expect(await ibkr.batch(["US.AAPL", "nonsense"]))
      .toEqual({ records: [], unknown: ["US.AAPL", "nonsense"] });
    expect(gw.paths.filter((p) => p.includes("marketdata/snapshot"))).toEqual([]);
  });

  it("reports a contract with no conid as unknown and prices the rest", async () => {
    // one bad contract cannot take the watchlist hostage — the property moomoo's drop-and-retry
    // loop has (#168), reached here without a retry because resolution is per contract
    const { client: ibkr } = client();
    const { records, unknown } = await ibkr.batch(["US.AAPL", CALL]);
    expect(unknown).toEqual(["US.AAPL"]);
    expect(records.map((r) => r.code)).toEqual([CALL]);
  });
});

describe("the empty first answer", () => {
  it("asks again when the gateway answers with no fields at all", async () => {
    // documented behaviour: the first snapshot for a conid primes the subscription and returns
    // the conid with nothing on it. Without this retry every newly watched contract would read as
    // a silent figure for one sweep.
    const { client: ibkr, gw } = client({
      snapshots: [[{ conid: 712345 }], [{ conid: 712345, "84": "4.30" }]],
    });
    const { records } = await ibkr.batch([CALL]);
    expect(gw.snapshotCount()).toBe(2);
    expect(records[0]!.bid_price).toBe(4.3);
  });

  it("gives up and reports what it has, rather than retrying for ever", async () => {
    // a contract that genuinely has no data must not loop: it reads as a figure that did not
    // arrive, which the sweep counts and quarantines with a notice after N sweeps (#167). That is
    // the designed answer for an entitlement the account does not hold.
    const { client: ibkr, gw } = client({ snapshots: [[{ conid: 712345 }]] });
    const { records, unknown } = await ibkr.batch([CALL]);
    expect(gw.snapshotCount()).toBe(4); // the first, plus three retries
    expect(records).toEqual([]);
    expect(unknown, "no data is not the same as no such contract").toEqual([]);
  });

  it("stops retrying as soon as any contract has a figure", async () => {
    const { client: ibkr, gw } = client({
      snapshots: [[{ conid: 712345, "84": "4.30" }, { conid: 712346 }]],
    });
    const { records } = await ibkr.batch([CALL, PUT]);
    expect(gw.snapshotCount()).toBe(1);
    expect(records.map((r) => r.code)).toEqual([CALL]);
  });
});

describe("when the gateway is not answering", () => {
  it("throws with the status, so a sweep fails visibly", async () => {
    // /health reads the last batch rather than a probe, so this is what makes last_sweep_ok false
    // and paints the top line bad (ADR 0010)
    const { client: ibkr } = client({ status: { "/iserver/marketdata/snapshot": 503 } });
    await expect(ibkr.batch([CALL])).rejects.toThrow(/503/);
  });

  it("throws rather than reporting a watchlist of unknown contracts", async () => {
    // the distinction #168 settled, stated as a test: an outage must never read as nine rules
    // whose contracts do not exist, because that is what gets them quarantined
    const { client: ibkr } = client({ status: { "/iserver/secdef/search": 401 } });
    await expect(ibkr.batch([CALL, PUT])).rejects.toThrow(/401/);
  });

  it("stops waiting, because a gateway may accept a request and never answer it", async () => {
    // what stopped the alarm engine dead on 2026-10-16, on the other provider: nothing bounded
    // the ask. Shorter than the sweep watchdog on purpose — the fetch should fail and be counted.
    const never = (() => new Promise<Response>(() => { /* never */ })) as typeof globalThis.fetch;
    const ibkr = new IbkrClient({
      baseUrl: "https://gw:5000/v1/api", fetch: never, tickleEverySeconds: 0,
      requestTimeoutMs: 10,
    });
    await expect(ibkr.batch([CALL])).rejects.toThrow(/timed out/);
  });

  it("answers reachable from the session, not from a socket that accepts", async () => {
    // the lesson of 2026-10-16 restated for this transport: OpenD held its port open and timed
    // out every login while /health read true. A gateway process with a dead browser session is
    // the same failure, and `authenticated` is the only thing that answers it.
    expect(await client().client.reachable()).toBe(true);
    expect(await client({ authenticated: false }).client.reachable()).toBe(false);
    expect(await client({ connected: false }).client.reachable()).toBe(false);
  });

  it("answers reachable false rather than raising, whatever went wrong", async () => {
    const dead = (() => Promise.reject(new Error("ECONNREFUSED"))) as typeof globalThis.fetch;
    const ibkr = new IbkrClient({ baseUrl: "x", fetch: dead, tickleEverySeconds: 0 });
    expect(await ibkr.reachable()).toBe(false);
  });
});

describe("keeping the session alive", () => {
  it("tickles on its own interval once it has pre-flighted", async () => {
    // the gateway logs a session out for inactivity, and this service asks for data once a minute
    // at most. The tickle is what a 15-second sweep does not need and a quiet overnight does.
    vi.useFakeTimers();
    try {
      const { client: ibkr, gw } = client({}, { tickleEverySeconds: 60 });
      await ibkr.batch([CALL]);
      expect(gw.paths.filter((p) => p === "POST /tickle").length).toBe(0);
      await vi.advanceTimersByTimeAsync(121_000);
      expect(gw.paths.filter((p) => p === "POST /tickle").length).toBe(2);
      ibkr.close();
      await vi.advanceTimersByTimeAsync(121_000);
      expect(gw.paths.filter((p) => p === "POST /tickle").length, "close stops it").toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("survives a tickle the gateway refuses", async () => {
    // a failed keepalive is not the sweep's business: the next fetch fails visibly and /health
    // says so. A throw from a timer callback would take the whole process down (main.ts).
    vi.useFakeTimers();
    try {
      const { client: ibkr } = client({ status: { "/tickle": 500 } }, { tickleEverySeconds: 60 });
      await ibkr.batch([CALL]);
      await vi.advanceTimersByTimeAsync(61_000);
      expect((await ibkr.batch([CALL])).records.length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("pre-flights again after being closed", async () => {
    // close() is the way out of the process and the way out of a session that has gone bad; a
    // client that remembered its pre-flight across one would never redo the handshake
    const { client: ibkr, gw } = client();
    await ibkr.batch([CALL]);
    ibkr.close();
    await ibkr.batch([CALL]);
    expect(gw.paths.filter((p) => p.includes("/iserver/accounts")).length).toBe(2);
  });

  it("keeps the conids it resolved, because a conid does not expire with a session", async () => {
    const { client: ibkr, gw } = client();
    await ibkr.batch([CALL]);
    ibkr.close();
    await ibkr.batch([CALL]);
    expect(gw.paths.filter((p) => p.includes("secdef/info")).length).toBe(1);
  });
});

describe("the port the rest of the service takes", () => {
  it("is the same one-question fetcher every other Provider answers", async () => {
    const { client: ibkr } = client();
    const batch = await ibkr.asFetcher()([CALL]);
    expect(batch.records.map((r) => r.code)).toEqual([CALL]);
  });
});
