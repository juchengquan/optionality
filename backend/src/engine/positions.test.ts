/** What a sweep does to HOLDINGS: the daily sample, and the manage-by notice.
 *
 *  Both are `positions.ts`'s and neither is an alarm. They are driven through `MonitorSweeper`
 *  anyway, and deliberately: the batch they read is the sweep's batch, the instant they stamp is
 *  the sweep's instant, and a unit test that handed `recordSamples` a record it built itself would
 *  stop proving the thing that actually broke twice — that a Position's legs are IN the batch.
 *
 *  These 494 lines lived in `sweeper.test.ts` because that is where the sweep was, which is how
 *  the sampler's tests ended up somewhere nobody looking for them would read. The fixture they
 *  share with that suite is `testing/sweep.ts`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildSpxCode } from "optionality/domain/contract";
import { volAttribution, type VolSample } from "optionality/domain/vol";
import { createDatabase } from "../db/open.ts";
import { findPosition, listPositionSamples } from "../db/queries/index.ts";
import { toPosition } from "../hydrate.ts";
import { toSqliteJson } from "../db/values.ts";
import { settingsFor, type Settings } from "../env.ts";
import type { QuoteRecord } from "optionality/quotes";
import { type FakeProvider, fakeFetcher } from "../../testing/harness.ts";
import {
  SINGLE_CODE as CODE, SWEEP_SETTINGS, insertMonitor, quoting,
} from "../../testing/sweep.ts";
import { MonitorSweeper } from "./index.ts";

let dir: string;
let db: ReturnType<typeof createDatabase>;
let now: Date;
let sent: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "optionality-positions-"));
  db = createDatabase(join(dir, "test.db"));
  now = new Date("2026-10-01T05:00:00Z");
  sent = [];
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const daysFromNow = (n: number) =>
  new Date(now.getTime() + n * 86_400_000).toISOString().slice(0, 10);
const future = () => daysFromNow(30);
const past = () => daysFromNow(-1);

const monitor = (over: Record<string, unknown> = {}) =>
  insertMonitor(db, { strike_date: future(), ...over });

const sweeper = (
  fetchQuotes: FakeProvider, over: Partial<Settings> = {},
  /** overridden only where the test is about a send that FAILS, which a collecting fake cannot do */
  send: (text: string) => void | Promise<void> = (text) => { sent.push(text); },
) =>
  new MonitorSweeper({
    db,
    settings: settingsFor({ ...SWEEP_SETTINGS, ...over }),
    fetchQuotes: fakeFetcher(fetchQuotes),
    send,
    now: () => now,
  });

describe("positions in the batch", () => {
  it("fetches a held position's legs even when nothing alarms on them", async () => {
    // the dashboard values a position from this same fetch, and a held position must not read as
    // "—" merely because you happen not to be watching it
    db.prepare(
      `insert into positions (id, name, strategy, strike_date, contracts, entry, legs, created_at)
       values (?, 'held', 'credit_spread', ?, 1, 2.0, ?, '2026-08-01 00:00:00.000000')`,
    ).run("p".repeat(32), future(), toSqliteJson([
      { side: "short", option_type: "CALL", strike: 8050 },
      { side: "long", option_type: "CALL", strike: 8075 },
    ]));
    monitor();
    const asked: string[][] = [];
    await sweeper((codes) => {
      asked.push(codes);
      return Promise.resolve(codes.map((c) => ({ code: c, name: c, option_delta: 0.1 })));
    }).sweep();

    expect(asked[0]).toEqual([
      CODE, buildSpxCode(future(), "CALL", 8050), buildSpxCode(future(), "CALL", 8075),
    ].sort());
  });

  it("widens the batch only — the alarm loop still runs over the active monitors", async () => {
    db.prepare(
      `insert into positions (id, name, strategy, strike_date, contracts, entry, legs, created_at)
       values (?, 'held', 'credit_spread', ?, 1, 2.0, ?, '2026-08-01 00:00:00.000000')`,
    ).run("p".repeat(32), future(), toSqliteJson([
      { side: "short", option_type: "CALL", strike: 8050 },
    ]));
    // no monitors at all: the position's legs are fetched and nothing alarms
    const asked: string[][] = [];
    const s = sweeper((codes) => {
      asked.push(codes);
      return Promise.resolve(
        codes.map((c) => ({ code: c, name: c, option_delta: 0.99 } as QuoteRecord)),
      );
    });
    await s.sweep();
    expect(sent).toEqual([]);
    expect(s.health.lastSweepOk()).toBe(true);
    expect(asked[0]).toEqual([buildSpxCode(future(), "CALL", 8050)]);
  });
});

describe("recording what a Position was worth", () => {
  /** One observation per Position per market day, so the √T decay shape can be checked against
   *  this book rather than defended on arithmetic — it had one confirming observation when it was
   *  chosen (ADR 0011). Nothing reads these yet; that is the point of starting now. */
  const held = (name: string, over: Partial<{ strike_date: string; legs: unknown }> = {}) => {
    const id = name.padEnd(32, "0");
    db.prepare(
      `insert into positions (id, name, strategy, strike_date, contracts, entry, legs, created_at,
                              opened_at, manage_notified_at)
       values (?, ?, null, ?, 1, 2.0, ?, '2026-08-01 00:00:00.000000', null, null)`,
    ).run(id, name, over.strike_date ?? future(), toSqliteJson(over.legs ?? [
      { side: "short", option_type: "CALL", strike: 8050 },
      { side: "long", option_type: "CALL", strike: 8075 },
    ]));
    return id;
  };
  const samples = () => db.prepare(
    "select position_id, observed_on, dte, cost_to_close from position_samples order by position_id",
  ).all() as { position_id: string; observed_on: string; dte: number; cost_to_close: number }[];

  const spread = (sold: number, bought: number): FakeProvider => (codes) =>
    Promise.resolve(codes.map((c) => ({
      code: c, name: c,
      mid_price: c === buildSpxCode(future(), "CALL", 8050) ? sold : bought,
    })));

  // inside the hours a sample may be taken in (11:00 in New York, the same market day as the
  // file's 01:00 clock): the file's clock is the small hours, which is now when nothing is written
  beforeEach(() => { now = new Date("2026-10-01T15:00:00Z"); });

  it("writes one row per Position, with the Cost to close and the dashboard's DTE", async () => {
    const id = held("held");
    await sweeper(spread(5.0, 1.0)).sweep();

    // sold 5.00 and bought 1.00: 4.00 to buy the spread back
    expect(samples()).toEqual([
      { position_id: id, observed_on: "2026-10-01", dte: 30, cost_to_close: 4 },
    ]);
  });

  it("keeps the LAST sweep of a market day, not the first", async () => {
    // the sweep runs every 60 seconds and a day of samples is a day, not 1,440 of them. Last
    // rather than first because the service runs through the close, so the row converges on the
    // settled mark instead of the opening spread.
    const id = held("held");
    await sweeper(spread(5.0, 1.0)).sweep();
    now = new Date("2026-10-01T19:55:00Z");
    await sweeper(spread(4.0, 1.0)).sweep();

    expect(samples()).toEqual([
      { position_id: id, observed_on: "2026-10-01", dte: 30, cost_to_close: 3 },
    ]);
  });

  /** The held spread priced at codes fixed by the caller — so moving the clock does not move the
   *  contracts — with both vol readings unless `without` names one. */
  const pricing = (short: string, sold: number, without?: "iv" | "vega"): FakeProvider => (codes) =>
    Promise.resolve(codes.map((c) => ({
      code: c, name: c, mid_price: c === short ? sold : 1.0,
      ...(without === "iv" ? {} : { option_implied_volatility: 14.5 }),
      ...(without === "vega" ? {} : { option_vega: 4.25 }),
    })));
  const rows = () => db.prepare(
    `select observed_on, cost_to_close, observed_at,
            legs_iv is not null as iv, legs_vega is not null as vega
     from position_samples order by observed_on`,
  ).all();

  it("stamps every write with the sweep's own instant", async () => {
    // so a chart can tell a close from a point filled after hours (ADR 0011)
    held("held");
    await sweeper(spread(5.0, 1.0)).sweep(); // 11:00 EDT on 2026-10-01
    expect(db.prepare("select observed_at from position_samples").get())
      .toEqual({ observed_at: "2026-10-01 15:00:00.000000" });
  });

  it("never changes a complete row outside the hours, however the mark moves", async () => {
    // a settled close stays the close. The hazard the sweeper's own expiry comment names is here
    // too: 22:00 on a New York Thursday is Friday in UTC, and the row is still Thursday's
    held("held");
    const short = buildSpxCode(future(), "CALL", 8050);
    await sweeper(pricing(short, 5.0)).sweep(); // 11:00 on 2026-10-01
    now = new Date("2026-10-02T02:00:00Z"); // 22:00 on 2026-10-01 in New York, Friday in UTC
    await sweeper(pricing(short, 3.0)).sweep();

    expect(rows()).toEqual([
      { observed_on: "2026-10-01", cost_to_close: 4, observed_at: "2026-10-01 15:00:00.000000", iv: 1, vega: 1 },
    ]);
  });

  it("takes a holding's FIRST sample whatever the hour, and leaves it alone after", async () => {
    // the owner records a trade in the Singapore morning, which is New York's evening after the
    // close of the day it was put on. Under the hours alone its first row would be the next day's,
    // never its Opened day, and the vol chain — which must start on Opened — would never start
    // (takesSample). The evening's row is dated the market day, as every row is.
    now = new Date("2026-10-02T00:30:00Z"); // 20:30 on 2026-10-01 in New York
    const id = held("recorded-late");
    const short = buildSpxCode(future(), "CALL", 8050);
    await sweeper(pricing(short, 5.0)).sweep();
    now = new Date("2026-10-02T00:45:00Z"); // 20:45, a moved mark, and the row now exists
    await sweeper(pricing(short, 4.0)).sweep();

    expect(samples()).toEqual([
      { position_id: id, observed_on: "2026-10-01", dte: 31, cost_to_close: 4 },
    ]);
    expect(rows()[0]).toMatchObject({ observed_at: "2026-10-02 00:30:00.000000" });
  });

  it("fills a day whose session was missed whole, after the hours, and marks it", async () => {
    // a reboot waiting at the FileVault login, OpenD waiting for one: no sweep ran in the session,
    // and a day with no row is a hole that blanks the Vol part for good (vol.ts). The fill is
    // written once and then left alone like any complete row.
    held("held");
    const short = buildSpxCode(future(), "CALL", 8050);
    await sweeper(pricing(short, 5.0)).sweep(); // 11:00 on 2026-10-01
    now = new Date("2026-10-03T00:30:00Z"); // 20:30 on 2026-10-02: its whole session missed
    await sweeper(pricing(short, 4.0)).sweep();
    now = new Date("2026-10-03T00:45:00Z");
    await sweeper(pricing(short, 3.0)).sweep();

    expect(rows()).toEqual([
      { observed_on: "2026-10-01", cost_to_close: 4, observed_at: "2026-10-01 15:00:00.000000", iv: 1, vega: 1 },
      { observed_on: "2026-10-02", cost_to_close: 3, observed_at: "2026-10-03 00:30:00.000000", iv: 1, vega: 1 },
    ]);
  });

  it("completes a row the feed left without its vega, after the hours, from a sweep with both", async () => {
    // the vol chain needs an IV and a vega for every leg on every day; the row is written whole
    // from the completing sweep, and stamped with its instant
    held("held");
    const short = buildSpxCode(future(), "CALL", 8050);
    await sweeper(pricing(short, 5.0, "vega")).sweep(); // 11:00: the vegas withheld all session
    now = new Date("2026-10-02T00:30:00Z"); // 20:30 the same market day
    await sweeper(pricing(short, 4.5)).sweep();

    expect(rows()).toEqual([
      { observed_on: "2026-10-01", cost_to_close: 3.5, observed_at: "2026-10-02 00:30:00.000000", iv: 1, vega: 1 },
    ]);
  });

  it("does not 'complete' a row from a sweep missing the other map", async () => {
    // the row is written whole, so this would trade the stored IV for the missing vega
    held("held");
    const short = buildSpxCode(future(), "CALL", 8050);
    await sweeper(pricing(short, 5.0, "vega")).sweep();
    now = new Date("2026-10-02T00:30:00Z");
    await sweeper(pricing(short, 4.5, "iv")).sweep();

    expect(rows()).toEqual([
      { observed_on: "2026-10-01", cost_to_close: 4, observed_at: "2026-10-01 15:00:00.000000", iv: 1, vega: 0 },
    ]);
  });

  it("starts the vol chain on the Opened day for a trade recorded after the close", async () => {
    // the regression the hours alone caused, end to end: volAttribution returns null unless the
    // first sample is dated Opened. Recorded at 20:30 on its Opened day, the holding has that row,
    // and the next day's session row completes a chain the Vol part can be read from.
    const strike = "2026-10-31";
    const sold = buildSpxCode(strike, "CALL", 8050);
    const id = "late".padEnd(32, "0");
    db.prepare(
      `insert into positions (id, name, strategy, strike_date, contracts, entry, legs, created_at,
                              opened_at, manage_notified_at)
       values (?, 'late', null, ?, 1, 2.0, ?, '2026-10-02 00:30:00.000000', '2026-10-01', null)`,
    ).run(id, strike, toSqliteJson([
      { side: "short", option_type: "CALL", strike: 8050 },
      { side: "long", option_type: "CALL", strike: 8075 },
    ]));
    const book = (soldIv: number): FakeProvider => (codes) => Promise.resolve(codes.map((c) => ({
      code: c, name: c, mid_price: c === sold ? 5.0 : 1.0,
      option_implied_volatility: c === sold ? soldIv : 11.0, option_vega: c === sold ? 1.4 : 0.9,
    })));

    now = new Date("2026-10-02T00:30:00Z"); // 20:30 on the Opened day, after the close
    await sweeper(book(10.5)).sweep();
    now = new Date("2026-10-02T15:00:00Z"); // 11:00 the next day, in the session
    await sweeper(book(11.5)).sweep();

    const chain: VolSample[] = listPositionSamples(db, id).map((s) => ({
      observed_on: s.observed_on, dte: s.dte,
      legs_iv: s.legs_iv === null ? null : JSON.parse(s.legs_iv),
      legs_vega: s.legs_vega === null ? null : JSON.parse(s.legs_vega),
    }));
    const attributed = volAttribution(chain, toPosition(findPosition(db, id)!));
    expect(attributed).not.toBeNull();
    expect(attributed).toMatchObject({ from: "2026-10-01", to: "2026-10-02", days: 1 });
  });

  it("settles on the close: a mark that moves after 16:15 does not move the day's row", async () => {
    // SPXW trades again from about 20:15 in Global Trading Hours, and until this the day's row was
    // rewritten by every overnight mark that differed, up to New York's midnight — so the row that
    // survived was whatever traded last before it, not the close the burndown says it is. 16:15 is
    // the options' close, a quarter hour after the stocks'.
    held("held");
    const short = buildSpxCode(future(), "CALL", 8050);
    now = new Date("2026-10-01T20:14:45Z"); // 16:14:45 EDT
    await sweeper(pricing(short, 5.0)).sweep();
    now = new Date("2026-10-01T20:15:00Z"); // 16:15:00 EDT, the close itself, still in
    await sweeper(pricing(short, 4.5)).sweep();
    now = new Date("2026-10-01T20:15:15Z"); // the next sweep, after the close
    await sweeper(pricing(short, 4.0)).sweep();
    now = new Date("2026-10-02T01:30:00Z"); // 21:30, overnight trading, same market day
    await sweeper(pricing(short, 3.0)).sweep();

    expect(rows()).toEqual([
      { observed_on: "2026-10-01", cost_to_close: 3.5, observed_at: "2026-10-01 20:15:00.000000", iv: 1, vega: 1 },
    ]);
  });

  it("fills a day before the open, and the session then writes over it", async () => {
    // a day with no row is filled whenever it is first seen, the small hours included; inside the
    // hours the row is written freely again, so the session's figures replace the overnight ones
    held("held");
    const short = buildSpxCode(future(), "CALL", 8050);
    now = new Date("2026-10-01T13:29:59Z"); // 09:29:59 EDT, no row for the day yet
    await sweeper(pricing(short, 5.0)).sweep();
    now = new Date("2026-10-01T13:30:00Z"); // 09:30, the session
    await sweeper(pricing(short, 4.5)).sweep();

    expect(rows()).toEqual([
      { observed_on: "2026-10-01", cost_to_close: 3.5, observed_at: "2026-10-01 13:30:00.000000", iv: 1, vega: 1 },
    ]);
  });

  it("records a Position whose Opened nobody has entered yet", async () => {
    // the sample is raw: (DTE, Cost to close) means something without an Opened, and filling the
    // Opened in later makes the history it already collected interpretable. Waiting for the field
    // would throw away the days between.
    held("unopened");
    await sweeper(spread(5.0, 1.0)).sweep();
    expect(samples()).toHaveLength(1);
    const p = db.prepare("select opened_at from positions").get() as { opened_at: string | null };
    expect(p.opened_at).toBeNull();
  });

  it("skips a Position it could not price, QUIETLY", async () => {
    // one unpriced leg and the Cost to close is unknown, not zero — the same all-or-nothing rule
    // the dashboard holds to. A half-priced observation would quietly bend the curve.
    //
    // The silence is the half worth asserting. The column is NOT NULL and the write is wrapped in
    // a catch, so dropping the guard still records nothing — it just logs a failure for every
    // unpriced Position on every sweep, once a minute, for ever. A mutation sweep found that this
    // test could not tell those apart.
    const errors: unknown[][] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      held("held");
      await sweeper((codes) => Promise.resolve(
        codes.filter((c) => c !== buildSpxCode(future(), "CALL", 8075))
          .map((c) => ({ code: c, name: c, mid_price: 5.0 })),
      )).sweep();
    } finally {
      console.error = realError;
    }
    expect(samples()).toEqual([]);
    expect(errors, `an unpriced Position should be silent, not logged: ${JSON.stringify(errors)}`)
      .toEqual([]);
  });

  it("stops recording once a Position has expired", async () => {
    held("gone", { strike_date: past() });
    await sweeper(spread(5.0, 1.0)).sweep();
    expect(samples()).toEqual([]);
  });

  it("records nothing for a holding that has been closed (ADR 0022)", async () => {
    const id = held("closed");
    db.prepare("update positions set closed_on = '2026-08-02', exit = 0.5 where id = ?").run(id);
    await sweeper(spread(5.0, 1.0)).sweep();
    expect(samples()).toEqual([]);
  });

  it("records nothing for a holding CLOSED while the sweep's call was in flight", async () => {
    // The holdings are read before the provider call and written after it. The rules are checked
    // again at that point (a rule muted mid-fetch is not alarmed on); the holdings were not, so a
    // close that landed during the fetch got one more sample, dated after it ended.
    const id = held("closing");
    const closingMidFetch: FakeProvider = (codes) => {
      db.prepare("update positions set closed_on = '2026-08-02', exit = 0.5 where id = ?").run(id);
      return spread(5.0, 1.0)(codes);
    };
    await sweeper(closingMidFetch).sweep();
    expect(samples()).toEqual([]);
  });

  it("records each leg's IV beside the cost, which is what a vol adjustment needs", async () => {
    // The √T shape silently assumes IV has not moved: time value scales with σ√T and only √T is
    // used. The condor's net vega is about -1.3 points per IV point, so half a vol point accounts
    // for a whole pace gap — the reference is mostly a vol reading. Fixing that needs a baseline,
    // and nothing recorded one, so this starts.
    const id = held("held");
    await sweeper((codes) => Promise.resolve(codes.map((c) => ({
      code: c, name: c,
      mid_price: c === buildSpxCode(future(), "CALL", 8050) ? 5.0 : 1.0,
      option_implied_volatility: c === buildSpxCode(future(), "CALL", 8050) ? 10.5 : 22.1,
    })))).sweep();

    const row = db.prepare("select legs_iv from position_samples where position_id = ?").get(id) as
      { legs_iv: string | null };
    expect(JSON.parse(row.legs_iv!)).toEqual({
      [buildSpxCode(future(), "CALL", 8050)]: 10.5,
      [buildSpxCode(future(), "CALL", 8075)]: 22.1,
    });
  });

  it("records a row on a SATURDAY, which the vol chain depends on", async () => {
    // volAttribution requires consecutive samples to be exactly one calendar day apart, and that
    // is only exact because this writes every day: marketDate is the New York CALENDAR date and
    // there is no market-day filter anywhere. If the sampler ever starts skipping non-market days,
    // this fails here rather than silently killing the vol figure for every holding.
    const id = held("held");
    // 2026-10-17 is a Saturday; 14:00 UTC is mid-morning in New York
    const saved = now;
    now = new Date("2026-10-17T14:00:00Z");
    try {
      await sweeper(spread(5.0, 1.0)).sweep();
    } finally {
      now = saved;
    }

    const row = db.prepare("select observed_on from position_samples where position_id = ?").get(id) as
      { observed_on: string } | undefined;
    expect(row?.observed_on, "a Saturday row").toBe("2026-10-17");
  });

  it("records each leg's vega beside its IV, because a weighted vol needs weights", async () => {
    // The adjustment multiplies the pace reference by one vol ratio, and these legs do not share a
    // vol — 10.5 against 22.1 here, and the same 2x skew on the owner's live condor. Collapsing
    // them into one number needs a weight per leg, and the weight is vega: points of value per
    // point of IV. Stored beside the IV rather than derived later, because a vega is only knowable
    // at the moment it was observed — a row without it can never be weighted.
    const id = held("held");
    await sweeper((codes) => Promise.resolve(codes.map((c) => ({
      code: c, name: c,
      mid_price: c === buildSpxCode(future(), "CALL", 8050) ? 5.0 : 1.0,
      option_implied_volatility: c === buildSpxCode(future(), "CALL", 8050) ? 10.5 : 22.1,
      option_vega: c === buildSpxCode(future(), "CALL", 8050) ? 1.4 : 0.9,
    })))).sweep();

    const row = db.prepare("select legs_vega from position_samples where position_id = ?").get(id) as
      { legs_vega: string | null };
    expect(JSON.parse(row.legs_vega!)).toEqual({
      [buildSpxCode(future(), "CALL", 8050)]: 1.4,
      [buildSpxCode(future(), "CALL", 8075)]: 0.9,
    });
  });

  it("records no vega at all rather than some of it", async () => {
    // same all-or-nothing as the IV map, for the same reason: a weighted mean over half the legs
    // is not a weighted mean of the structure.
    const id = held("held");
    await sweeper((codes) => Promise.resolve(codes.map((c) => ({
      code: c, name: c, mid_price: c === buildSpxCode(future(), "CALL", 8050) ? 5.0 : 1.0,
      option_implied_volatility: 10.5,
      ...(c === buildSpxCode(future(), "CALL", 8050) ? { option_vega: 1.4 } : {}),
    })))).sweep();

    const row = db.prepare("select legs_vega from position_samples where position_id = ?").get(id) as
      { legs_vega: string | null };
    expect(row.legs_vega).toBeNull();
  });

  it("still records the IV map when only the vegas are missing", async () => {
    // the two maps are gated independently. A vega the feed withheld does not make the IV reading
    // untrue, and that reading is the one thing that cannot be reconstructed after the day passes
    // — throwing it away because a weight was absent would lose the measurement to save the
    // weighting of it.
    const id = held("held");
    await sweeper((codes) => Promise.resolve(codes.map((c) => ({
      code: c, name: c, mid_price: c === buildSpxCode(future(), "CALL", 8050) ? 5.0 : 1.0,
      option_implied_volatility: c === buildSpxCode(future(), "CALL", 8050) ? 10.5 : 22.1,
    })))).sweep();

    const row = db.prepare("select legs_iv, legs_vega from position_samples where position_id = ?")
      .get(id) as { legs_iv: string | null; legs_vega: string | null };
    expect(row.legs_vega).toBeNull();
    expect(JSON.parse(row.legs_iv!)).toEqual({
      [buildSpxCode(future(), "CALL", 8050)]: 10.5,
      [buildSpxCode(future(), "CALL", 8075)]: 22.1,
    });
  });

  it("still records the vega map when only the IVs are missing", async () => {
    // the other direction of the same independence, which nothing held: making the vega map wait
    // for the IV map passed every test above, because each one that withheld an IV withheld the
    // vegas too. "Per map" and "gated separately" are the rule, and a vega is only knowable when
    // it was observed (ADR 0011), so a feed that withheld the IVs has not made the vegas untrue —
    // dropping them would lose a reading no later sweep can take, to keep a column company.
    const id = held("held");
    await sweeper((codes) => Promise.resolve(codes.map((c) => ({
      code: c, name: c, mid_price: c === buildSpxCode(future(), "CALL", 8050) ? 5.0 : 1.0,
      option_vega: c === buildSpxCode(future(), "CALL", 8050) ? 1.4 : 0.9,
    })))).sweep();

    const row = db.prepare("select legs_iv, legs_vega from position_samples where position_id = ?")
      .get(id) as { legs_iv: string | null; legs_vega: string | null };
    expect(row.legs_iv).toBeNull();
    expect(JSON.parse(row.legs_vega!)).toEqual({
      [buildSpxCode(future(), "CALL", 8050)]: 1.4,
      [buildSpxCode(future(), "CALL", 8075)]: 0.9,
    });
  });

  it("records no IV at all rather than some of it", async () => {
    // a vol adjustment needs every leg: with one missing you cannot say what the structure's vol
    // did, and a partial map would invite an answer computed from half a structure. The cost to
    // close is still recorded — that is a different all-or-nothing, and it has all its mids.
    const id = held("held");
    await sweeper((codes) => Promise.resolve(codes.map((c) => ({
      code: c, name: c, mid_price: c === buildSpxCode(future(), "CALL", 8050) ? 5.0 : 1.0,
      ...(c === buildSpxCode(future(), "CALL", 8050) ? { option_implied_volatility: 10.5 } : {}),
    })))).sweep();

    const row = db.prepare("select legs_iv, cost_to_close from position_samples where position_id = ?")
      .get(id) as { legs_iv: string | null; cost_to_close: number };
    expect(row.legs_iv).toBeNull();
    expect(row.cost_to_close).toBe(4);
  });

  it("records each leg's delta, which is the risk the owner watches", async () => {
    // short-leg delta is how this book is managed, and a chart of it over a trade's life needs it
    // recorded on the day: like a vega, a delta is only knowable when it was observed
    const id = held("held");
    await sweeper((codes) => Promise.resolve(codes.map((c) => ({
      code: c, name: c,
      mid_price: c === buildSpxCode(future(), "CALL", 8050) ? 5.0 : 1.0,
      option_delta: c === buildSpxCode(future(), "CALL", 8050) ? 0.16 : 0.11,
    })))).sweep();

    const row = db.prepare("select legs_delta from position_samples where position_id = ?").get(id) as
      { legs_delta: string | null };
    expect(JSON.parse(row.legs_delta!)).toEqual({
      [buildSpxCode(future(), "CALL", 8050)]: 0.16,
      [buildSpxCode(future(), "CALL", 8075)]: 0.11,
    });
  });

  it("records no delta at all rather than some of it, and the other maps regardless", async () => {
    // the same all-or-nothing per map as the IV and the vega, and gated on its own: a withheld
    // delta makes neither the IV nor the vega reading untrue
    const id = held("held");
    await sweeper((codes) => Promise.resolve(codes.map((c) => ({
      code: c, name: c, mid_price: c === buildSpxCode(future(), "CALL", 8050) ? 5.0 : 1.0,
      option_implied_volatility: 10.5, option_vega: 1.0,
      ...(c === buildSpxCode(future(), "CALL", 8050) ? { option_delta: 0.16 } : {}),
    })))).sweep();

    const row = db.prepare(
      "select legs_delta, legs_iv, legs_vega from position_samples where position_id = ?",
    ).get(id) as { legs_delta: string | null; legs_iv: string | null; legs_vega: string | null };
    expect(row.legs_delta).toBeNull();
    expect(row.legs_iv).not.toBeNull();
    expect(row.legs_vega).not.toBeNull();
  });
});

describe("how often the sampler actually writes", () => {
  /** It wrote on every sweep — 5,760 times a day at a 15-second interval, to persist ONE row, and
   *  overnight almost every one of those stored a value identical to what was already there. The
   *  live file carried a 3.1MB write-ahead log against a 110KB database because of it.
   *
   *  Bounded rather than broken: SQLite folds the log in at about 4MB. But the IV map triples the
   *  payload of each of those writes, so it is worth fixing in the same change rather than after.
   */
  const held = (name: string) => {
    const id = name.padEnd(32, "0");
    db.prepare(
      `insert into positions (id, name, strategy, strike_date, contracts, entry, legs, created_at,
                              opened_at, manage_notified_at)
       values (?, ?, null, ?, 1, 2.0, ?, '2026-08-01 00:00:00.000000', null, null)`,
    ).run(id, name, future(), toSqliteJson([
      { side: "short", option_type: "CALL", strike: 8050 },
      { side: "long", option_type: "CALL", strike: 8075 },
    ]));
    return id;
  };
  const writes = () =>
    (db.prepare("select total_changes() n").get() as { n: number }).n;
  const quiet = (mid: number, iv: number, vega = 1.0, delta = 0.16): FakeProvider => (codes) =>
    Promise.resolve(codes.map((c) => ({
      code: c, name: c,
      mid_price: c === buildSpxCode(future(), "CALL", 8050) ? mid : 1.0,
      option_implied_volatility: iv,
      option_vega: vega,
      option_delta: delta,
    })));

  // inside the sample hours, so each sweep below is one that may write (see the suite above)
  beforeEach(() => { now = new Date("2026-10-01T15:00:00Z"); });

  it("writes nothing on a sweep that would store the same row again", async () => {
    held("held");
    await sweeper(quiet(5.0, 10.5)).sweep();
    const after = writes();

    for (let i = 0; i < 20; i++) await sweeper(quiet(5.0, 10.5)).sweep();
    expect(writes() - after, "twenty identical sweeps should cost no writes").toBe(0);
  });

  it("writes when the figure moves, so the day's row still settles on the close", async () => {
    held("held");
    await sweeper(quiet(5.0, 10.5)).sweep();
    const after = writes();
    await sweeper(quiet(4.0, 10.5)).sweep();
    expect(writes()).toBeGreaterThan(after);

    const row = db.prepare("select cost_to_close from position_samples").get() as
      { cost_to_close: number };
    expect(row.cost_to_close).toBe(3);
  });

  it("writes when only the IV moves, which the cost alone would hide", async () => {
    // the mid can sit still while vol moves, and the vol is the half being recorded for later
    held("held");
    await sweeper(quiet(5.0, 10.5)).sweep();
    const after = writes();
    await sweeper(quiet(5.0, 12.0)).sweep();
    expect(writes()).toBeGreaterThan(after);

    const row = db.prepare("select legs_iv from position_samples").get() as { legs_iv: string };
    expect(JSON.parse(row.legs_iv)[buildSpxCode(future(), "CALL", 8050)]).toBe(12.0);
  });

  it("writes when only a vega moves, which neither the cost nor the IV would show", async () => {
    // vega moves with spot and with time even at a fixed mid and a fixed IV, and it is the weight
    // the stored IVs will be combined with — a row left behind with a stale weight would be
    // weighted wrongly for ever.
    held("held");
    await sweeper(quiet(5.0, 10.5, 1.4)).sweep();
    const after = writes();
    await sweeper(quiet(5.0, 10.5, 1.1)).sweep();
    expect(writes()).toBeGreaterThan(after);

    const row = db.prepare("select legs_vega from position_samples").get() as { legs_vega: string };
    expect(JSON.parse(row.legs_vega)[buildSpxCode(future(), "CALL", 8050)]).toBe(1.1);
  });

  it("writes when only a delta moves, which the cost, the IV and the vega can all hide", async () => {
    // spot moving between two strikes changes the deltas while a mid barely does, and the delta is
    // the figure the owner manages by — a row that kept the morning's delta beside the close's
    // cost would chart a risk that was never there at the close
    held("held");
    await sweeper(quiet(5.0, 10.5, 1.0, 0.16)).sweep();
    const after = writes();
    await sweeper(quiet(5.0, 10.5, 1.0, 0.21)).sweep();
    expect(writes()).toBeGreaterThan(after);

    const row = db.prepare("select legs_delta from position_samples").get() as { legs_delta: string };
    expect(JSON.parse(row.legs_delta)[buildSpxCode(future(), "CALL", 8050)]).toBe(0.21);
  });

  it("does not stop the sweep if recording fails", async () => {
    // the sweep's job is the alarm. A sample is a nice-to-have and must never be the reason a
    // breach goes unmessaged, so the write is guarded like the telegram send is.
    const id = held("held");
    monitor({ threshold: 0.05 });
    db.exec("DROP TABLE position_samples");
    const s = sweeper((codes) => Promise.resolve(codes.map((c) => ({
      code: c, name: c, option_delta: 0.9, mid_price: 5.0,
    }))));
    await s.sweep();

    expect(sent.some((t) => t.includes("⚠️")), "the alarm still went out").toBe(true);
    expect(s.health.lastSweepOk()).toBe(true);
    expect(id).toBeTruthy();
  });
});

describe("the manage-by notice", () => {
  /** A deadline is a date, and a date is the one thing the service can act on while nobody is
   *  looking (ADR 0011). Pace deliberately does NOT notify: being behind fires on every IV spike.
   *  Monitor thresholds are untouched — this is a notice about a Position, not an Alarm. */
  const held = (name: string, openedAt: string | null, dteLeft: number) => {
    const id = name.padEnd(32, "0");
    db.prepare(
      `insert into positions (id, name, strategy, strike_date, contracts, entry, legs, created_at,
                              opened_at, manage_notified_at)
       values (?, ?, null, ?, 1, 6.86, ?, '2026-08-01 00:00:00.000000', ?, null)`,
    ).run(id, name, daysFromNow(dteLeft), toSqliteJson([
      { side: "short", option_type: "CALL", strike: 8050 },
    ]), openedAt);
    return id;
  };
  const notices = () => sent.filter((t) => t.includes("manage"));
  const notifiedAt = (id: string) =>
    (db.prepare("select manage_notified_at from positions where id = ?").get(id) as
      { manage_notified_at: string | null }).manage_notified_at;

  it("speaks when a declared Position reaches the deadline", async () => {
    const id = held("condor", daysFromNow(-24), 21); // opened at 45 DTE, now at 21
    await sweeper(quoting("mid_price", { [buildSpxCode(daysFromNow(21), "CALL", 8050)]: 4.4 }))
      .sweep();

    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toContain("condor");
    expect(notices()[0]).toContain("21 DTE");
    expect(notifiedAt(id)).toBeTruthy();
  });

  it("says it once, not once a minute", async () => {
    held("condor", daysFromNow(-24), 21);
    const fetch = quoting("mid_price", { [buildSpxCode(daysFromNow(21), "CALL", 8050)]: 4.4 });
    await sweeper(fetch).sweep();
    await sweeper(fetch).sweep();
    await sweeper(fetch).sweep();
    expect(notices()).toHaveLength(1);
  });

  it("stays quiet on a Position whose Opened nobody declared, and logs nothing", async () => {
    // THE reason `opened_at` is the opt-in. Three of the five Positions in the live book were
    // already inside 21 DTE when this shipped; without the gate the first sweep after deploy
    // would have fired three retroactive notices at once and looked like a fault.
    //
    // The silence is asserted as well as the quiet. Removing the gate is caught by the COMPILER
    // — opened_at is `string | null` and dteAtOpen takes a `string` — but a mutation sweep showed
    // the test itself could not tell "skipped" from "threw and was swallowed", which would log a
    // failure every minute for ever.
    const errors: unknown[][] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      held("undeclared", null, 4);
      await sweeper(quoting("mid_price", { [buildSpxCode(daysFromNow(4), "CALL", 8050)]: 0.1 }))
        .sweep();
    } finally {
      console.error = realError;
    }
    expect(notices()).toEqual([]);
    expect(errors, `an undeclared Position should be silent: ${JSON.stringify(errors)}`).toEqual([]);
  });

  it("stays quiet while the deadline is still ahead", async () => {
    held("condor", daysFromNow(-6), 39); // opened at 45, now at 39: eighteen days to go
    await sweeper(quoting("mid_price", { [buildSpxCode(daysFromNow(39), "CALL", 8050)]: 6.5 }))
      .sweep();
    expect(notices()).toEqual([]);
  });

  it("speaks for a Position already past the deadline when it is declared", async () => {
    // declaring an Opened on something already inside 21 DTE is not a mistake — it is overdue,
    // and overdue is exactly what the notice is for
    held("late", daysFromNow(-41), 4);
    await sweeper(quoting("mid_price", { [buildSpxCode(daysFromNow(4), "CALL", 8050)]: 0.1 }))
      .sweep();
    expect(notices()).toHaveLength(1);
  });

  it("carries the pace, because that is what decides what to do about it", async () => {
    held("condor", daysFromNow(-24), 21);
    await sweeper(quoting("mid_price", { [buildSpxCode(daysFromNow(21), "CALL", 8050)]: 4.4 }))
      .sweep();
    // Entry 6.86 opened at 45 DTE, now 21: on-pace 4.69, and 4.40 is ahead of it
    expect(notices()[0]).toMatch(/4\.69/);
    expect(notices()[0]).toMatch(/ahead/i);
  });

  it("tries again next sweep when the notice could not be delivered", async () => {
    // ADR 0011: "Manage-by raises exactly one notice." A send that throws must leave the deadline
    // un-stamped, or that one notice is zero notices — for ever, since the stamp is what stops it
    // being raised again.
    //
    // The case below this one is named "if the notice fails" but unconfigures telegram, where the
    // send is a no-op that cannot fail. Nothing exercised a send that throws, and `notify` swallows
    // every send error — it must, because the sweep's job is the alarm — so the stamp could not be
    // conditioned on it throwing, however the comment there read.
    const id = held("condor", daysFromNow(-24), 21);
    const fetch = quoting("mid_price", { [buildSpxCode(daysFromNow(21), "CALL", 8050)]: 4.4 });
    let down = true;
    const flaky = (text: string) => {
      if (down) throw new Error("telegram down");
      sent.push(text);
    };

    await sweeper(fetch, {}, flaky).sweep();
    expect(notices(), "nothing reached the phone").toHaveLength(0);
    expect(notifiedAt(id), "so the deadline must still be owed").toBeNull();

    down = false;
    await sweeper(fetch, {}, flaky).sweep();
    expect(notices(), "the next sweep delivers it").toHaveLength(1);
    expect(notifiedAt(id)).toBeTruthy();
  });

  it("stamps the deadline when telegram is not configured, rather than owing it for ever", async () => {
    // "not configured" is not a failure to retry: there is nowhere to deliver, and a notice held
    // open would be reconsidered every 15 seconds for ever, logging the same line each time. So it
    // counts as delivered-as-far-as-possible, which is the one asymmetry in notify's answer.
    const id = held("condor", daysFromNow(-24), 21);
    const fetch = quoting("mid_price", { [buildSpxCode(daysFromNow(21), "CALL", 8050)]: 4.4 });
    await sweeper(fetch, { telegramBotToken: "", telegramChatId: "" }).sweep();
    expect(notices()).toHaveLength(0);
    expect(notifiedAt(id)).toBeTruthy();
  });

  it("does not stop the sweep, nor the alarms, if the notice fails", async () => {
    held("condor", daysFromNow(-24), 21);
    monitor({ threshold: 0.05, strike_date: daysFromNow(21) });
    const s = sweeper((codes) => Promise.resolve(codes.map((c) => ({
      code: c, name: c, option_delta: 0.9, mid_price: 4.4,
    }))), { telegramBotToken: "", telegramChatId: "" }); // unconfigured: the send is a no-op
    await s.sweep();
    expect(s.health.lastSweepOk()).toBe(true);
  });
});
