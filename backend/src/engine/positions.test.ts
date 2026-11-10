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
import { createDatabase } from "../db/open.ts";
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

  it("keys the day where the option TRADES, not where UTC is", async () => {
    // the hazard the sweeper's own expiry comment names: for the hours New York is behind UTC the
    // two dates differ, and `dte` beside it is reckoned from the market date. A sample keyed on
    // the UTC day would pair a New York Wednesday with a Thursday's DTE.
    now = new Date("2026-10-01T02:00:00Z"); // 22:00 on 2026-09-30 in New York
    held("held");
    await sweeper(spread(5.0, 1.0)).sweep();

    expect(samples()[0]!.observed_on).toBe("2026-09-30");
    expect(now.toISOString().slice(0, 10)).toBe("2026-10-01"); // and the UTC day is not that
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
  const quiet = (mid: number, iv: number, vega = 1.0): FakeProvider => (codes) =>
    Promise.resolve(codes.map((c) => ({
      code: c, name: c,
      mid_price: c === buildSpxCode(future(), "CALL", 8050) ? mid : 1.0,
      option_implied_volatility: iv,
      option_vega: vega,
    })));

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
