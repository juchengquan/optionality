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
import type { QuoteRecord } from "./quotes.ts";
import { type FakeProvider, fakeFetcher } from "../testing/harness.ts";
import { MonitorSweeper, STALE_AFTER_SWEEPS } from "./sweeper.ts";

const CODE = "US.SPXW261218C6500000";
/** A contract the Provider cannot price. How it SAYS so is its own business and is tested in
 *  `opend/client.test.ts`; what reaches the sweep is the code, named in the batch (#168). */
const POISON = "US.SPXW260918C99999000";

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

const sweeper = (
  fetchQuotes: FakeProvider, over: Partial<Settings> = {},
  /** overridden only where the test is about a send that FAILS, which a collecting fake cannot do */
  send: (text: string) => void | Promise<void> = (text) => { sent.push(text); },
) =>
  new MonitorSweeper({
    db,
    settings: settingsFor({ ...BASE, ...over }),
    fetchQuotes: fakeFetcher(fetchQuotes),
    send,
    now: () => now,
  });

/** A fetcher returning one field per code, read from a mutable table so a test can move the market. */
const quoting = (field: string, values: Record<string, number>): FakeProvider =>
  (codes) => Promise.resolve(
    codes.filter((c) => c in values).map((c) => ({ code: c, name: c, [field]: values[c] })),
  );

/** The live sweep cadence (`MONITOR_INTERVAL_SECONDS` in .env), in seconds.
 *
 *  Tests about a window of TIME sweep at this, rather than jumping the clock once: a window is
 *  ~120 sweeps wide at the live cadence, and the two that matter below are only ever crossed
 *  correctly if nothing a sweep does to the alarm stamp depends on there having been few of them. */
const CADENCE = 15;

/** One sweep, a cadence later. The clock MOVES between sweeps, as the scheduler makes it. */
const tick = async (s: MonitorSweeper) => {
  now = new Date(now.getTime() + CADENCE * 1000);
  await s.sweep();
};

/** Sweep at the live cadence for `seconds` of wall clock — the sweeps a window actually holds. */
const sweepFor = async (s: MonitorSweeper, seconds: number) => {
  for (let elapsed = 0; elapsed < seconds; elapsed += CADENCE) await tick(s);
};

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

    // the threshold EXACTLY, which is what this case is named for: the bell flips truthfully AT it,
    // with no value hysteresis (CLAUDE.md). The body used 0.61 and 0.59 and never went near 0.60,
    // so the name outran it — and the engine's headline invariant was held only one layer up, in
    // `domain/monitor.test.ts` and the golden corpus.
    values[CODE] = 0.6;
    await s.sweep(); // re-armed, and 0.60 >= 0.60: fires again
    expect(sent).toHaveLength(3);
    expect(row(id)!.triggered).toBe(1);
    expect(row(id)!.last_value).toBe(0.6);
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
    const s = sweeper(quoting("option_delta", values),
      { alarmCooldownSeconds: 120, monitorIntervalSeconds: CADENCE });

    await s.sweep();
    expect(sent).toHaveLength(1);

    values[CODE] = 0.59;
    await tick(s); // bell clears, recovery suppressed by the cooldown
    expect(row(id)!.triggered).toBe(0); // the display stays truthful
    expect(sent).toHaveLength(1);

    values[CODE] = 0.61;
    await tick(s); // re-breach inside the cooldown: bell on, still silent
    expect(row(id)!.triggered).toBe(1);
    expect(sent).toHaveLength(1);

    // and the cooldown is counted from the last MESSAGE, not from the last sweep. The sweeps in
    // between are what makes that visible: they say nothing, so they must not move the stamp
    // either. This jumped the clock once from a pair of sweeps taken at one instant, and a stamp
    // re-written on every evaluated sweep looked identical — at the live cadence that stamp is
    // refreshed every 15s and a cooldown never expires at all (mutation sweep, 2026-11-09).
    await sweepFor(s, 75); // steady above the threshold: nothing to say
    expect(sent).toHaveLength(1);

    values[CODE] = 0.55;
    await tick(s); // 120s since the alarm, to the second: the cooldown is up
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("back below");
  });

  it("re-reminds while a breach persists, on a fixed cadence", async () => {
    // AT THE LIVE CADENCE, and that is the point of the test rather than a detail of it. A
    // half-hour window holds about 120 sweeps, and the reminder is due only because none of them
    // touched `last_alarm_at` — the stamp is the record of having SPOKEN. Done as two sweeps at
    // one instant and a single 31-minute jump, this passed with the stamp hoisted out of its
    // `if (decision.notice !== null)`, which at 15s re-stamps ~120 times inside the window and
    // means a persisting breach is never reminded about again (mutation sweep, 2026-11-09).
    monitor({ threshold: 0.6 });
    const values = { [CODE]: 0.7 };
    const s = sweeper(quoting("option_delta", values),
      { alarmRepeatSeconds: 1800, monitorIntervalSeconds: CADENCE });

    await s.sweep();
    expect(sent).toHaveLength(1); // the edge alarm

    await sweepFor(s, 1500); // 100 sweeps, all inside the repeat window: silent
    expect(sent).toHaveLength(1);

    await sweepFor(s, 360); // the window is up somewhere in here
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("still");
    expect(sent[1]).toContain("reminder");

    await sweepFor(s, 1500); // the reminder reset the window, and these do not
    expect(sent).toHaveLength(2);

    values[CODE] = 0.5;
    await tick(s);
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
      fetchQuotes: fakeFetcher(quoting("option_delta", { [CODE]: 0.9 })),
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
    const s = sweeper((codes) => { calls.push(codes); return Promise.resolve([]); });
    await s.sweep();

    expect(calls).toEqual([]); // nothing active -> no API call at all
    const m = row(id)!;
    expect(m.enabled).toBe(0);
    // a vanished contract and a monitor you muted on purpose are otherwise identical rows
    expect(m.disabled_reason).toBe("expired");
    expect(sent.some((t) => t.includes("expired") && t.includes("muted"))).toBe(true);
    // and a sweep with nothing to fetch is a sweep that SUCCEEDED. Everything expiring on one
    // Friday is this sweep, so without the success an empty watchlist never clears the
    // consecutive-failure count, never sends the recovered notice, and leaves /health reading
    // "starting" for ever — none of which anything asserted (mutation sweep, 2026-11-09).
    expect(s.lastSweepOk()).toBe(true);
    expect(s.alarmState()).toEqual({ label: "active", bad: false });
  });

  it("is still watching on the expiry day itself, and still fetches it", async () => {
    // WHICH date the sweep reckons expiry against. `expiryVerdict`'s own boundary is golden-cased,
    // but nothing pinned the `today` the sweep hands it: every other fixture here is a day past or
    // a month out, so a one-day drift in `utcDate` muted a monitor on its own expiry day — the day
    // its figures matter most — with all 86 of these still green (mutation sweep, 2026-11-09).
    const id = monitor({ strike_date: daysFromNow(0) });
    const calls: string[][] = [];
    const s = sweeper((codes) => {
      calls.push(codes);
      return Promise.resolve(codes.map((c) => ({ code: c, name: c, option_delta: 0.1 })));
    });
    await s.sweep();

    expect(calls).toEqual([[CODE]]);
    const m = row(id)!;
    expect(m.enabled).toBe(1);
    expect(m.disabled_reason).toBeNull();
    expect(sent).toEqual([]); // nothing expired, so nothing to say
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
    ).run(pid, daysFromNow(-30), toSqliteJson([{ side: "short", option_type: "CALL", strike: 8050 }]));
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
  /** Reports the poison as unknown rather than rejecting the batch with moomoo's sentence: the
   *  drop-and-retry that read that sentence is inside the moomoo client now, and the sweep is
   *  handed the answer (#168). */
  const poisonable = (goodValue = 0.7): FakeProvider => (codes) => Promise.resolve({
    records: codes.filter((c) => c !== POISON)
      .map((c) => ({ code: c, name: c, option_delta: goodValue })),
    unknown: codes.filter((c) => c === POISON),
  });

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

  it("keeps saying so while it is still broken, and says how long", async () => {
    // The gap this closes, measured: on 2026-11-08 OpenD exited and 646 sweeps failed over
    // 2h42m, and the owner got ONE message, in the first minute. The notice was right; the
    // silence after it meant the engine knew something the owner no longer did.
    monitor();
    let failing = true;
    const s = sweeper((codes) => {
      if (failing) return Promise.reject(new Error("Client connection failed!"));
      return Promise.resolve(codes.map((c) => ({ code: c, name: c, option_delta: 0.1 })));
    });
    const limit = settingsFor(BASE).degradedAfterFailures;
    const started = now;

    for (let i = 0; i < limit; i += 1) await s.sweep();
    expect(sent.filter((t) => t.includes("degraded"))).toHaveLength(1);
    expect(sent[0]).toContain("⚠️ monitoring degraded:");

    // half an hour of failing sweeps: the reminder is due by the CLOCK, so time has to move
    now = new Date(started.getTime() + 1_799_000);
    await s.sweep();
    expect(sent.filter((t) => t.includes("degraded"))).toHaveLength(1);

    now = new Date(started.getTime() + 1_801_000);
    await s.sweep();
    const reminders = sent.filter((t) => t.includes("still degraded"));
    expect(reminders).toHaveLength(1);
    expect(reminders[0]).toContain("over 30m");

    // and not again until the next interval
    now = new Date(started.getTime() + 1_900_000);
    await s.sweep();
    expect(sent.filter((t) => t.includes("still degraded"))).toHaveLength(1);

    failing = false;
    now = new Date(started.getTime() + 9_720_000);
    await s.sweep();
    expect(sent.find((t) => t.includes("recovered"))).toBe("✅ monitoring recovered after 2h42m");
    now = started;
  });

  it("starts a new outage cleanly rather than reporting the last one's age", async () => {
    // the stamps are cleared on recovery, so a second outage an hour later does not claim to
    // have been broken since the first one
    monitor();
    let failing = true;
    const s = sweeper((codes) => {
      if (failing) return Promise.reject(new Error("down"));
      return Promise.resolve(codes.map((c) => ({ code: c, name: c, option_delta: 0.1 })));
    });
    const limit = settingsFor(BASE).degradedAfterFailures;
    const started = now;

    for (let i = 0; i < limit; i += 1) await s.sweep();
    failing = false;
    await s.sweep();

    failing = true;
    now = new Date(started.getTime() + 3_600_000);
    for (let i = 0; i < limit; i += 1) await s.sweep();
    now = new Date(started.getTime() + 3_600_000 + 1_801_000);
    await s.sweep();
    const reminders = sent.filter((t) => t.includes("still degraded"));
    expect(reminders).toHaveLength(1);
    // 30m into the SECOND outage, not 1h30m since the first
    expect(reminders[0]).toContain("over 30m");
    now = started;
  });

  it("notices a provider that keeps dropping and recovering, which the run cannot", async () => {
    // The outage of 2026-11-08 that the service missed entirely: a launchd agent was killing
    // OpenD 27s after every start and restarting it a minute later, so the sweep failed roughly
    // a third of the time for an hour. Every success reset the consecutive counter below its
    // threshold, so "monitoring degraded" never fired — while a five-minute total outage would
    // have fired in the first minute. The owner found it by looking at the dashboard.
    monitor();
    let failing = true;
    const s = sweeper((codes) => {
      if (failing) return Promise.reject(new Error("Client connection failed!"));
      return Promise.resolve(codes.map((c) => ({ code: c, name: c, option_delta: 0.1 })));
    });
    const started = now;

    // fail, succeed, fail, succeed… five failures inside the window, never two in a row
    for (let i = 0; i < 10; i += 1) {
      now = new Date(started.getTime() + i * 90_000);
      failing = i % 2 === 0;
      await s.sweep();
    }

    // the run never reached the threshold, so the sustained notice stayed silent — correctly
    expect(sent.filter((t) => t.includes("monitoring degraded"))).toEqual([]);
    expect(s.consecutiveFailures()).toBe(0);
    // and the RATE spoke instead
    const said = sent.filter((t) => t.includes("unreliable"));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("failed sweeps in the last 15m");
    now = started;
  });

  it("does not call a single blip unreliable", async () => {
    monitor();
    let failing = true;
    const s = sweeper((codes) => {
      if (failing) return Promise.reject(new Error("down"));
      return Promise.resolve(codes.map((c) => ({ code: c, name: c, option_delta: 0.1 })));
    });
    await s.sweep();
    failing = false;
    await s.sweep();
    expect(sent.filter((t) => t.includes("unreliable"))).toEqual([]);
  });

  it("says one thing or the other about a sustained outage, never both", async () => {
    // a long enough outage trips the run AND fills the window, and two notices about one
    // unavailable provider is the noise that teaches someone to stop reading the channel
    monitor();
    const s = sweeper(() => Promise.reject(new Error("Client connection failed!")));
    const started = now;
    for (let i = 0; i < 10; i += 1) {
      now = new Date(started.getTime() + i * 30_000);
      await s.sweep();
    }
    expect(sent.filter((t) => t.includes("monitoring degraded"))).toHaveLength(1);
    expect(sent.filter((t) => t.includes("unreliable"))).toEqual([]);
    now = started;
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

  it("calls a FIRST sweep that never came back stalled, not starting", () => {
    // the two halves of /health must not contradict each other. With the "starting" branch above
    // the staleness check, a service whose very first sweep hangs reads `alarms: "starting",
    // bad: false` for ever while `last_sweep_ok` is already false — which is the 2026-10-16
    // failure mode wearing a reassuring label. The case below sets `sweepOk` first and so cannot
    // see the ordering at all (mutation sweep, 2026-11-09).
    const s = sweeper(() => Promise.resolve([]));
    s.sweepAt = new Date(now.getTime() - interval * STALE_AFTER_SWEEPS * 1000 - 1000);
    expect(s.sweepOk).toBeNull();                       // it has not come back even once
    expect(s.lastSweepOk()).toBe(false);
    const state = s.alarmState();
    expect(state.bad).toBe(true);
    expect(state.label).toMatch(/no sweep for \d+s/);
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

  it("re-stamps the freshness of every batch, which is the only thing it is read for", async () => {
    // `fetched_at` is freshness (CLAUDE.md), and a freshness stamp written once and then kept is
    // worse than no stamp at all: /health goes on reporting the first batch's instant while the
    // market moves. Every other case here sweeps exactly once before reading it, so
    // `this.fetchAt ??= this.now()` passed the lot (mutation sweep, 2026-11-09).
    monitor();
    const s = sweeper(quoting("option_delta", { [CODE]: 0.1 }),
      { monitorIntervalSeconds: CADENCE });
    await s.sweep();
    const first = s.lastFetchAt();
    expect(first).toEqual(now);

    await tick(s);
    expect(s.lastFetchAt()).toEqual(now);
    expect(s.lastFetchAt()!.getTime()).toBeGreaterThan(first!.getTime());
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
    expect(s.lastSweepOk()).toBe(true);
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
    expect(s.lastSweepOk()).toBe(true);
  });
});

describe("a figure that never arrives", () => {
  /** The quietest bug in the system until now: `monitorValue` comes back null, the sweep writes a
   *  log line and moves on, and the rule is never evaluated again. No notice, no marker, no
   *  disable — an alarm that cannot fire looks exactly like one that is not breached. */
  const silent: FakeProvider = (codes) =>
    // the contract is priced, the watched figure simply is not in the record
    Promise.resolve(codes.map((c) => ({ code: c, name: c, mid_price: 4.2 })));

  const limit = 3;
  const few: Partial<Settings> = { quarantineAfterSilentSweeps: limit };

  it("is quarantined at the limit and not before, with a notice naming the field", async () => {
    const id = monitor();
    const s = sweeper(silent, few);

    for (let i = 1; i < limit; i += 1) {
      await s.sweep();
      expect(row(id)!.enabled, `sweep ${i}`).toBe(1);
      expect(sent).toEqual([]);
    }
    await s.sweep();

    expect(row(id)!.enabled).toBe(0);
    expect(row(id)!.disabled_reason).toBe("no-figure");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("option_delta");
    expect(sent[0]).toContain(String(limit));
    // FORGOTTEN, not held at the limit, which is what `silenceVerdict` answers with a null count
    // (ADR 0017): unmuting the rule has to give it its full run again. A sweep found this claim
    // untested — holding the count instead read identically through every other assertion here,
    // because `get(id) ?? 0` cannot tell a kept zero from an absent key.
    expect(s.silentSweeps.has(id), "the run is forgotten once it has been acted on").toBe(false);
  });

  it("counts CONSECUTIVE sweeps, so a figure that comes back is not a quarantine", async () => {
    const id = monitor();
    const values: Record<string, number> = {};
    const flaky: FakeProvider = (codes) => Promise.resolve(codes.map(
      (c) => (c in values ? { code: c, name: c, option_delta: values[c] } : { code: c, name: c }),
    ));
    const s = sweeper(flaky, few);

    await s.sweep();
    await s.sweep();
    values[CODE] = 0.1;        // it arrived: the run of silence is over
    await s.sweep();
    delete values[CODE];
    for (let i = 1; i < limit; i += 1) await s.sweep();

    // without the reset this is the fifth silent sweep of six and the rule is long gone
    expect(row(id)!.enabled).toBe(1);
    expect(sent).toEqual([]);
  });

  it("says which leg went unpriced, rather than blaming the field", async () => {
    // a combo is null when ANY leg is missing (no partial sums), which is a different fault from
    // a provider that does not send the figure at all — and the notice is the only place it shows
    const id = combo();
    const leg = buildSpxCode(future(), "CALL", 8150);
    const oneLeg: FakeProvider = (codes) => Promise.resolve(
      codes.filter((c) => c !== leg).map((c) => ({ code: c, name: c, mid_price: 4.2 })),
    );
    const s = sweeper(oneLeg, few);

    for (let i = 0; i < limit; i += 1) await s.sweep();

    expect(row(id)!.disabled_reason).toBe("no-figure");
    expect(sent[0]).toContain(leg);
    expect(sent[0]).not.toContain("mid_price");
  });

  it("says it once: the rule is disabled, so the next sweep has nothing to say", async () => {
    monitor();
    const s = sweeper(silent, few);
    for (let i = 0; i < limit + 3; i += 1) await s.sweep();
    expect(sent).toHaveLength(1);
  });

  it("evaluates every other rule in the same sweep, and is not a sweep failure", async () => {
    const other = buildSpxCode(future(), "PUT", 6425);
    const quiet = monitor();
    const loud = monitor({ code: other, option_type: "PUT", strike: 6425, threshold: 0.6 });
    const half: FakeProvider = (codes) => Promise.resolve(codes.map(
      (c) => (c === other ? { code: c, name: c, option_delta: 0.7 } : { code: c, name: c }),
    ));
    const s = sweeper(half, few);

    for (let i = 0; i < limit; i += 1) await s.sweep();

    expect(row(quiet)!.enabled).toBe(0);
    expect(row(loud)!.triggered).toBe(1);
    expect(sent.filter((t) => t.includes("crossed"))).toHaveLength(1);
    // containment: a rule that cannot be evaluated is not an engine that is failing
    expect(s.lastSweepOk()).toBe(true);
  });

  it("gives an unmuted rule its full count again", async () => {
    const id = monitor();
    const s = sweeper(silent, few);
    for (let i = 0; i < limit; i += 1) await s.sweep();
    expect(row(id)!.enabled).toBe(0);

    db.prepare("update monitors set enabled = 1, disabled_reason = null where id = ?").run(id);
    await s.sweep();

    // not re-quarantined on the first silent sweep by a count the engine still remembered
    expect(row(id)!.enabled).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it("forgets a rule that is no longer being swept", async () => {
    const id = monitor();
    const s = sweeper(silent, few);
    await s.sweep();
    expect(s.silentSweeps.size).toBe(1);

    db.prepare("delete from monitors where id = ?").run(id);
    await s.sweep();

    // left behind, the count grows for ever and a rule unmuted later resumes mid-count
    expect(s.silentSweeps.size).toBe(0);
  });

  it("can be turned off, and then only warns — which is what it did before", async () => {
    const id = monitor();
    const s = sweeper(silent, { quarantineAfterSilentSweeps: 0 });
    for (let i = 0; i < 12; i += 1) await s.sweep();
    expect(row(id)!.enabled).toBe(1);
    expect(sent).toEqual([]);
  });
});

/** A sweep that does not finish the work it was started for.
 *
 *  Everything below asserts the same thing from three directions: the engine's account of itself
 *  must not say "active" for a sweep that evaluated nothing, or evaluated only part of the
 *  watchlist. Before this, `recordSuccess` ran the moment the batch came back and everything after
 *  it — quarantine, the alarm loop, the samples, the manage-by notices — was outside any failure
 *  path. A throw there reached `scheduler`, which logs and returns, so `/health` went on reporting
 *  `last_sweep_ok: true` and `alarms: "active"` with no alarm being evaluated at all. `staleFor()`
 *  could not see it either: `sweepAt` is stamped at the START of a sweep, so one that begins every
 *  15 seconds and throws every time looks perfectly fresh.
 */
describe("a sweep that cannot finish", () => {
  // the failure is injected with a TRIGGER rather than a mock: it makes a real write fail inside
  // the real transaction, which is the shape the live fault has (a corrupt row, a disk error),
  // and it cannot drift from the code the way a stubbed method can.
  const refuseUpdates = (where = "") =>
    db.exec(`create trigger no_update before update on monitors ${where}
             begin select raise(abort, 'refused'); end`);

  it("is not a success when the work after the batch throws", async () => {
    monitor();
    const s = sweeper(quoting("option_delta", { [CODE]: 0.7 }));
    refuseUpdates();

    await s.sweep();   // resolves: the loop must never be killed by one bad sweep

    expect(s.lastSweepOk(), "a sweep that evaluated nothing reported success").toBe(false);
    expect(s.consecutiveFailures()).toBe(1);
    expect(sent.filter((t) => t.includes("crossed"))).toHaveLength(0);
  });

  it("says so loudly when the engine cannot even read the only rule there is", async () => {
    // A combo's leg codes are BUILT from its strike date (monitorLegCodes -> buildSpxCode ->
    // parseStrikeDate, which throws), in the code assembly BEFORE the batch is asked for. A
    // single-leg rule carries its code already and cannot reach this.
    //
    // #182 made this a FAILED sweep, because the shape before it recorded neither success nor
    // failure and left the previous verdict standing while nothing was swept — a silent nothing,
    // which is what that decision was about. It is not silent now: the row is quarantined and the
    // owner is told, which is work, and the rest of the watchlist is swept instead of being
    // sacrificed to signal one bad row (review 2026-11-01). The claim #182 cared about is kept
    // here as the assertion that something was SAID.
    const id = combo({ strike_date: "the first of never" });
    const s = sweeper(quoting("option_delta", { [CODE]: 0.7 }));

    await s.sweep();

    expect(sent.some((t) => t.includes("could not be read")), "it must not pass in silence").toBe(true);
    expect(row(id)!.enabled, "and the rule it cannot read is quarantined").toBe(0);
    expect(row(id)!.disabled_reason).toBe("unreadable");
  });

  it("evaluates the rest of the watchlist when one row refuses", async () => {
    // containment, and the reason the isolation is per row: a single poison row used to abort the
    // whole transaction, so one unwritable monitor silenced every alarm beside it.
    const bad = monitor();
    const good = monitor({ code: buildSpxCode(future(), "CALL", 6600), strike: 6600 });
    const s = sweeper(quoting("option_delta", {
      [CODE]: 0.7, [buildSpxCode(future(), "CALL", 6600)]: 0.8,
    }));
    refuseUpdates(`when new.id = '${bad}'`);

    await s.sweep();

    expect(row(good)!.triggered, "the good rule was taken down with the bad one").toBe(1);
    expect(sent.filter((t) => t.includes("crossed"))).toHaveLength(1);
    // and still not a clean sweep: one rule was not evaluated, which the engine must own up to
    expect(s.lastSweepOk()).toBe(false);
    expect(row(bad)!.triggered).toBe(0);
  });
});

/** A row the engine cannot read costs ONE rule, not the sweep.
 *
 *  The watchlist was hydrated eagerly, before the fetch, outside any try — so `toMonitor`'s
 *  JSON.parse or `buildSpxCode`'s refusal took the whole sweep down, every minute, with the healthy
 *  rules beside it never evaluated and no alarm ever sent. The per-row guard in `evaluate`, whose
 *  comment claims it covers "corrupt legs, an unparseable date", never got the chance.
 *
 *  This is #81's failure mode through a different door, found by review on 2026-11-01. It needs
 *  corrupt data to start, which the write paths prevent — a hand edit, a bad import or a damaged
 *  restore is the way in — and the cost when it starts is every alarm, silently.
 */
describe("a row the engine cannot read", () => {
  const corrupt = (over: Record<string, unknown>) => {
    const id = monitor(over);
    return id;
  };

  it("is quarantined, and the healthy rule beside it is still swept", async () => {
    const good = monitor();
    // a combo whose strike_date the domain refuses: monitorLegCodes builds each leg's code from it
    const bad = corrupt({
      code: "cmb-bad", option_type: "CMB", strike: 0, field: "mid_price", strike_date: "not-a-date",
      legs: [{ sign: 1, option_type: "CALL", strike: 8100 }],
    });
    const s = sweeper(quoting("option_delta", { [CODE]: 0.9 }));

    await s.sweep();

    expect(s.lastSweepOk(), "the sweep must not fail over one row").toBe(true);
    expect(row(good)!.last_checked_at, "the healthy rule was evaluated").not.toBe(null);
    expect(row(good)!.triggered).toBe(1);
    expect(row(bad)!.enabled, "the unreadable rule is quarantined").toBe(0);
    expect(row(bad)!.disabled_reason).toBe("unreadable");
    expect(sent.some((t) => t.includes("cmb-bad") && t.includes("could not be read"))).toBe(true);
  });

  it("says so once, not every sweep", async () => {
    corrupt({ code: "cmb-bad2", option_type: "CMB", strike: 0, legs: "{not json" as unknown });
    const s = sweeper(quoting("option_delta", { [CODE]: 0.9 }));

    await s.sweep();
    const after = sent.length;
    await s.sweep();

    // quarantined on the first pass, so the second does not see it among the active rows
    expect(sent.length, "a quarantined row is not re-announced").toBe(after);
  });

  it("keeps sweeping when a POSITION is the unreadable one", async () => {
    const good = monitor();
    db.prepare(`insert into positions (id, name, strategy, strike_date, contracts, entry, legs,
      created_at) values ('pbad', 'broken', 'x', '2026-12-18', 1, 1.0, '{not json',
      '2026-08-01 00:00:00.000000')`).run();
    const s = sweeper(quoting("option_delta", { [CODE]: 0.9 }));

    await s.sweep();

    // a holding cannot be quarantined — it is not a rule — so it is skipped and the sweep goes on.
    // The dashboard surfaces it: the panel has no figures for a row it cannot parse.
    expect(s.lastSweepOk()).toBe(true);
    expect(row(good)!.last_checked_at).not.toBe(null);
  });
});

/** A rule changed DURING the sweep's fetch.
 *
 *  The sweep awaits a live Provider batch, which takes real time, and the re-read after it exists
 *  because "a request may have changed the row in the meantime". It harvested `triggered` and
 *  `last_alarm_at` and never looked at `enabled` — so muting a flapping rule from the dashboard or
 *  the bot while a sweep was out got you the message anyway, with the flag left on so the eventual
 *  unmute re-fired it (review 2026-11-01).
 */
describe("a rule muted while the sweep is out", () => {
  it("is not alarmed, and its flag is left alone", async () => {
    const id = monitor();
    // mutes the row from inside the fetch, exactly as a concurrent PATCH would
    const racing: FakeProvider = (codes) => {
      db.prepare("update monitors set enabled = 0, disabled_reason = 'manual' where id = ?").run(id);
      return Promise.resolve(codes.map((c) => ({ code: c, name: c, option_delta: 0.9 })));
    };
    const s = sweeper(racing);

    await s.sweep();

    expect(sent.filter((t) => t.includes("crossed")), "it alarmed on a muted rule").toHaveLength(0);
    expect(row(id)!.triggered, "and latched the flag on a disabled row").toBe(0);
  });
});

/** The knobs' range checks were asserted here too, against `settingsFor` — the HARNESS's settings
 *  rather than the service's. `env.test.ts`'s "the knobs a service must not start on" covers the
 *  same three refusals and the same zeros-that-mean-off through `settingsFromEnv`, the real door,
 *  and names the message each one must carry; this file's copy restated it one layer further in,
 *  where the subject is not the alarm engine at all.
 */
