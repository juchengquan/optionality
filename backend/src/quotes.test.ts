/** What the service does with a batch: the creation gate, and the stamping.
 *  Ported from tests/test_monitor.py (ADR 0009, phase 5). */
import { describe, expect, it } from "vitest";

import { displayRecords, verifyContracts } from "./quotes.ts";
import type { QuoteBatch } from "./quotes.ts";

const CODE = "US.SPXW261218C6500000";
const POISON = "US.SPXW261218C99999000";

/** A Provider that prices everything but the poison, and says which code it could not price.
 *
 *  It used to REJECT the whole batch with moomoo's own sentence, because the drop-and-retry
 *  containment lived here and read that sentence to find the culprit. Both have moved into the
 *  moomoo client, where that grammar belongs — `opend/client.test.ts` holds the five claims this
 *  file used to make about it, against a fake OpenD that words the rejection as the real one does
 *  (#168). What is left here is what the SERVICE does with the answer.
 */
const poisonable = (codes: string[]): Promise<QuoteBatch> => Promise.resolve({
  records: codes.filter((c) => c !== POISON).map((code) => ({ code, option_delta: 0.7 })),
  unknown: codes.filter((c) => c === POISON),
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

  it("takes the pessimistic reading when the Provider contradicts itself", async () => {
    /** Found by mutating the `unknown` branch away: every test still passed, because a code that
     *  is unknown normally has no record either and the missing-record check below catches it.
     *  The branch is load-bearing only for this case — a Provider that prices a code AND names it
     *  unknown — and at a creation gate that must be a refusal: the strictness is the point, and
     *  the two answers cannot both be true. */
    const contradictory = (codes: string[]): Promise<QuoteBatch> => Promise.resolve({
      records: codes.map((code) => ({ code, option_delta: 0.7 })), unknown: [POISON],
    });
    expect(await verifyContracts([CODE, POISON], contradictory)).toMatch(/does not exist/);
  });

  it("names a contract the batch simply did not come back with", async () => {
    // not named as unknown, and no record either: the Provider answered about the others and said
    // nothing at all about this one
    const partial = (codes: string[]): Promise<QuoteBatch> => Promise.resolve({
      records: codes.filter((c) => c !== POISON).map((code) => ({ code })), unknown: [],
    });
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
