/** What a sweep records of the WATCHLIST: the daily close of every set of contracts an enabled rule
 *  watches (#402), under exactly the holdings' sampling rules (`takesSample`, ADR 0011).
 *
 *  Driven through `MonitorSweeper`, as the holdings' sampler is in `positions.test.ts`, for its
 *  reason: the figures must come from the sweep's own batch, and a unit test handing the sampler a
 *  batch it built itself could not show that no call was added for them.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildSpxCode } from "optionality/domain/contract";
import { createDatabase } from "../db/open.ts";
import { toSqliteJson } from "../db/values.ts";
import { settingsFor } from "../env.ts";
import type { QuoteRecord } from "optionality/quotes";
import { type FakeProvider, fakeFetcher } from "../../testing/harness.ts";
import { SWEEP_SETTINGS, insertCombo, insertMonitor } from "../../testing/sweep.ts";
import { MonitorSweeper } from "./index.ts";

let dir: string;
let db: ReturnType<typeof createDatabase>;
let now: Date;
let calls: string[][];

// inside the sample hours: 11:00 in New York on a Thursday
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "optionality-watching-"));
  db = createDatabase(join(dir, "test.db"));
  now = new Date("2026-10-01T15:00:00Z");
  calls = [];
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const EXPIRY = "2026-10-31";
const code = (type: "CALL" | "PUT", strike: number) => buildSpxCode(EXPIRY, type, strike);
const [SHORT, LONG] = [code("CALL", 8100), code("CALL", 8150)];
const KEY = [SHORT, LONG].sort().join(",");

/** A Provider pricing every code it is asked for from a table the test moves, counting its calls. */
let book: Record<string, QuoteRecord>;
const provider: FakeProvider = (codes) => {
  calls.push([...codes]);
  return Promise.resolve(codes.filter((c) => c in book).map((c) => ({ code: c, name: c, ...book[c] })));
};
const quote = (mid: number | null, over: QuoteRecord = {}): QuoteRecord => ({
  ...(mid === null ? { bid_price: 0, ask_price: 0 } : { mid_price: mid }),
  option_implied_volatility: 12.5, option_vega: 3.25, option_delta: 0.25, option_contract_size: 100,
  ...over,
});
beforeEach(() => {
  book = { [SHORT]: quote(5), [LONG]: quote(2, { option_implied_volatility: 11.5, option_delta: 0.125 }) };
});

const sweep = () => new MonitorSweeper({
  db, settings: settingsFor(SWEEP_SETTINGS), fetchQuotes: fakeFetcher(provider), send: () => {},
  now: () => now,
}).sweep();

const spreadRule = (over: Record<string, unknown> = {}) => insertCombo(db, {
  strike_date: EXPIRY, code: "oct-calls", threshold: 4, direction: "above",
  legs: [{ sign: -1, option_type: "CALL", strike: 8100 }, { sign: 1, option_type: "CALL", strike: 8150 }],
  ...over,
});

interface Stored {
  contracts: string; observed_on: string; dte: number; legs_mid: string | null;
  legs_iv: string | null; legs_vega: string | null; legs_delta: string | null;
  observed_at: string; spx: number | null; contract_size: number | null;
}
const stored = () => db.prepare("select * from watch_samples order by contracts, observed_on").all() as
  unknown as Stored[];

const hold = (legs: unknown) => db.prepare(
  `insert into positions (id, name, strategy, strike_date, contracts, entry, legs, created_at)
   values ('p1', 'held', null, ?, 1, 3.0, ?, '2026-09-01 00:00:00.000000')`,
).run(EXPIRY, toSqliteJson(legs));

describe("the daily close of what is watched", () => {
  it("records a watched spread's contracts: each mid, IV, vega and delta, its DTE, size and stamp", async () => {
    spreadRule();
    await sweep();
    expect(stored()).toEqual([{
      contracts: KEY, observed_on: "2026-10-01", dte: 30,
      legs_mid: toSqliteJson({ [SHORT]: 5, [LONG]: 2 }),
      legs_iv: toSqliteJson({ [SHORT]: 12.5, [LONG]: 11.5 }),
      legs_vega: toSqliteJson({ [SHORT]: 3.25, [LONG]: 3.25 }),
      legs_delta: toSqliteJson({ [SHORT]: 0.25, [LONG]: 0.125 }),
      observed_at: "2026-10-01 15:00:00.000000", spx: null, contract_size: 100,
    }]);
  });

  it("asks the Provider for nothing more: one call, the codes the rules already needed", async () => {
    spreadRule();
    insertMonitor(db, { strike_date: EXPIRY, code: SHORT, option_type: "CALL", strike: 8100 });
    await sweep();
    expect(calls).toEqual([[SHORT, LONG].sort()]);
    expect(stored().map((s) => s.contracts)).toEqual([SHORT, KEY].sort());
  });

  it("keeps ONE history for every rule on the same contracts, whatever their signs, fields or names", async () => {
    spreadRule();
    spreadRule({ field: "option_delta", threshold: 0.3, direction: "above" });
    spreadRule({
      code: "oct-calls-debit", legs: [
        { sign: 1, option_type: "CALL", strike: 8100 }, { sign: -1, option_type: "CALL", strike: 8150, qty: 2 },
      ],
    });
    await sweep();
    expect(stored().map((s) => s.contracts)).toEqual([KEY]);
  });

  it("records a watched single contract as a set of one", async () => {
    insertMonitor(db, { strike_date: EXPIRY, code: SHORT, option_type: "CALL", strike: 8100 });
    await sweep();
    expect(stored()).toMatchObject([{ contracts: SHORT, legs_mid: toSqliteJson({ [SHORT]: 5 }) }]);
  });

  it("records nothing for a rule switched off", async () => {
    spreadRule({ enabled: 0, disabled_reason: "manual" });
    await sweep();
    expect(stored()).toEqual([]);
  });

  it("leaves the contracts an open holding holds EXACTLY to the holding's own samples", async () => {
    hold([
      { side: "short", option_type: "CALL", strike: 8100 }, { side: "long", option_type: "CALL", strike: 8150 },
    ]);
    spreadRule();
    await sweep();
    expect(stored()).toEqual([]);
  });

  it("still records a candidate that shares only one contract with a holding", async () => {
    hold([
      { side: "short", option_type: "CALL", strike: 8050 }, { side: "long", option_type: "CALL", strike: 8100 },
    ]);
    spreadRule();
    await sweep();
    expect(stored().map((s) => s.contracts)).toEqual([KEY]);
  });

  it("stops once the contracts have expired", async () => {
    spreadRule({ strike_date: "2026-09-30" });
    insertMonitor(db, { strike_date: "2026-09-30", code: buildSpxCode("2026-09-30", "CALL", 8100) });
    await sweep();
    expect(stored()).toEqual([]);
  });
});

describe("under exactly the holdings' sampling rules (ADR 0011)", () => {
  it("settles on the close: a mark that moves after 16:15 does not move the day's row", async () => {
    spreadRule();
    now = new Date("2026-10-01T20:14:00Z"); // 16:14 in New York
    await sweep();
    book[SHORT] = quote(7);
    now = new Date("2026-10-02T00:30:00Z"); // 20:30, the same New York day
    await sweep();
    expect(stored()).toMatchObject([{ observed_on: "2026-10-01", legs_mid: toSqliteJson({ [SHORT]: 5, [LONG]: 2 }),
      observed_at: "2026-10-01 20:14:00.000000" }]);
  });

  it("fills a day out of hours with no price and its vol, when no contract has a book (#380)", async () => {
    spreadRule();
    book = { [SHORT]: quote(null), [LONG]: quote(null) };
    now = new Date("2026-10-02T01:00:00Z"); // 21:00 in New York, after the close
    await sweep();
    expect(stored()).toMatchObject([{
      observed_on: "2026-10-01", legs_mid: null, legs_iv: toSqliteJson({ [SHORT]: 12.5, [LONG]: 12.5 }),
      observed_at: "2026-10-02 01:00:00.000000",
    }]);
  });

  it("never replaces a stored price with an empty one", async () => {
    spreadRule();
    await sweep();
    book = { [SHORT]: quote(null), [LONG]: quote(5.5) };
    now = new Date("2026-10-01T16:00:00Z");
    await sweep();
    expect(stored()).toMatchObject([{ legs_mid: toSqliteJson({ [SHORT]: 5, [LONG]: 2 }) }]);
  });

  it("records a row on a Saturday, carrying the last close forward", async () => {
    spreadRule();
    now = new Date("2026-10-03T14:00:00Z"); // a Saturday, mid-morning in New York
    await sweep();
    expect(stored()).toMatchObject([{ observed_on: "2026-10-03", dte: 28 }]);
  });

  it("writes nothing on a sweep that would store the same row again", async () => {
    spreadRule();
    await sweep();
    const before = stored();
    now = new Date("2026-10-01T15:05:00Z");
    await sweep();
    expect(stored()).toEqual(before);
  });

  it("writes when a figure moves in the hours", async () => {
    spreadRule();
    await sweep();
    book[LONG] = quote(2.5);
    now = new Date("2026-10-01T15:05:00Z");
    await sweep();
    expect(stored()).toMatchObject([{ legs_mid: toSqliteJson({ [SHORT]: 5, [LONG]: 2.5 }),
      observed_at: "2026-10-01 15:05:00.000000" }]);
  });

  it("records nothing for contracts the Provider returned nothing for", async () => {
    spreadRule();
    book = {};
    await sweep();
    expect(stored()).toEqual([]);
  });
});
