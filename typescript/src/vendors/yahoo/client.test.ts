import { describe, expect, it } from "vitest";

import { yahooFetcher } from "./client.ts";

/** The bounded call, against an injected answer.
 *
 *  Never the real endpoint: a suite that reached Yahoo would fail when a company nobody here
 *  controls changes something, which is the same rule that keeps the moomoo SDK out of the tests.
 */

const GSPC = {
  symbol: "^GSPC", shortName: "S&P 500", regularMarketPrice: 7376.86,
  regularMarketPreviousClose: 7353.73, exchangeDataDelayedBy: 0, marketState: "CLOSED",
};
const VIX = {
  symbol: "^VIX", shortName: "CBOE Volatility Index", regularMarketPrice: 25.64,
  regularMarketPreviousClose: 28.18, exchangeDataDelayedBy: 15, marketState: "CLOSED",
};

describe("one bounded call", () => {
  it("asks for every code at once", async () => {
    const asked: string[][] = [];
    const fetch = yahooFetcher((symbols) => {
      asked.push([...symbols]);
      return Promise.resolve([GSPC, VIX]);
    });
    await fetch(["^GSPC", "^VIX"]);
    expect(asked).toEqual([["^GSPC", "^VIX"]]);
  });

  it("asks nothing at all for an empty list", async () => {
    let called = false;
    const fetch = yahooFetcher(() => { called = true; return Promise.resolve([]); });
    expect(await fetch([])).toEqual({ records: [], unknown: [] });
    expect(called).toBe(false);
  });

  it("answers in the order asked, whatever order Yahoo replies in", async () => {
    const fetch = yahooFetcher(() => Promise.resolve([VIX, GSPC]));
    const batch = await fetch(["^GSPC", "^VIX"]);
    expect(batch.records.map((r) => r.code)).toEqual(["^GSPC", "^VIX"]);
  });
});

describe("a code Yahoo does not carry", () => {
  it("is unknown by DIFFERENCE, because Yahoo omits it rather than refusing", async () => {
    // measured: asking for NOTATICKER returns `[]` with no error at all
    const fetch = yahooFetcher(() => Promise.resolve([]));
    const batch = await fetch(["NOTATICKER"]);
    expect(batch.unknown).toEqual(["NOTATICKER"]);
    expect(batch.records).toEqual([]);
  });

  it("leaves the codes it does carry standing beside it", async () => {
    const fetch = yahooFetcher(() => Promise.resolve([GSPC]));
    const batch = await fetch(["^GSPC", "NOTATICKER"]);
    expect(batch.records.map((r) => r.code)).toEqual(["^GSPC"]);
    expect(batch.unknown).toEqual(["NOTATICKER"]);
  });

  it("reports a code that was silently dropped rather than losing it", async () => {
    // the difference is what catches this: a row that never came back is unknown, not absent
    const fetch = yahooFetcher(() => Promise.resolve([GSPC]));
    const batch = await fetch(["^GSPC", "^VIX", "^NDX"]);
    expect(batch.unknown).toEqual(["^VIX", "^NDX"]);
  });
});

describe("the code the caller used", () => {
  it("is echoed back, not Yahoo's spelling of it", async () => {
    // the row is keyed by the service's code, because `references.ts` matches on it — a record
    // keyed by Yahoo's own casing would be a figure nobody could find
    const fetch = yahooFetcher(() => Promise.resolve([{ ...GSPC, symbol: "^gspc" }]));
    const batch = await fetch(["^GSPC"]);
    expect(batch.records[0]!.code).toBe("^GSPC");
  });
});

describe("a failure", () => {
  it("propagates, so the caller can contain it", async () => {
    // one bounded call that throws leaves the other sources' figures standing — `references.ts`
    // groups by source for exactly this
    const fetch = yahooFetcher(() => Promise.reject(new Error("Too Many Requests")));
    await expect(fetch(["^GSPC"])).rejects.toThrow(/Too Many Requests/);
  });
});
