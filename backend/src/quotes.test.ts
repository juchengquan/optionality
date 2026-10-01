/** The quote-fetching layer: containment, the creation gate, and the stamping.
 *  Ported from tests/test_monitor.py (ADR 0009, phase 5). */
import { describe, expect, it } from "vitest";

import { displayRecords, fetchResilient, verifyContracts } from "./quotes.ts";

const CODE = "US.SPXW261218C6500000";
const POISON = "US.SPXW261218C99999000";

/** Rejects the whole batch while the poison is in it, naming the culprit WITHOUT its market
 *  prefix — which is how moomoo actually words it. */
const poisonable = (codes: string[]) => {
  if (codes.includes(POISON)) {
    return Promise.reject(new Error(`snapshot API failed: Unknown stock. ${POISON.slice(3)}`));
  }
  return Promise.resolve(codes.map((code) => ({ code, option_delta: 0.7 })));
};

describe("fetchResilient", () => {
  it("drops the named culprit and keeps the rest", async () => {
    // moomoo rejects the WHOLE batch when any code is unknown, so one bad contract would otherwise
    // take the entire watchlist hostage
    const { records, bad } = await fetchResilient([POISON, CODE], poisonable);
    expect(bad).toEqual([POISON]);
    expect(records.map((r) => r.code)).toEqual([CODE]);
  });

  it("re-throws anything that is not a named culprit", async () => {
    // retrying a connection failure one code at a time would hide an outage as a watchlist full of
    // unknown contracts
    await expect(fetchResilient([CODE], () => Promise.reject(new Error("Client connection failed!"))))
      .rejects.toThrow(/connection failed/);
  });

  it("drops several culprits over several rounds", async () => {
    const poisons = new Set([POISON, "US.SPXW261218P1000000"]);
    const fetch = (codes: string[]) => {
      const bad = codes.find((c) => poisons.has(c));
      if (bad) return Promise.reject(new Error(`Unknown stock. ${bad.slice(3)}`));
      return Promise.resolve(codes.map((code) => ({ code })));
    };
    const { records, bad } = await fetchResilient([...poisons, CODE], fetch);
    expect(bad.sort()).toEqual([...poisons].sort());
    expect(records.map((r) => r.code)).toEqual([CODE]);
  });

  it("re-throws when the culprit cannot be matched to anything we asked for", async () => {
    // naming a code that is not in our batch means we do not understand the failure, and guessing
    // would drop a contract that is fine
    await expect(fetchResilient([CODE], () => Promise.reject(new Error("Unknown stock. ZZ.NOTOURS"))))
      .rejects.toThrow(/Unknown stock/);
  });

  it("returns nothing, and no error, when every code was bad", async () => {
    const { records, bad } = await fetchResilient([POISON], poisonable);
    expect(records).toEqual([]);
    expect(bad).toEqual([POISON]);
  });
});

describe("verifyContracts", () => {
  it("passes a contract that exists", async () => {
    expect(await verifyContracts([CODE], poisonable)).toBeNull();
  });

  it("names a contract that does not", async () => {
    expect(await verifyContracts([POISON], poisonable)).toMatch(/does not exist/);
  });

  it("refuses while OpenD is unreachable rather than accepting blind", async () => {
    const down = () => Promise.reject(new Error("Client connection failed!"));
    expect(await verifyContracts([CODE], down)).toMatch(/unreachable/);
  });

  it("names a contract the batch simply did not come back with", async () => {
    // no error, no record: moomoo answered about the others and said nothing about this one
    const partial = (codes: string[]) =>
      Promise.resolve(codes.filter((c) => c !== POISON).map((code) => ({ code })));
    expect(await verifyContracts([CODE, POISON], partial)).toMatch(/does not exist/);
  });
});

describe("displayRecords", () => {
  const at = new Date("2026-08-10T03:35:32Z");

  it("stamps the call time as the honest data as-of", () => {
    // update_time is only the LAST TRADE; fetched_at is freshness (CLAUDE.md)
    const byCode = displayRecords([{ code: CODE, option_delta: 0.9 }], "Asia/Singapore", at);
    expect(byCode[CODE]!.fetched_at).toBe("2026-08-10 11:35:32+08:00");
  });

  it("converts the market timestamp to the display zone", () => {
    const byCode = displayRecords(
      [{ code: CODE, update_time: "2026-08-09 20:15:00" }], "Asia/Singapore", at,
    );
    expect(byCode[CODE]!.update_time).toBe("2026-08-10 08:15:00+08:00");
  });

  it("copies rather than mutates, because conversion is not idempotent", () => {
    // the sweeper's cached records get rendered on every dashboard poll; mutating them would
    // convert an already-converted timestamp a second time
    const record = { code: CODE, update_time: "2026-08-09 20:15:00" };
    displayRecords([record], "Asia/Singapore", at);
    expect(record.update_time).toBe("2026-08-09 20:15:00");
  });

  it("leaves a record with no update_time alone", () => {
    const byCode = displayRecords([{ code: CODE }], "Asia/Singapore", at);
    expect(byCode[CODE]).toEqual({ code: CODE, fetched_at: "2026-08-10 11:35:32+08:00" });
  });
});
