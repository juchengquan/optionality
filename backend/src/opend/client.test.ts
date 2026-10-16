/** The OpenD client's connection and failure behaviour (ADR 0009, phase 6).
 *
 *  Against a fake, never the real gateway: the live check is `make diff-opend`, and a test that
 *  reaches a real OpenD blocks indefinitely when it is down — a missing fake looks like a hung suite
 *  rather than a failure (CLAUDE.md).
 */
import { describe, expect, it } from "vitest";

import { OpendClient } from "./client.ts";
import type { MoomooClient, SnapshotResponse } from "./types.ts";

interface Script {
  loginOk?: boolean;
  /** never calls onlogin at all */
  loginSilent?: boolean;
  respond?: (codes: string[]) => SnapshotResponse | Promise<SnapshotResponse>;
}

class FakeMoomoo implements MoomooClient {
  onlogin?: (ok: boolean, msg: unknown) => void;
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
    const respond = this.script.respond
      ?? ((cs: string[]) => ({
        retType: 0,
        s2c: { snapshotList: cs.map((code) => ({ basic: { security: { market: 11, code } } })) },
      }));
    return respond(codes);
  }

  stop(): void {
    this.stopped += 1;
    this.shared.stops += 1;
  }
}

interface Shared {
  starts: number;
  stops: number;
  asked: string[][];
}

function harness(script: Script = {}) {
  const shared: Shared = { starts: 0, stops: 0, asked: [] };
  const client = new OpendClient({
    host: "127.0.0.1", port: 33333, key: "abc", loginTimeoutMs: 50,
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
    const shared: Shared = { starts: 0, stops: 0, asked: [] };
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
  it("keeps the wording fetchResilient reads, so containment still works", async () => {
    // moomoo names the unknown contract in retMsg, and fetchResilient reads that name to drop the
    // culprit and retry. The "snapshot API failed:" prefix is the Python's.
    const { client } = harness({
      respond: () => ({ retType: -1, retMsg: "Unknown stock. SPXW261030C99999000" }),
    });
    await expect(client.snapshot(["US.SPXW261030C99999000"]))
      .rejects.toThrow(/^snapshot API failed: Unknown stock\. SPXW261030C99999000$/);
  });

  it("says something useful when retType is bad and there is no message", async () => {
    const { client } = harness({ respond: () => ({ retType: -1 }) });
    await expect(client.snapshot(["US.X"])).rejects.toThrow(/retType -1/);
  });

  it("drops the connection on any failure, so the next call reconnects", async () => {
    // a socket that has quietly died must produce a failed sweep and a visible last_sweep_ok: false,
    // not a silent stream of empty batches
    let fail = true;
    const shared: Shared = { starts: 0, stops: 0, asked: [] };
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
    expect((await fetch(["US.SPXW261030C8100000"]))[0]!.code).toBe("US.SPXW261030C8100000");
  });
});
