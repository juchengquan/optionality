/** IB Gateway's descriptor: the account's watch over the library's client, every way a start ends
 *  sorted for `GET /account` (ADR 0031, #477), and the client's other answers handed on as the
 *  chance for a lost watch to come back. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { IbkrAccountRefused, IbkrClient, IbkrUnreachable } from "optionality/vendors/ibkr/client";
import { type FakeGateway, startFakeGateway } from "optionality/vendors/ibkr/fake";

import { AccountBook, LOST, NOT_ANSWERING } from "../../account.ts";
import { settingsFor } from "../../env.ts";
import type { AccountWatch, IbkrLiveAccount } from "../../ports.ts";
import { accountSource, ibkrVendor } from "./vendor.ts";

const opened: { gateway?: FakeGateway; close?: () => void }[] = [];
afterEach(async () => {
  for (const { gateway, close } of opened.splice(0)) {
    close?.();
    await gateway?.close();
  }
});

const PICTURE: IbkrLiveAccount = {
  account: "U•••••000", paper: false, base_currency: "USD", updated_at: "10:15",
  totals: { net_liquidation: 1000, total_cash: 1000, unrealized_pnl: 0, realized_pnl: 0 },
  exchange_rates: { USD: 1 }, holdings: [], pnl: null, pnl_at: null,
};
const WATCH: AccountWatch = {
  picture: () => PICTURE, lost: null, onLost: () => {}, stop: () => Promise.resolve(),
};

/** A client whose watch answers `outcome`, recording what it was asked. */
function client(outcome: AccountWatch | Error) {
  const asked: (string | undefined)[] = [];
  return {
    asked,
    watchAccount(wanted?: string) {
      asked.push(wanted);
      return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
    },
  };
}

describe("a start of the account's watch", () => {
  it("answers the library's watch, asking for the account named, or none", async () => {
    const c = client(WATCH);
    const { source } = accountSource(c);
    expect(await source.watch("U0000001")).toEqual({ watch: WATCH });
    expect(await source.watch(null)).toEqual({ watch: WATCH });
    expect(c.asked).toEqual(["U0000001", undefined]);
  });

  it("is unreachable, in the connect's own words, where the library had no session", async () => {
    const words = "could not reach IB Gateway at 127.0.0.1:1: connect ECONNREFUSED 127.0.0.1:1";
    expect(await accountSource(client(new IbkrUnreachable(words))).source.watch(null))
      .toEqual({ unreachable: words });
  });

  it("is a refusal, in the library's words, where it would not choose an account", async () => {
    const words = "several accounts on this login; set IBKR_ACCOUNT to one of U•••••000, U•••••001";
    expect(await accountSource(client(new IbkrAccountRefused(words))).source.watch(null))
      .toEqual({ refused: words });
  });

  it("is a failure, in the library's words, where the first picture did not come", async () => {
    const words = "IB Gateway did not finish sending the account within 300ms";
    expect(await accountSource(client(new Error(words))).source.watch(null)).toEqual({ failed: words });
  });
});

describe("a start, through the library's real client", () => {
  // the client against the library's fake gateway, replaying the constructed conversations, so the
  // real watch's starts and refusals are what is sorted
  async function against(conversation: string, requestTimeoutMs = 1000) {
    const gateway = await startFakeGateway(0, { conversation });
    const c = new IbkrClient({
      host: "127.0.0.1", port: gateway.port, clientId: 31419, connectTimeoutMs: 1000, requestTimeoutMs,
    });
    opened.push({ gateway, close: () => c.close() });
    return { source: accountSource(c).source, gateway, client: c };
  }
  const book = (source: ReturnType<typeof accountSource>["source"]) => new AccountBook({
    source, wanted: "", now: () => new Date("2026-11-23T15:00:00.000Z"), displayTz: "", wake: () => () => {},
  });

  it("answers the watch on its first picture, its id masked by the library", async () => {
    const { source } = await against("watch-started-and-stopped");
    const started = await source.watch(null);
    expect(started).toHaveProperty("watch");
    if (!("watch" in started)) return;
    expect(started.watch.picture().account).toBe("U•••••000");
    await started.watch.stop();
  });

  it("is unreachable in the gateway's own words where it refuses the session, and the route says them", async () => {
    const { source } = await against("client-id-in-use");
    expect(await source.watch(null)).toEqual({ unreachable: expect.stringMatching(/^IB Gateway refused the session: 326 /) });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { source: again } = await against("client-id-in-use");
    expect(await book(again).read()).toEqual({ fault: { status: 502, message: expect.stringMatching(
      /^IB Gateway refused the session: 326 Unable to connect as the client id is already in use/) } });
    log.mockRestore();
  });

  it("is unreachable in the connect's own words where nothing listens, and the route says it did not answer", async () => {
    const c = new IbkrClient({ host: "127.0.0.1", port: 1, clientId: 31419, connectTimeoutMs: 500 });
    opened.push({ close: () => c.close() });
    const { source } = accountSource(c);
    expect(await source.watch(null))
      .toEqual({ unreachable: "could not reach IB Gateway at 127.0.0.1:1: connect ECONNREFUSED 127.0.0.1:1" });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await book(source).read()).toEqual({ fault: { status: 502, message: NOT_ANSWERING } });
    expect(log).toHaveBeenCalledWith(
      "IBKR account: could not reach IB Gateway at 127.0.0.1:1: connect ECONNREFUSED 127.0.0.1:1");
    log.mockRestore();
  });

  it("is a failure in the library's words where the first picture does not come by the deadline", async () => {
    const { source } = await against("watch-never-ends", 300);
    expect(await source.watch(null))
      .toEqual({ failed: expect.stringMatching(/did not finish sending the account within 300ms/) });
  });

  it("is a refusal in the library's words where several accounts and none is named", async () => {
    const { source } = await against("watch-several");
    expect(await source.watch(null)).toEqual({
      refused: "several accounts on this login; set IBKR_ACCOUNT to one of U•••••000, U•••••001",
    });
  });

  it("is a failure, and the route's 502 in the library's words, where the client already holds a watch", async () => {
    // the library refuses a second watch with a plain Error, not IbkrAccountRefused: sorted as a
    // start that failed, never a 500 (`account.ts` says when the hold can meet it)
    const { source, client } = await against("watch-started-and-stopped");
    const held = await client.watchAccount();
    const words = "this client already holds a watch of U•••••000; stop it first";
    expect(await source.watch(null)).toEqual({ failed: words });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await book(source).read()).toEqual({ fault: { status: 502, message: words } });
    log.mockRestore();
    await held.stop();
  });

  it("is the route's lost 502 once the real connection closes under a held watch", async () => {
    const { source, gateway } = await against("watch-started-and-stopped");
    const b = book(source);
    expect(await b.read()).toHaveProperty("answer");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    gateway.dropConnections();
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith(expect.stringMatching(/^IBKR account: the watch was lost: /)));
    expect(await b.read()).toEqual({ fault: { status: 502, message: LOST } });
    log.mockRestore();
  });
});

describe("the client answering something else", () => {
  it("tells every listener, and a listener that throws is logged, never the read's failure", () => {
    const { source, answered } = accountSource(client(WATCH));
    const heard: string[] = [];
    source.onAnswered(() => { throw new Error("a bug"); });
    source.onAnswered(() => heard.push("second"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    answered();
    expect(heard).toEqual(["second"]);
    expect(log).toHaveBeenCalledWith("IBKR account: a bug");
    log.mockRestore();
  });
});

describe("the descriptor", () => {
  async function opening(conversation: string) {
    const gateway = await startFakeGateway(0, { conversation });
    const vendor = ibkrVendor.open(settingsFor({ ibkrHost: "127.0.0.1", ibkrPort: gateway.port }))!;
    opened.push({ gateway, close: () => vendor.close() });
    let heard = 0;
    vendor.account!.onAnswered(() => { heard += 1; });
    return { gateway, vendor, heard: () => heard };
  }

  it("hands back the account's source with the client it opens, opening no connection", async () => {
    const { gateway, vendor } = await opening("account-stocks-and-options");
    expect(typeof vendor.account?.watch).toBe("function");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(gateway.connections).toBe(0);
    expect(gateway.sessionsAsked).toBe(0);
  });

  it("says the client answered after a price read that worked, and not after one that asked nothing", async () => {
    const { vendor, heard } = await opening("normal-with-greeks");
    await vendor.fetchQuotes([]);
    expect(heard()).toBe(0);
    const batch = await vendor.fetchQuotes(["US.SPXW261218C8100000"]);
    expect(batch.records).toHaveLength(1);
    expect(heard()).toBe(1);
  });

  it("says the client answered after a handshake for /health, and not after one that failed", async () => {
    const { vendor, heard } = await opening("normal-with-greeks");
    expect(await vendor.reachable()).toBe(true);
    expect(heard()).toBe(1);
    const down = ibkrVendor.open(settingsFor({ ibkrHost: "127.0.0.1", ibkrPort: 1 }))!;
    opened.push({ close: () => down.close() });
    let downHeard = 0;
    down.account!.onAnswered(() => { downHeard += 1; });
    expect(await down.reachable()).toBe(false);
    expect(downHeard).toBe(0);
  });

  it("does not say the client answered after a price read that failed", async () => {
    const down = ibkrVendor.open(settingsFor({ ibkrHost: "127.0.0.1", ibkrPort: 1 }))!;
    opened.push({ close: () => down.close() });
    let heard = 0;
    down.account!.onAnswered(() => { heard += 1; });
    await expect(down.fetchQuotes(["US.SPXW261218C8100000"])).rejects.toThrow();
    expect(heard).toBe(0);
  });
});
