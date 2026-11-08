/** The reference path: one bounded call, and a degrade the watchlist cannot afford (ADR 0018).
 *
 *  What is being protected here is the WATCHLIST, not these rows. A Reference is a backdrop; the
 *  rules are what the owner acts on. So the two rules this file holds are both about containment:
 *  a Reference never shares the `/quotes` batch, and a Reference that cannot be priced costs the
 *  others nothing.
 */
import { describe, expect, it } from "vitest";

import type { DatabaseSync } from "node:sqlite";

import { insertReference } from "./db/queries.ts";
import { referenceReadings } from "./references.ts";
import type { QuoteBatch, QuoteFetcher } from "./quotes.ts";
import { harness } from "./testing.ts";

/** US.SPY as the live gateway gave it on 2026-11-02. */
const SPY = {
  code: "US.SPY", name: "SPDR S&P 500 ETF Trust",
  bid_price: 758.7, ask_price: 758.76, mid_price: 758.73,
  last_price: 755.72, prev_close_price: 755.72,
};
const QQQ = { code: "US.QQQ", name: "Invesco QQQ Trust", mid_price: 598.5, prev_close_price: 600 };

function add(db: DatabaseSync, over: Partial<Parameters<typeof insertReference>[1]> = {}) {
  const id = String(over.id ?? "r1".padEnd(32, "0"));
  insertReference(db, {
    id, code: "US.SPY", label: "SPY", source: "moomoo", created_at: "2026-11-02 00:00:00.000000",
    ...over,
  });
  return id;
}

/** A Provider that prices these codes and nothing else, counting its calls. */
function pricing(records: Record<string, object>) {
  const calls: string[][] = [];
  const fetch: QuoteFetcher = (codes) => {
    calls.push([...codes]);
    return Promise.resolve({
      records: codes.filter((c) => c in records).map((c) => records[c]!),
      unknown: codes.filter((c) => !(c in records)),
    } as QuoteBatch);
  };
  return { fetch, calls };
}

describe("one bounded call of its own", () => {
  it("asks for every Reference in a single batch", async () => {
    const h = harness();
    add(h.db);
    add(h.db, {
      id: "r2".padEnd(32, "0"), code: "US.QQQ", label: null, source: "moomoo",
      created_at: "2026-11-02 00:00:01.000000",
    });
    const { fetch, calls } = pricing({ "US.SPY": SPY, "US.QQQ": QQQ });

    const rows = await referenceReadings(h.db, { moomoo: fetch });
    expect(calls).toEqual([["US.SPY", "US.QQQ"]]);
    expect(rows.map((r) => r.figure)).toEqual([758.73, 598.5]);
    h.close();
  });

  it("breaks a same-instant tie by code, so the strip cannot reshuffle between polls", async () => {
    // the strip reads left to right and the order they were ADDED in is the only order the owner
    // chose; two rows written in the same millisecond have none, and an undefined order would
    // reshuffle on a poll — which reads as a change
    const h = harness();
    add(h.db, { id: "r1".padEnd(32, "0"), code: "US.SPY" });
    add(h.db, { id: "r2".padEnd(32, "0"), code: "US.QQQ", label: null, source: "moomoo" });
    const { fetch } = pricing({ "US.SPY": SPY, "US.QQQ": QQQ });
    expect((await referenceReadings(h.db, { moomoo: fetch })).map((r) => r.code))
      .toEqual(["US.QQQ", "US.SPY"]);
    h.close();
  });

  it("asks for nothing at all when there are no References", async () => {
    const h = harness();
    const { fetch, calls } = pricing({});
    expect(await referenceReadings(h.db, { moomoo: fetch })).toEqual([]);
    // the dashboard polls this every 15 seconds per open tab, and a call for an empty list would
    // be a Provider call that buys nothing (ADR 0010)
    expect(calls).toEqual([]);
    h.close();
  });

  it("carries the label, the source and the Security's own name through", async () => {
    const h = harness();
    add(h.db);
    const { fetch } = pricing({ "US.SPY": SPY });
    expect(await referenceReadings(h.db, { moomoo: fetch })).toEqual([{
      id: "r1".padEnd(32, "0"),
      code: "US.SPY",
      label: "SPY",
      source: "moomoo",
      name: "SPDR S&P 500 ETF Trust",
      figure: 758.73,
      field: "mid_price",
      change: (758.73 - 755.72) / 755.72,
      error: null,
    }]);
    h.close();
  });
});

describe("more than one source", () => {
  it("asks each vendor once — one call per SOURCE, not per Reference", async () => {
    const h = harness();
    // distinct stamps, because rows order by created_at and then by CODE — sharing a stamp would
    // sort these as SPX, US.QQQ, US.SPY and make the assertions below about alphabet, not order
    add(h.db, { id: "r1".padEnd(32, "0"), code: "US.SPY", source: "moomoo", created_at: "2026-11-08 00:00:01.000000" });
    add(h.db, { id: "r2".padEnd(32, "0"), code: "US.QQQ", source: "moomoo", created_at: "2026-11-08 00:00:02.000000" });
    add(h.db, { id: "r3".padEnd(32, "0"), code: "SPX", source: "ibkr", created_at: "2026-11-08 00:00:03.000000" });
    const moo = pricing({ "US.SPY": SPY, "US.QQQ": QQQ });
    const ibkr = pricing({ SPX: { code: "SPX", name: "S&P 500", mid_price: 7376.86 } });

    const rows = await referenceReadings(h.db, { moomoo: moo.fetch, ibkr: ibkr.fetch });

    expect(moo.calls).toEqual([["US.SPY", "US.QQQ"]]);
    expect(ibkr.calls).toEqual([["SPX"]]);
    expect(rows.map((r) => r.figure)).toEqual([758.73, 598.5, 7376.86]);
    expect(rows.map((r) => r.source)).toEqual(["moomoo", "moomoo", "ibkr"]);
  });

  it("leaves one vendor's figures standing when the other is dead", async () => {
    // the whole point of grouping by source. IB Gateway logs out every Sunday by design, and a
    // moomoo-sourced figure must not dash alongside it — the argument that gave References a
    // call of their own, one level up (ADR 0019)
    const h = harness();
    add(h.db, { id: "r1".padEnd(32, "0"), code: "US.SPY", source: "moomoo", created_at: "2026-11-08 00:00:01.000000" });
    add(h.db, { id: "r2".padEnd(32, "0"), code: "SPX", source: "ibkr", created_at: "2026-11-08 00:00:02.000000" });
    const moo = pricing({ "US.SPY": SPY });

    const rows = await referenceReadings(h.db, {
      moomoo: moo.fetch,
      ibkr: () => Promise.reject(new Error("Couldn't connect to TWS")),
    });

    expect(rows[0]!.figure).toBe(758.73);
    expect(rows[0]!.error).toBe(null);
    expect(rows[1]!.figure).toBe(null);
    expect(rows[1]!.error).toMatch(/Couldn't connect to TWS/);
  });

  it("says which vendor is missing rather than blaming the code", async () => {
    // a name SOURCES knows and this build cannot reach. "does not know this code" would send the
    // owner looking at the code, which is the one thing that is fine.
    const h = harness();
    add(h.db, { id: "r1".padEnd(32, "0"), code: "SPX", source: "ibkr" });
    const rows = await referenceReadings(h.db, { moomoo: pricing({}).fetch });
    expect(rows[0]!.figure).toBe(null);
    expect(rows[0]!.error).toBe("no ibkr client in this build");
  });

  it("spends no call on a vendor that has no Reference", async () => {
    const h = harness();
    add(h.db, { code: "US.SPY", source: "moomoo" });
    const moo = pricing({ "US.SPY": SPY });
    const ibkr = pricing({});
    await referenceReadings(h.db, { moomoo: moo.fetch, ibkr: ibkr.fetch });
    expect(ibkr.calls).toEqual([]);
  });
});

describe("a Reference the Provider will not price", () => {
  it("shows a dash and says so, and the others still read", async () => {
    const h = harness();
    add(h.db, { id: "r1".padEnd(32, "0"), code: "US.NOPE", label: null, source: "moomoo" });
    add(h.db, { id: "r2".padEnd(32, "0"), code: "US.SPY" });
    const { fetch } = pricing({ "US.SPY": SPY });

    const rows = await referenceReadings(h.db, { moomoo: fetch });
    expect(rows[0]).toMatchObject({ code: "US.NOPE", figure: null, field: null });
    expect(rows[0]!.error).toMatch(/does not know/);
    expect(rows[1]!.figure).toBe(758.73);
    h.close();
  });

  it("is never disabled and never deleted", async () => {
    const h = harness();
    const id = add(h.db, { code: "US.NOPE" });
    const before = h.db.prepare("select * from reference_securities where id = ?").get(id);
    const { fetch } = pricing({});
    await referenceReadings(h.db, { moomoo: fetch });
    // the row is exactly as it was: quarantine is defined as a Monitor the service disabled
    // because it cannot be EVALUATED, and a Reference evaluates nothing. Nor is anything sent —
    // this path has no sender to speak through, which is the structural half of the same rule
    // (ADR 0018).
    expect(h.db.prepare("select * from reference_securities where id = ?").get(id))
      .toEqual(before);
    h.close();
  });

  it("says a quote that came back with no price is a missing price, not a missing quote", async () => {
    const h = harness();
    add(h.db, { code: "US.SPY", label: null, source: "moomoo" });
    // priced, named, and with an empty book: `(0 + 0) / 2` is a mid and 0 is not a price
    const { fetch } = pricing({ "US.SPY": { code: "US.SPY", name: "SPDR", mid_price: 0 } });
    const rows = await referenceReadings(h.db, { moomoo: fetch });
    expect(rows[0]).toMatchObject({ figure: null, name: "SPDR" });
    expect(rows[0]!.error).toMatch(/no price/);
    h.close();
  });
});

describe("a fetch that THREW", () => {
  /** The failure this exists for: moomoo refuses a US stock index as a CLASS, naming no culprit,
   *  so the containment loop in `opend/client.ts` re-throws — and a Reference in the sweep's
   *  batch would have taken every sweep down with it every fifteen seconds (#175's shape). */
  const refusing = (bad: string, records: Record<string, object>) => {
    const calls: string[][] = [];
    const fetch: QuoteFetcher = (codes) => {
      calls.push([...codes]);
      if (codes.some((c) => c.startsWith(bad))) {
        return Promise.reject(new Error("snapshot API failed: US stock indices are not supported"));
      }
      return Promise.resolve({
        records: codes.filter((c) => c in records).map((c) => records[c]!),
        unknown: codes.filter((c) => !(c in records)),
      } as QuoteBatch);
    };
    return { fetch, calls };
  };

  it("retries one code at a time, so the culprit alone goes dark", async () => {
    const h = harness();
    add(h.db, { id: "r1".padEnd(32, "0"), code: "US..SPX", label: null, source: "moomoo" });
    add(h.db, { id: "r2".padEnd(32, "0"), code: "US.SPY" });
    const { fetch, calls } = refusing("US..SPX", { "US.SPY": SPY });  // exact, so SPY is priced

    const rows = await referenceReadings(h.db, { moomoo: fetch });
    // the batch, then one call per Reference — bounded by the number of References, which is what
    // the sweep cannot afford and this path can
    expect(calls).toEqual([["US..SPX", "US.SPY"], ["US..SPX"], ["US.SPY"]]);
    expect(rows[0]!.figure).toBeNull();
    // the Provider's own sentence, because it is what says whether the gateway is down or whether
    // it answered and declined the security
    expect(rows[0]!.error).toContain("US stock indices are not supported");
    expect(rows[1]!.figure).toBe(758.73);
    h.close();
  });

  it("retries at most once per Reference, however many throw", async () => {
    const h = harness();
    add(h.db, { id: "r1".padEnd(32, "0"), code: "US..SPX", label: null });
    add(h.db, { id: "r2".padEnd(32, "0"), code: "US..VIX", label: null });
    const { fetch, calls } = refusing("US.", {});
    const rows = await referenceReadings(h.db, { moomoo: fetch });
    expect(calls).toHaveLength(3);
    expect(rows.every((r) => r.error !== null)).toBe(true);
    h.close();
  });

  it("does not retry when the batch answered — an unknown code is an answer", async () => {
    const h = harness();
    add(h.db, { code: "US.NOPE", label: null });
    const { fetch, calls } = pricing({});
    await referenceReadings(h.db, { moomoo: fetch });
    expect(calls).toEqual([["US.NOPE"]]);
    h.close();
  });
});
