/** How a contract the service spells gets the number IBKR addresses it by (ADR 0015).
 *
 *  moomoo takes `US.SPXW261030C8100000` and needs nothing else. IBKR takes a conid, which is an
 *  integer nobody can derive — so this walks the security definitions: the underlying's conid
 *  once, then the option's, and it caches both because a contract's conid never changes.
 *
 *  Against a stub, never a gateway. Nobody here has an account, and a test that reached for one
 *  would fail everywhere else (CLAUDE.md: a missing fake looks like a hung suite).
 */
import { describe, expect, it } from "vitest";

import { ConidCache } from "./conids.ts";

const CALL = "US.SPXW261030C8100000";
const PUT = "US.SPXW261030P7900000";

/** A gateway with one index and whatever option definitions the test names. Records every path it
 *  was asked for, because how MANY calls a cold sweep costs is one of the things this PR claims. */
function stub(info: Record<string, unknown[]>, over: { search?: unknown } = {}) {
  const paths: string[] = [];
  const get = async <T>(path: string): Promise<T> => {
    paths.push(path);
    if (path.startsWith("/iserver/secdef/search")) {
      return (over.search ?? [{ conid: 416904, symbol: "SPX", secType: "IND" }]) as T;
    }
    const key = new URL(`http://x${path}`).searchParams;
    const want = `${key.get("month")}/${key.get("strike")}/${key.get("right")}`;
    return (info[want] ?? []) as T;
  };
  return { get, paths };
}

const SPXW = {
  "OCT26/8100/C": [{
    conid: 712345, maturityDate: "20261030", right: "C", strike: 8100,
    multiplier: "100", tradingClass: "SPXW",
  }],
  "OCT26/7900/P": [{
    conid: 712346, maturityDate: "20261030", right: "P", strike: 7900,
    multiplier: "100", tradingClass: "SPXW",
  }],
};

describe("resolving a conid", () => {
  it("answers with the contract IBKR means by that code", async () => {
    const gateway = stub(SPXW);
    const cache = new ConidCache(gateway.get);
    const { specs, unknown } = await cache.resolve([CALL]);
    expect(unknown).toEqual([]);
    expect(specs).toEqual([{
      code: CALL, conid: 712345, multiplier: 100,
      contract: { strike_date: "2026-10-30", option_type: "CALL", strike: 8100 },
    }]);
  });

  it("looks the underlying up once, however many sweeps ask", async () => {
    // SPX's conid is a constant of the exchange, not of the request. Re-searching it every sweep
    // would be a second call per sweep for ever, against a 10 req/s budget shared with the
    // dashboard's own poll (ADR 0010).
    const gateway = stub(SPXW);
    const cache = new ConidCache(gateway.get);
    await cache.resolve([CALL]);
    await cache.resolve([CALL, PUT]);
    expect(gateway.paths.filter((p) => p.includes("secdef/search")).length).toBe(1);
  });

  it("looks a contract up once and then remembers it", async () => {
    const gateway = stub(SPXW);
    const cache = new ConidCache(gateway.get);
    await cache.resolve([CALL]);
    await cache.resolve([CALL]);
    await cache.resolve([CALL]);
    expect(gateway.paths.filter((p) => p.includes("secdef/info")).length).toBe(1);
  });

  it("asks once for contracts that share a month, a strike and a side", async () => {
    // secdef/info answers for a whole month, so two expiries at one strike cost one call. An
    // iron condor is four strikes in one month: four calls, not eight.
    const gateway = stub({
      "OCT26/8100/C": [
        { conid: 712345, maturityDate: "20261030", tradingClass: "SPXW", multiplier: "100" },
        { conid: 712399, maturityDate: "20261031", tradingClass: "SPXW", multiplier: "100" },
      ],
    });
    const cache = new ConidCache(gateway.get);
    const { specs } = await cache.resolve([CALL, "US.SPXW261031C8100000"]);
    expect(specs.map((s) => s.conid)).toEqual([712345, 712399]);
    expect(gateway.paths.filter((p) => p.includes("secdef/info")).length).toBe(1);
  });

  it("refuses the monthly contract that shares the weekly's strike and date", async () => {
    // the load-bearing filter. On a third Friday, SPX and SPXW both have a contract at 8100 for
    // the same date; they settle at different times of day on different prints. Every code this
    // service can create is SPXW (buildSpxCode writes no others), so taking the first hit would
    // be a different instrument answering to the right name.
    const gateway = stub({
      "OCT26/8100/C": [
        { conid: 999999, maturityDate: "20261030", tradingClass: "SPX", multiplier: "100" },
        { conid: 712345, maturityDate: "20261030", tradingClass: "SPXW", multiplier: "100" },
      ],
    });
    const { specs } = await new ConidCache(gateway.get).resolve([CALL]);
    expect(specs.map((s) => s.conid)).toEqual([712345]);
  });

  it("calls a code it cannot parse unknown, without asking the gateway", async () => {
    // the port's own answer for a contract it cannot price (#168), which the sweep quarantines
    // with a notice rather than deleting (#167). A string buildSpxCode could not have written
    // has no conid to look for.
    const gateway = stub(SPXW);
    const { specs, unknown } = await new ConidCache(gateway.get).resolve(["US.AAPL"]);
    expect(specs).toEqual([]);
    expect(unknown).toEqual(["US.AAPL"]);
    expect(gateway.paths.filter((p) => p.includes("secdef/info")).length).toBe(0);
  });

  it("calls a contract the gateway does not list unknown", async () => {
    const gateway = stub({ "OCT26/8100/C": [] });
    const { specs, unknown } = await new ConidCache(gateway.get).resolve([CALL]);
    expect(specs).toEqual([]);
    expect(unknown).toEqual([CALL]);
  });

  it("calls a contract listed for another date unknown, rather than the nearest one", async () => {
    const gateway = stub({
      "OCT26/8100/C": [{ conid: 712399, maturityDate: "20261031", tradingClass: "SPXW" }],
    });
    const { unknown } = await new ConidCache(gateway.get).resolve([CALL]);
    expect(unknown).toEqual([CALL]);
  });

  it("does not remember an unknown, because tomorrow it may exist", async () => {
    // a definition that is absent while the gateway's session is half-awake is not a verdict for
    // the life of the process. Caching the absence would outlast the cause.
    const info: Record<string, unknown[]> = { "OCT26/8100/C": [] };
    const gateway = stub(info);
    const cache = new ConidCache(gateway.get);
    expect((await cache.resolve([CALL])).unknown).toEqual([CALL]);
    info["OCT26/8100/C"] = [{ conid: 712345, maturityDate: "20261030", tradingClass: "SPXW" }];
    expect((await cache.resolve([CALL])).specs.map((s) => s.conid)).toEqual([712345]);
  });

  it("throws when the underlying itself cannot be found, instead of calling everything unknown", async () => {
    // the discipline #168 settled: `unknown` is a verdict ABOUT a contract, and a gateway that
    // cannot answer at all is an outage. A whole watchlist reported unknown would quarantine
    // every rule the owner has.
    const gateway = stub(SPXW, { search: [] });
    await expect(new ConidCache(gateway.get).resolve([CALL])).rejects.toThrow(/SPX/);
  });

  it("lets a transport failure through untouched", async () => {
    const get = async <T>(): Promise<T> => { throw new Error("fetch failed"); };
    await expect(new ConidCache(get).resolve([CALL])).rejects.toThrow(/fetch failed/);
  });

  it("asks for the month the way IBKR spells it", async () => {
    const gateway = stub(SPXW);
    await new ConidCache(gateway.get).resolve([CALL]);
    const info = gateway.paths.find((p) => p.includes("secdef/info"))!;
    expect(info).toContain("month=OCT26");
    expect(info).toContain("strike=8100");
    expect(info).toContain("right=C");
    expect(info).toContain("conid=416904");
    expect(info).toContain("sectype=OPT");
  });
});
