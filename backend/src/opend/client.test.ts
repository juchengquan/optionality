/** The OpenD client's connection and failure behaviour (ADR 0009, phase 6).
 *
 *  Against a fake, never the real gateway: a test that reaches a real OpenD blocks indefinitely when
 *  it is down, so a missing fake looks like a hung suite rather than a failure (CLAUDE.md). This
 *  used to point at a `diff-opend` target as the live check; it went with the Python it compared
 *  against (#145), and nothing in `make check` has reached a gateway since.
 */
import { describe, expect, it } from "vitest";

import { OpendClient } from "./client.ts";
import type { MoomooClient, SnapshotResponse } from "./types.ts";

interface Script {
  loginOk?: boolean;
  /** rejects the request with the library's own shape: a PLAIN OBJECT, not an Error. This is what
   *  the real moomoo-api does on any retType != 0 — measured against the live gateway on
   *  2026-10-28 — and modelling it as a resolved `{retType: -1}` is what hid #175. */
  rejectWith?: (codes: string[]) => unknown;
  /** never calls onlogin at all */
  loginSilent?: boolean;
  /** accepts the request and never answers it, as a logged-in OpenD that has gone quiet does */
  respondSilent?: boolean;
  respond?: (codes: string[]) => SnapshotResponse | Promise<SnapshotResponse>;
}

class FakeMoomoo implements MoomooClient {
  onlogin?: (ok: boolean, msg: unknown) => void;
  /** the inner connection the real library keeps, and the only thing that can hang it up */
  websock: { close: () => void };
  started: { host: string; port: number; key: string }[] = [];
  stopped = 0;
  asked: string[][] = [];

  private readonly script: Script;
  private readonly shared: Shared;

  // written out, not a parameter property: those are legal here because vitest transforms the file,
  // and illegal in src/ because Node only erases types. One habit is better than two.
  constructor(script: Script, shared: Shared) {
    this.script = script;
    this.shared = shared;
    shared.creates += 1;
    this.websock = { close: () => { shared.hangups += 1; } };
  }

  start(host: string, port: number, _ssl: boolean, key: string): void {
    this.started.push({ host, port, key });
    this.shared.starts += 1;
    if (this.script.loginSilent) return;
    // asynchronously, as the real library does
    setTimeout(() => this.onlogin?.(this.script.loginOk ?? true, "Succeed"), 0);
  }

  async GetSecuritySnapshot(req: { c2s: { securityList: { code: string }[] } }): Promise<SnapshotResponse> {
    const codes = req.c2s.securityList.map((s) => s.code);
    this.asked.push(codes);
    this.shared.asked.push(codes);
    if (this.script.respondSilent) return new Promise<SnapshotResponse>(() => { /* never */ });
    if (this.script.rejectWith) {
      const reason = this.script.rejectWith(codes);
      if (reason !== undefined) return Promise.reject(reason);
    }
    const respond = this.script.respond
      ?? ((cs: string[]) => ({
        retType: 0,
        s2c: { snapshotList: cs.map((code) => ({ basic: { security: { market: 11, code } } })) },
      }));
    return respond(codes);
  }

  /** As the real one: it unregisters a push callback and does NOT close the socket. */
  stop(): void {
    this.stopped += 1;
    this.shared.stops += 1;
  }
}

interface Shared {
  starts: number;
  stops: number;
  asked: string[][];
  /** how many client OBJECTS were made. The library leaks a socket per object (see client.ts). */
  creates: number;
  /** how many times the inner socket was actually hung up */
  hangups: number;
}

function harness(script: Script = {}) {
  const shared: Shared = { starts: 0, stops: 0, asked: [], creates: 0, hangups: 0 };
  const client = new OpendClient({
    host: "127.0.0.1", port: 33333, key: "abc", loginTimeoutMs: 50, requestTimeoutMs: 50,
    create: () => new FakeMoomoo(script, shared),
  });
  return { client, shared };
}

describe("connecting", () => {
  it("logs in once and keeps the connection across calls", async () => {
    // over TCP the Python opens and closes per call; over WebSocket that is a keyed handshake every
    // sweep, for ever
    const { client, shared } = harness();
    await client.snapshot(["US.SPXW261030C8100000"]);
    await client.snapshot(["US.SPXW261030C8100000"]);
    expect(shared.starts).toBe(1);
  });

  it("logs in once even when two callers arrive together", async () => {
    // the sweep and a creation probe can overlap, and two logins on one key is a way to be
    // disconnected
    const { client, shared } = harness();
    await Promise.all([
      client.snapshot(["US.SPXW261030C8100000"]),
      client.snapshot(["US.SPXW261030C8125000"]),
    ]);
    expect(shared.starts).toBe(1);
  });

  it("refuses to try at all without a key", async () => {
    const client = new OpendClient({ host: "127.0.0.1", port: 33333, key: "" });
    await expect(client.snapshot(["US.X"])).rejects.toThrow(/key is not configured/);
  });

  it("fails with a reason when the login is refused", async () => {
    const { client } = harness({ loginOk: false });
    await expect(client.snapshot(["US.X"])).rejects.toThrow(/login refused/);
  });

  it("gives up rather than hanging when the login never answers", async () => {
    // OpenD can accept the socket and say nothing. A sweep that waits for ever is worse than one
    // that fails: the watchdog never counts a failure it is still waiting for.
    const { client } = harness({ loginSilent: true });
    await expect(client.snapshot(["US.X"])).rejects.toThrow(/timed out/);
  });

  it("tries again on the next call after a failure", async () => {
    let refuse = true;
    const shared: Shared = { starts: 0, stops: 0, asked: [], creates: 0, hangups: 0 };
    const client = new OpendClient({
      host: "h", port: 1, key: "k", loginTimeoutMs: 50,
      create: () => new FakeMoomoo({ get loginOk() { return !refuse; } }, shared),
    });
    await expect(client.snapshot(["US.X"])).rejects.toThrow();
    refuse = false;
    await expect(client.snapshot(["US.X"])).resolves.toHaveLength(1);
    expect(shared.starts).toBe(2);
  });
});

describe("asking", () => {
  it("strips the market prefix on the way out and puts it back on the way in", async () => {
    const { client, shared } = harness();
    const records = await client.snapshot(["US.SPXW261030C8100000"]);
    expect(shared.asked).toEqual([["SPXW261030C8100000"]]);
    expect(records[0]!.code).toBe("US.SPXW261030C8100000");
  });

  it("sends the whole batch in one call", async () => {
    // one batched call per sweep is the invariant the dashboard's single instant depends on
    const { client, shared } = harness();
    await client.snapshot(["US.A", "US.B", "US.C"]);
    expect(shared.asked).toEqual([["A", "B", "C"]]);
  });

  it("asks nothing at all for an empty batch", async () => {
    const { client, shared } = harness();
    expect(await client.snapshot([])).toEqual([]);
    expect(shared.starts).toBe(0);
  });
});

describe("failing", () => {
  it("keeps the wording its own containment reads", async () => {
    // moomoo names the unknown contract in retMsg, and `batch` below reads that name to drop the
    // culprit and retry. The "snapshot API failed:" prefix is the Python's.
    const { client } = harness({
      respond: () => ({ retType: -1, retMsg: "Unknown stock. SPXW261030C99999000" }),
    });
    await expect(client.snapshot(["US.SPXW261030C99999000"]))
      .rejects.toThrow(/^snapshot API failed: Unknown stock\. SPXW261030C99999000$/);
  });

  it("reads retMsg out of the library's own rejection, which is not an Error", async () => {
    // The library REJECTS with `{retType, retMsg, errCode}` rather than resolving it, and a plain
    // object is not an Error — so this arrived as `snapshot API failed: [object Object]`, with
    // moomoo's sentence thrown away. Measured against the live gateway on 2026-10-28, where every
    // refusal read that way.
    const { client } = harness({
      rejectWith: () => ({ retType: -1, retMsg: "Unknown stock. SPXW261030C99999000", errCode: 0 }),
    });
    await expect(client.snapshot(["US.SPXW261030C99999000"]))
      .rejects.toThrow(/^snapshot API failed: Unknown stock\. SPXW261030C99999000$/);
  });

  it("keeps an errCode the message does not already carry", async () => {
    const { client } = harness({
      rejectWith: () => ({ retType: -1, retMsg: "quota exceeded", errCode: 429 }),
    });
    await expect(client.snapshot(["US.X"])).rejects.toThrow(/quota exceeded \(errCode 429\)/);
  });

  it("falls back to the whole object when a rejection carries no message at all", async () => {
    // never silently empty: an unrecognised rejection shape must still say what it was
    const { client } = harness({ rejectWith: () => ({ weird: true }) });
    await expect(client.snapshot(["US.X"])).rejects.toThrow(/\{"weird":true\}/);
  });

  it("says something useful when retType is bad and there is no message", async () => {
    const { client } = harness({ respond: () => ({ retType: -1 }) });
    await expect(client.snapshot(["US.X"])).rejects.toThrow(/retType -1/);
  });

  it("drops the connection on any failure, so the next call reconnects", async () => {
    // a socket that has quietly died must produce a failed sweep and a visible last_sweep_ok: false,
    // not a silent stream of empty batches
    let fail = true;
    const shared: Shared = { starts: 0, stops: 0, asked: [], creates: 0, hangups: 0 };
    const client = new OpendClient({
      host: "h", port: 1, key: "k", loginTimeoutMs: 50,
      create: () => new FakeMoomoo({
        respond: () => {
          if (fail) throw new Error("socket closed");
          return { retType: 0, s2c: { snapshotList: [] } };
        },
      }, shared),
    });
    await expect(client.snapshot(["US.X"])).rejects.toThrow(/snapshot API failed: socket closed/);
    expect(shared.stops).toBe(1);
    fail = false;
    await client.snapshot(["US.X"]);
    expect(shared.starts).toBe(2);
  });

  it("gives up rather than hanging when the request never answers", async () => {
    // What happened on 2026-10-16. The login half was already bounded; this half was not, so a
    // logged-in OpenD that stopped answering left the await unsettled for ever. The sweep never
    // threw, so nothing counted a failure and /health went on reporting "active" while the alarm
    // engine was dead.
    const { client } = harness({ respondSilent: true });
    await expect(client.snapshot(["US.X"])).rejects.toThrow(/request timed out after 50ms/);
  });

  it("drops the connection when a request times out, so the next call reconnects", async () => {
    // the timed-out request may still be in flight on a socket we have stopped listening to; the
    // next caller must not inherit it
    let silent = true;
    const shared: Shared = { starts: 0, stops: 0, asked: [], creates: 0, hangups: 0 };
    const client = new OpendClient({
      host: "h", port: 1, key: "k", loginTimeoutMs: 50, requestTimeoutMs: 50,
      create: () => new FakeMoomoo({ get respondSilent() { return silent; } }, shared),
    });
    await expect(client.snapshot(["US.X"])).rejects.toThrow(/timed out/);
    expect(shared.stops).toBe(1);
    silent = false;
    await client.snapshot(["US.X"]);
    expect(shared.starts).toBe(2);
  });

  it("hangs up the socket on failure, rather than leaving it to reconnect", async () => {
    // The library's stop() only unregisters a push callback — it does not close anything, and the
    // base class re-opens the socket every 1000ms for ever. Measured on 2026-10-16: 37 ESTABLISHED
    // connections from one process to OpenD, and 10,794 login/disconnect cycles in its log.
    const { client, shared } = harness({ respond: () => { throw new Error("socket closed"); } });
    await expect(client.snapshot(["US.X"])).rejects.toThrow();
    expect(shared.hangups).toBe(1);
  });

  it("reuses one client object, because a fresh one orphans the old socket", async () => {
    // The library closes the previous socket itself when start() is called again on the SAME
    // object (main.js: start -> websock.close()). Making a new object instead is what leaks.
    let fail = true;
    const shared: Shared = { starts: 0, stops: 0, asked: [], creates: 0, hangups: 0 };
    const client = new OpendClient({
      host: "h", port: 1, key: "k", loginTimeoutMs: 50, requestTimeoutMs: 50,
      create: () => new FakeMoomoo({
        respond: () => {
          if (fail) throw new Error("socket closed");
          return { retType: 0, s2c: { snapshotList: [] } };
        },
      }, shared),
    });
    await expect(client.snapshot(["US.X"])).rejects.toThrow();
    fail = false;
    await client.snapshot(["US.X"]);
    expect(shared.starts).toBe(2);     // logged in again
    expect(shared.creates).toBe(1);    // on the same object
  });

  it("returns an empty list, not an error, when the batch comes back empty", async () => {
    // /spx/quote turns that into a 404 and the sweep into "no complete value"; both are decisions
    // for the caller
    const { client } = harness({ respond: () => ({ retType: 0, s2c: {} }) });
    expect(await client.snapshot(["US.X"])).toEqual([]);
  });
});

describe("as a fetcher", () => {
  it("is the port the rest of the service already takes", async () => {
    const { client } = harness();
    const fetch = client.asFetcher();
    expect((await fetch(["US.SPXW261030C8100000"])).records[0]!.code).toBe("US.SPXW261030C8100000");
  });
});

describe("containment: the vendor's error prose is the vendor's own business", () => {
  /** This moved here from `fetchResilient` (#168). moomoo rejects the WHOLE batch when any code is
   *  unknown and names the culprit in its error text; reading that text is how one bad contract is
   *  kept from taking the watchlist hostage. It belongs to the client because it IS moomoo's
   *  grammar — a second Provider reports a contract it cannot resolve in entirely different terms,
   *  and the port above now carries the answer rather than the sentence (ADR 0015).
   */
  const POISON = "US.SPXW261030C99999000";
  const GOOD = "US.SPXW261030C8100000";

  /** Rejects the batch while it contains the poison, naming it WITHOUT its market prefix, as the
   *  real OpenD does. */
  const poisonous = (): Script => ({
    respond: (codes) => (codes.includes(POISON.slice(3))
      ? { retType: -1, retMsg: `Unknown stock. ${POISON.slice(3)}` }
      : {
        retType: 0,
        s2c: { snapshotList: codes.map((code) => ({ basic: { security: { market: 11, code } } })) },
      }),
  });

  /** The same poison, refused the way the real library refuses: by REJECTING with the plain
   *  object. This is the shape that was live, and the one containment never faced. */
  const poisonousForReal = (): Script => ({
    rejectWith: (codes) => (codes.includes(POISON.slice(3))
      ? { retType: -1, retMsg: `Unknown stock. ${POISON.slice(3)}`, errCode: 0 }
      : undefined),
    respond: (codes) => ({
      retType: 0,
      s2c: { snapshotList: codes.map((code) => ({ basic: { security: { market: 11, code } } })) },
    }),
  });

  it("contains a culprit the library REJECTED rather than reported", async () => {
    // #175, found by asking the live gateway for a contract it does not have: one unknown code
    // took the whole watchlist's sweep down, because the culprit's name never survived into the
    // message the containment reads. Every alarm stops, for one dead contract.
    const { client, shared } = harness(poisonousForReal());

    const batch = await client.batch([POISON, GOOD]);

    expect(batch.unknown).toEqual([POISON]);
    expect(batch.records.map((r) => r.code)).toEqual([GOOD]);
    expect(shared.asked).toHaveLength(2);
  });

  it("drops the culprit, retries, and reports it as unknown", async () => {
    const { client, shared } = harness(poisonous());

    const batch = await client.batch([POISON, GOOD]);

    expect(batch.unknown).toEqual([POISON]);
    expect(batch.records.map((r) => r.code)).toEqual([GOOD]);
    // two calls: the rejected batch and the retry without the culprit
    expect(shared.asked).toHaveLength(2);
  });

  it("names the code in OUR spelling, not moomoo's", async () => {
    // moomoo answers with the bare code; everything downstream — the quarantine, the dashboard's
    // error badge, position_samples — is keyed by `US.`-prefixed codes
    const { client } = harness(poisonous());
    expect((await client.batch([POISON])).unknown).toEqual([POISON]);
  });

  it("gives back an empty batch rather than nothing when every code is unknown", async () => {
    const { client } = harness(poisonous());
    expect(await client.batch([POISON])).toEqual({ records: [], unknown: [POISON] });
  });

  it("re-throws anything that is not a named culprit, so an outage stays an outage", async () => {
    // retrying a connection failure one code at a time would present an outage as a watchlist
    // full of unknown contracts
    const { client } = harness({ respond: () => ({ retType: -1, retMsg: "Client connection failed!" }) });
    await expect(client.batch([GOOD])).rejects.toThrow(/Client connection failed/);
  });

  it("re-throws a culprit it cannot map to a code it asked for", async () => {
    const { client } = harness({ respond: () => ({ retType: -1, retMsg: "Unknown stock. ZZ.NOTOURS" }) });
    await expect(client.batch([GOOD])).rejects.toThrow(/ZZ\.NOTOURS/);
  });

  it("asks nothing and reports nothing for an empty batch", async () => {
    const { client, shared } = harness();
    expect(await client.batch([])).toEqual({ records: [], unknown: [] });
    expect(shared.starts).toBe(0);
  });

  it("is what asFetcher hands the service", async () => {
    const { client } = harness(poisonous());
    const batch = await client.asFetcher()([POISON, GOOD]);
    expect(batch.unknown).toEqual([POISON]);
    expect(batch.records.map((r) => r.code)).toEqual([GOOD]);
  });
});
