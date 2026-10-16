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
import { MonitorSweeper, STALE_AFTER_SWEEPS } from "./sweeper.ts";

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

/** The failure mode of 2026-10-16: not a sweep that failed, but a sweep that never came back.
 *
 *  Every field /health reads was green throughout — `sweepAt` is stamped when a sweep BEGINS, the
 *  failure counters only move when a fetch returns, and `opend` was a TCP probe answered by a
 *  gateway that would not log in. Three fields, no new information between them, and eight minutes
 *  of a dead alarm engine reported as "active".
 */
describe("a sweep that never came back", () => {
  const interval = settingsFor(BASE).monitorIntervalSeconds;

  it("calls itself stalled when no sweep has begun for several intervals", () => {
    const s = sweeper(() => Promise.resolve([]));
    s.sweepOk = true;                                         // the last one that finished was fine
    s.sweepAt = new Date(now.getTime() - interval * STALE_AFTER_SWEEPS * 1000 - 1000);
    expect(s.lastSweepOk()).toBe(false);
    const state = s.alarmState();
    expect(state.bad).toBe(true);
    expect(state.label).toMatch(/no sweep for \d+s/);
  });

  it("is not stalled merely because one sweep is in flight", () => {
    // a sweep takes real time and may straddle a tick; that is overrun, not death
    const s = sweeper(() => Promise.resolve([]));
    s.sweepOk = true;
    s.sweepAt = new Date(now.getTime() - interval * 1000);
    expect(s.lastSweepOk()).toBe(true);
    expect(s.alarmState()).toEqual({ label: "active", bad: false });
  });

  it("is starting, not stalled, before the first sweep", () => {
    // launchd restarts after every merge, and a service that has not swept yet must not cry stall
    const s = sweeper(() => Promise.resolve([]));
    expect(s.lastSweepOk()).toBe(true);
    expect(s.alarmState()).toEqual({ label: "starting", bad: false });
  });

  it("counts an abandoned sweep as a failure, and says so at the threshold", async () => {
    // what the scheduler's watchdog calls. Without this a stall is cleared by the next tick and
    // leaves no trace at all.
    const s = sweeper(() => Promise.resolve([]));
    const limit = settingsFor(BASE).degradedAfterFailures;
    for (let i = 0; i < limit; i += 1) await s.recordStall(90);
    expect(s.consecutiveFailures()).toBe(limit);
    expect(s.lastSweepOk()).toBe(false);
    expect(sent.filter((t) => t.includes("degraded"))).toHaveLength(1);
    expect(sent.join("\n")).toContain("90");
  });

  it("reports what the last fetch did, which is not what a port probe can tell you", async () => {
    monitor();
    let failing = true;
    const s = sweeper((codes) => {
      if (failing) return Promise.reject(new Error("Client connection failed!"));
      return Promise.resolve(codes.map((c) => ({ code: c, name: c, option_delta: 0.1 })));
    });
    expect(s.lastFetchOk()).toBeNull();                       // nothing asked yet, nothing to claim
    await s.sweep();
    expect(s.lastFetchOk()).toBe(false);
    failing = false;
    await s.sweep();
    expect(s.lastFetchOk()).toBe(true);
  });
});

/** The sweep's own cached view. Named "what the dashboard renders" until ADR 0010, which is the
 *  trouble: the dashboard polls the LIVE /quotes and never came through here, so these passed
 *  while the shipped dashboard broke the very invariant two of them assert. */
describe("the sweep's cached view", () => {
  it("has nothing cached before the first sweep", () => {
    const s = sweeper(() => Promise.resolve([]));
    expect(s.cachedRecords()).toEqual({ byCode: {}, fetched: null });
    expect(s.cachedQuotes().fetched).toBeNull();
  });

  it("serves the sweep's own records, bell and value from one instant", async () => {
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

  it("costs no OpenD call of its own, unlike the live path the dashboard uses", async () => {
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
      { side: "sold", option_type: "CALL", strike: 8050 },
      { side: "bought", option_type: "CALL", strike: 8075 },
    ]));
    return id;
  };
  const samples = () => db.prepare(
    "select position_id, observed_on, dte, cost_to_close from position_samples order by position_id",
  ).all() as { position_id: string; observed_on: string; dte: number; cost_to_close: number }[];

  const spread = (sold: number, bought: number): QuoteFetcher => (codes) =>
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
      { side: "sold", option_type: "CALL", strike: 8050 },
      { side: "bought", option_type: "CALL", strike: 8075 },
    ]));
    return id;
  };
  const writes = () =>
    (db.prepare("select total_changes() n").get() as { n: number }).n;
  const quiet = (mid: number, iv: number, vega = 1.0): QuoteFetcher => (codes) =>
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
    expect(s.lastSweepOk()).toBe(true);
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
      { side: "sold", option_type: "CALL", strike: 8050 },
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

  it("does not stop the sweep, nor the alarms, if the notice fails", async () => {
    held("condor", daysFromNow(-24), 21);
    monitor({ threshold: 0.05, strike_date: daysFromNow(21) });
    const s = sweeper((codes) => Promise.resolve(codes.map((c) => ({
      code: c, name: c, option_delta: 0.9, mid_price: 4.4,
    }))), { telegramBotToken: "", telegramChatId: "" }); // unconfigured: the send is a no-op
    await s.sweep();
    expect(s.lastSweepOk()).toBe(true);
  });
});
