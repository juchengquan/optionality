/** The alarm engine. Ported from tests/test_monitor.py's sweep group (ADR 0009, phase 6). */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildSpxCode } from "./domain/contract.ts";
import { createDatabase } from "./db/open.ts";
import { toSqlDatetime } from "./db/time.ts";
import { toSqliteJson } from "./db/values.ts";
import { settingsFor, type Settings } from "./env.ts";
import type { QuoteFetcher, QuoteRecord } from "./quotes.ts";
import { MonitorSweeper } from "./sweeper.ts";

const CODE = "US.SPXW261218C6500000";
const POISON = "US.SPXW260918C99999000";
/** moomoo names the culprit without its market prefix. */
const UNKNOWN_ERR = `snapshot API failed: Unknown stock. ${POISON.slice(3)}`;

let dir: string;
let db: ReturnType<typeof createDatabase>;
let now: Date;
let sent: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "optionality-sweep-"));
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

/** The Python's own fixture settings: telegram configured, no cooldown. The display zone is the
 *  owner's, so a UTC-only test cannot pass by coincidence — the suite pins TZ=UTC. */
const BASE: Partial<Settings> = {
  telegramBotToken: "t", telegramChatId: "c", alarmCooldownSeconds: 0, displayTz: "Asia/Singapore",
};

let seq = 0;
const monitor = (over: Record<string, unknown> = {}) => {
  seq += 1;
  const row = {
    id: `m${seq}`.padEnd(32, "0"),
    code: CODE, strike_date: future(), option_type: "CALL", strike: 6500,
    field: "option_delta", threshold: 0.6, direction: "above", compare: "abs",
    legs: null as unknown, scope: null as string | null, enabled: 1, disabled_reason: null,
    ...over,
  };
  db.prepare(
    `insert into monitors (id, code, strike_date, option_type, strike, field, threshold,
       direction, compare, legs, scope, enabled, disabled_reason, triggered, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '2026-08-01 00:00:00.000000')`,
  ).run(row.id, row.code, row.strike_date, row.option_type, row.strike, row.field, row.threshold,
    row.direction, row.compare, row.legs === null ? null : toSqliteJson(row.legs), row.scope,
    row.enabled, row.disabled_reason);
  return row.id;
};

const combo = (over: Record<string, unknown> = {}) => monitor({
  code: "sep-condor", option_type: "CMB", strike: 0, field: "mid_price", threshold: 10,
  direction: "below",
  legs: [
    { sign: 1, option_type: "CALL", strike: 8100 },
    { sign: -1, option_type: "CALL", strike: 8150 },
  ],
  ...over,
});

const sweeper = (fetchQuotes: QuoteFetcher, over: Partial<Settings> = {}) =>
  new MonitorSweeper({
    db,
    settings: settingsFor({ ...BASE, ...over }),
    fetchQuotes,
    send: (text) => { sent.push(text); },
    now: () => now,
  });

/** A fetcher returning one field per code, read from a mutable table so a test can move the market. */
const quoting = (field: string, values: Record<string, number>): QuoteFetcher =>
  (codes) => Promise.resolve(
    codes.filter((c) => c in values).map((c) => ({ code: c, name: c, [field]: values[c] })),
  );

const row = (id: string) =>
  db.prepare("select * from monitors where id = ?").get(id) as
    { triggered: number; last_value: number | null; last_checked_at: string | null;
      enabled: number; disabled_reason: string | null } | undefined;

describe("a breach", () => {
  it("fires once and records the value", async () => {
    const id = monitor();
    const s = sweeper(quoting("option_delta", { [CODE]: 0.7 }));
    await s.sweep();
    await s.sweep(); // still breached: edge-triggered, no second alarm

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("0.700");
    const m = row(id)!;
    expect(m.triggered).toBe(1);
    expect(m.last_value).toBe(0.7);
    expect(m.last_checked_at).not.toBeNull();
  });

  it("compares magnitude in abs mode, so a put's negative delta still fires", async () => {
    const put = "US.SPXW261218P6425000";
    monitor({ code: put, option_type: "PUT", strike: 6425 });
    await sweeper(quoting("option_delta", { [put]: -0.7 })).sweep();
    expect(sent).toHaveLength(1);
  });

  it("clears and re-arms across the exact threshold", async () => {
    const id = monitor({ threshold: 0.6 });
    const values = { [CODE]: 0.61 };
    const s = sweeper(quoting("option_delta", values));

    await s.sweep();
    expect(sent).toHaveLength(1);

    values[CODE] = 0.59;
    await s.sweep(); // back across: bell clears, recovery message
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("back below");
    expect(row(id)!.triggered).toBe(0);

    values[CODE] = 0.61;
    await s.sweep(); // re-armed at the threshold: fires again
    expect(sent).toHaveLength(3);
  });

  it("works downward too, for a profit target", async () => {
    monitor({ direction: "below", threshold: 30.0, field: "mid_price" });
    const values = { [CODE]: 26.4 };
    const s = sweeper(quoting("mid_price", values));

    await s.sweep(); // 26.4 <= 30
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("fell");

    values[CODE] = 30.5;
    await s.sweep();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("back above");

    values[CODE] = 26.0;
    await s.sweep();
    expect(sent).toHaveLength(3);
  });

  it("takes a negative threshold in signed mode, in the owner's own signs", async () => {
    // a long bear call spread: the value is negative; alert when it falls to <= -4.05
    const id = combo({ threshold: -4.05, direction: "below", compare: "signed" });
    const a = buildSpxCode(future(), "CALL", 8100);
    const b = buildSpxCode(future(), "CALL", 8150);
    const values = { [a]: 26.4, [b]: 30.3 };
    const s = sweeper(quoting("mid_price", values));

    await s.sweep(); // +26.4 - 30.3 = -3.9: above -4.05, no breach
    expect(sent).toEqual([]);

    values[b] = 30.7;
    await s.sweep(); // -4.3 <= -4.05
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("-4.300");

    values[b] = 30.35;
    await s.sweep(); // -3.95 back above
    expect(sent).toHaveLength(2);
    expect(row(id)!.triggered).toBe(0);
  });
});

describe("how often it speaks", () => {
  it("keeps the bell truthful while the cooldown holds the message", async () => {
    const id = monitor({ threshold: 0.6 });
    const values = { [CODE]: 0.61 };
    const s = sweeper(quoting("option_delta", values), { alarmCooldownSeconds: 120 });

    await s.sweep();
    expect(sent).toHaveLength(1);

    values[CODE] = 0.59;
    await s.sweep(); // bell clears, recovery suppressed by the cooldown
    expect(row(id)!.triggered).toBe(0); // the display stays truthful
    expect(sent).toHaveLength(1);

    values[CODE] = 0.61;
    await s.sweep(); // re-breach inside the cooldown: bell on, still silent
    expect(row(id)!.triggered).toBe(1);
    expect(sent).toHaveLength(1);

    now = new Date(now.getTime() + 300_000); // the cooldown expires
    values[CODE] = 0.55;
    await s.sweep();
    expect(sent).toHaveLength(2);
  });

  it("re-reminds while a breach persists, on a fixed cadence", async () => {
    monitor({ threshold: 0.6 });
    const values = { [CODE]: 0.7 };
    const s = sweeper(quoting("option_delta", values), { alarmRepeatSeconds: 1800 });

    await s.sweep();
    await s.sweep(); // inside the repeat window: silent
    expect(sent).toHaveLength(1);

    now = new Date(now.getTime() + 1_860_000); // 31 minutes
    await s.sweep();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("still");
    expect(sent[1]).toContain("reminder");

    await s.sweep(); // the reminder reset the window
    expect(sent).toHaveLength(2);

    values[CODE] = 0.5;
    await s.sweep();
    expect(sent).toHaveLength(3);
    expect(sent[2]).toContain("back below");
  });

  it("sends no reminders at all when the cadence is zero", async () => {
    monitor({ threshold: 0.6 });
    const s = sweeper(quoting("option_delta", { [CODE]: 0.7 }), { alarmRepeatSeconds: 0 });
    await s.sweep();
    now = new Date(now.getTime() + 86_400_000); // a day
    await s.sweep();
    expect(sent).toHaveLength(1); // the edge alarm only
  });

  it("reads the stored last_alarm_at, not an in-memory copy", async () => {
    // the cooldown has to survive a restart: the figure lives in the row, and a sweeper that kept it
    // in memory would speak again on every deploy
    const id = monitor({ threshold: 0.6 });
    const s = sweeper(quoting("option_delta", { [CODE]: 0.7 }), { alarmCooldownSeconds: 120 });
    db.prepare("update monitors set last_alarm_at = ? where id = ?")
      .run(toSqlDatetime(new Date(now.getTime() - 10_000)), id);
    await s.sweep();
    expect(sent).toEqual([]); // 10 seconds ago, inside the 120-second cooldown
    expect(row(id)!.triggered).toBe(1);
  });

  it("says nothing at all when telegram is not configured", async () => {
    const id = monitor();
    const s = sweeper(quoting("option_delta", { [CODE]: 0.9 }),
      { telegramBotToken: "", telegramChatId: "" });
    await s.sweep();
    expect(sent).toEqual([]);
    expect(row(id)!.triggered).toBe(1); // the state is still tracked
  });

  it("survives a sender that throws", async () => {
    // a broken notifier must not stop the alarm engine recording what it saw
    const id = monitor();
    const s = new MonitorSweeper({
      db,
      settings: settingsFor(BASE),
      fetchQuotes: quoting("option_delta", { [CODE]: 0.9 }),
      send: () => { throw new Error("telegram is down"); },
      now: () => now,
    });
    await s.sweep();
    expect(row(id)!.triggered).toBe(1);
    expect(s.lastSweepOk()).toBe(true);
  });
});

describe("a value it cannot read", () => {
  it("skips a monitor whose field is absent, rather than crashing", async () => {
    const id = monitor({ field: "option_vega" });
    await sweeper(quoting("option_delta", { [CODE]: 0.9 })).sweep();
    expect(sent).toEqual([]);
    expect(row(id)!.last_value).toBeNull();
  });

  it("skips a combo with any leg missing — no partial sums, ever", async () => {
    const id = combo();
    const a = buildSpxCode(future(), "CALL", 8100);
    await sweeper(quoting("mid_price", { [a]: 26.4 })).sweep();
    expect(sent).toEqual([]);
    const m = row(id)!;
    expect(m.last_value).toBeNull();
    expect(m.triggered).toBe(0);
  });

  it("evaluates a combo as a signed sum, with both legs in ONE call", async () => {
    const id = combo();
    const a = buildSpxCode(future(), "CALL", 8100);
    const b = buildSpxCode(future(), "CALL", 8150);
    const calls: string[][] = [];
    await sweeper((codes) => {
      calls.push([...codes].sort());
      return Promise.resolve([{ code: a, mid_price: 26.4 }, { code: b, mid_price: 19.25 }]);
    }).sweep();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([a, b].sort());
    expect(sent).toHaveLength(1); // 26.4 - 19.25 = 7.15 <= 10
    expect(sent[0]).toContain("sep-condor");
    expect(sent[0]).toContain("7.150");
    const m = row(id)!;
    expect(m.triggered).toBe(1);
    expect(m.last_value).toBeCloseTo(7.15, 10);
  });
});

describe("the expiry lifecycle", () => {
  it("mutes an expired monitor with a notice, and stops fetching it", async () => {
    const id = monitor({ strike_date: past() });
    const calls: string[][] = [];
    await sweeper((codes) => { calls.push(codes); return Promise.resolve([]); }).sweep();

    expect(calls).toEqual([]); // nothing active -> no API call at all
    const m = row(id)!;
    expect(m.enabled).toBe(0);
    // a vanished contract and a monitor you muted on purpose are otherwise identical rows
    expect(m.disabled_reason).toBe("expired");
    expect(sent.some((t) => t.includes("expired") && t.includes("muted"))).toBe(true);
  });

  it("says it once, not on every sweep inside the grace period", async () => {
    const id = monitor({ strike_date: past() });
    const s = sweeper(() => Promise.resolve([]));
    await s.sweep();
    await s.sweep();
    expect(sent.filter((t) => t.includes("expired"))).toHaveLength(1);
    expect(row(id)).toBeTruthy();
  });

  it("deletes it quietly once it is past the grace period", async () => {
    const fresh = monitor({ strike_date: past() });
    const ancient = monitor({ code: "US.SPXW250101C5000000", strike_date: daysFromNow(-10) });
    await sweeper(() => Promise.resolve([])).sweep();
    expect(row(ancient)).toBeUndefined(); // beyond the 7-day grace
    expect(row(fresh)).toBeTruthy(); // yesterday's is still within it
  });

  it("deletes immediately when the retention window is zero, with a notice", async () => {
    const id = monitor({ strike_date: past() });
    await sweeper(() => Promise.resolve([]), { expiredRetentionDays: 0 }).sweep();
    expect(row(id)).toBeUndefined();
    // the retention=0 path never gets the muted notice, so it says "removed" instead
    expect(sent.some((t) => t.includes("expired") && t.includes("removed"))).toBe(true);
  });

  it("takes the position links with it, and leaves the position", async () => {
    // deleting a linked monitor raises FOREIGN KEY constraint failed — inside the sweep, every
    // minute, so the alarm engine stops altogether. The Python had this fault until writing this
    // port found it (#81). Every monitor in the live database is linked.
    const pid = "p".repeat(32);
    db.prepare(
      `insert into positions (id, name, strategy, strike_date, contracts, entry, legs, created_at)
       values (?, 'held', 'credit_spread', ?, 1, 2.0, ?, '2026-08-01 00:00:00.000000')`,
    ).run(pid, daysFromNow(-30), toSqliteJson([{ side: "sold", option_type: "CALL", strike: 8050 }]));
    const id = monitor({ strike_date: daysFromNow(-30), scope: "all", enabled: 0, disabled_reason: "expired" });
    db.prepare("insert into monitor_positions values (?, ?)").run(id, pid);

    await sweeper(() => Promise.resolve([])).sweep();

    expect(row(id)).toBeUndefined();
    expect(db.prepare("select count(*) n from monitor_positions").get()).toMatchObject({ n: 0 });
    // the Position stays: it is a holding, and it exists whether or not anything watches it
    expect(db.prepare("select name from positions where id = ?").get(pid)).toMatchObject({ name: "held" });
  });
});

describe("an unknown contract", () => {
  const poisonable = (goodValue = 0.7): QuoteFetcher => (codes) => {
    if (codes.includes(POISON)) return Promise.reject(new Error(UNKNOWN_ERR));
    return Promise.resolve(codes.map((c) => ({ code: c, name: c, option_delta: goodValue })));
  };

  it("is quarantined, not deleted, and the rest of the sweep still alarms", async () => {
    const good = monitor({ threshold: 0.6 });
    const poison = monitor({ code: POISON, strike: 99999 });
    const s = sweeper(poisonable());
    await s.sweep();

    expect(row(poison)!.enabled).toBe(0);
    // a vanished contract and a monitor you muted on purpose are otherwise identical rows
    expect(row(poison)!.disabled_reason).toBe("unknown-contract");
    expect(row(good)!.triggered).toBe(1); // evaluated in the same sweep
    expect(sent.filter((t) => t.includes("disabled"))).toHaveLength(1);
    expect(sent.find((t) => t.includes("disabled"))).toContain(POISON);
    expect(sent.filter((t) => t.includes("crossed"))).toHaveLength(1);
    // containment: this is not a sweep failure
    expect(s.lastSweepOk()).toBe(true);
  });
});

describe("the watchdog", () => {
  it("reports degraded once, at the threshold, and recovers", async () => {
    monitor();
    let failing = true;
    const s = sweeper((codes) => {
      if (failing) return Promise.reject(new Error("Client connection failed!"));
      return Promise.resolve(codes.map((c) => ({ code: c, name: c, option_delta: 0.1 })));
    });
    const limit = settingsFor(BASE).degradedAfterFailures;

    for (let i = 0; i <= limit; i += 1) await s.sweep();
    // edge-triggered, not once per failure
    expect(sent.filter((t) => t.includes("degraded"))).toHaveLength(1);
    expect(s.consecutiveFailures()).toBe(limit + 1);
    expect(s.lastSweepOk()).toBe(false);

    failing = false;
    await s.sweep();
    expect(sent.some((t) => t.includes("recovered"))).toBe(true);
    expect(s.consecutiveFailures()).toBe(0);
    expect(s.lastSweepOk()).toBe(true);
  });

  it("does not announce a recovery it was never degraded from", async () => {
    monitor();
    let failing = true;
    const s = sweeper((codes) => {
      if (failing) return Promise.reject(new Error("down"));
      return Promise.resolve(codes.map((c) => ({ code: c, name: c, option_delta: 0.1 })));
    });
    await s.sweep(); // one failure, well short of the threshold
    failing = false;
    await s.sweep();
    expect(sent.filter((t) => t.includes("recovered"))).toEqual([]);
  });

  it("labels its own health", async () => {
    const s = sweeper(() => Promise.resolve([]));
    expect(s.alarmState()).toEqual({ label: "starting", bad: false });
    s.sweepOk = true;
    expect(s.alarmState()).toEqual({ label: "active", bad: false });
    s.sweepOk = false;
    s.consecutiveFailuresCount = 1;
    expect(s.alarmState()).toEqual({ label: "STALLED (1 failed sweep)", bad: true });
    s.consecutiveFailuresCount = 3;
    expect(s.alarmState()).toEqual({ label: "STALLED (3 failed sweeps)", bad: true });
  });
});

describe("what the dashboard renders", () => {
  it("has nothing cached before the first sweep", () => {
    const s = sweeper(() => Promise.resolve([]));
    expect(s.cachedRecords()).toEqual({ byCode: {}, fetched: null });
    expect(s.cachedQuotes().fetched).toBeNull();
  });

  it("serves the sweep's own records, so the value and the bell share an instant", async () => {
    monitor();
    const s = sweeper(quoting("option_delta", { [CODE]: 0.7 }));
    await s.sweep();

    const { byCode, fetched } = s.cachedRecords();
    expect(byCode[CODE]!.option_delta).toBe(0.7);
    expect(byCode[CODE]!.fetched_at).toBe("2026-10-01 13:00:00+08:00");
    expect(fetched).toBe("2026-10-01 13:00:00+08:00");

    const { entries } = s.cachedQuotes();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.snapshot!.option_delta).toBe(0.7);
    expect(entries[0]!.triggered).toBe(true);
  });

  it("makes no OpenD call of its own", async () => {
    monitor();
    let calls = 0;
    const s = sweeper((codes) => {
      calls += 1;
      return Promise.resolve(codes.map((c) => ({ code: c, name: c, option_delta: 0.1 })));
    });
    await s.sweep();
    expect(calls).toBe(1);
    s.cachedQuotes();
    s.cachedRecords();
    expect(calls).toBe(1);
  });

  it("shows a monitor created since the last sweep with no record", async () => {
    monitor();
    const s = sweeper(quoting("option_delta", { [CODE]: 0.7 }));
    await s.sweep();
    const other = "US.SPXW261218P6000000";
    monitor({ code: other, option_type: "PUT", strike: 6000 });
    const { entries } = s.cachedQuotes();
    expect(entries.find((e) => e.code === other)!.snapshot).toBeNull();
  });

  it("drops a quarantined monitor from the watchlist", async () => {
    monitor({ code: POISON, strike: 99999 });
    monitor({ threshold: 0.6 });
    const s = sweeper((codes) => {
      if (codes.includes(POISON)) return Promise.reject(new Error(UNKNOWN_ERR));
      return Promise.resolve(codes.map((c) => ({ code: c, name: c, option_delta: 0.7 })));
    });
    await s.sweep();
    // the monitor was quarantined in the same sweep, so it is no longer enabled
    expect(s.cachedQuotes().entries.map((e) => e.code)).toEqual([CODE]);
  });

  it("still says why the row is blank if the owner re-enables a quarantined monitor", async () => {
    // the only way the kept bad-code list becomes visible: quarantine disables the monitor in the
    // same sweep, so it leaves the watchlist. Re-enable it and the row comes back with no snapshot —
    // "unknown contract" is what distinguishes that from a monitor created since the last sweep.
    const poison = monitor({ code: POISON, strike: 99999 });
    const s = sweeper((codes) => {
      if (codes.includes(POISON)) return Promise.reject(new Error(UNKNOWN_ERR));
      return Promise.resolve(codes.map((c) => ({ code: c, name: c, option_delta: 0.7 })));
    });
    await s.sweep();
    db.prepare("update monitors set enabled = 1, disabled_reason = null where id = ?").run(poison);

    const entry = s.cachedQuotes().entries.find((e) => e.code === POISON)!;
    expect(entry.snapshot).toBeNull();
    expect(entry.error).toBe("unknown contract");
  });
});

describe("positions in the batch", () => {
  it("fetches a held position's legs even when nothing alarms on them", async () => {
    // the dashboard values a position from this same fetch, and a held position must not read as
    // "—" merely because you happen not to be watching it
    db.prepare(
      `insert into positions (id, name, strategy, strike_date, contracts, entry, legs, created_at)
       values (?, 'held', 'credit_spread', ?, 1, 2.0, ?, '2026-08-01 00:00:00.000000')`,
    ).run("p".repeat(32), future(), toSqliteJson([
      { side: "sold", option_type: "CALL", strike: 8050 },
      { side: "bought", option_type: "CALL", strike: 8075 },
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
      { side: "sold", option_type: "CALL", strike: 8050 },
    ]));
    // no monitors at all: the position's legs are fetched and nothing alarms
    const s = sweeper((codes) => Promise.resolve(
      codes.map((c) => ({ code: c, name: c, option_delta: 0.99 } as QuoteRecord)),
    ));
    await s.sweep();
    expect(sent).toEqual([]);
    expect(s.lastSweepOk()).toBe(true);
    expect(s.cachedRecords().byCode[buildSpxCode(future(), "CALL", 8050)]).toBeTruthy();
  });
});
