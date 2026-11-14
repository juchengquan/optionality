/** The alarm engine. Ported from tests/test_monitor.py's sweep group (ADR 0009, phase 6). */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildSpxCode } from "optionality/domain/contract";
import { createDatabase } from "../db/open.ts";
import { toSqlDatetime } from "../db/time.ts";
import { toSqliteJson } from "../db/values.ts";
import { settingsFor, type Settings } from "../env.ts";
import { type FakeProvider, fakeFetcher } from "../../testing/harness.ts";
import { STALE_AFTER_SWEEPS } from "./health.ts";
import {
  SINGLE_CODE as CODE, SWEEP_SETTINGS as BASE, insertCombo, insertMonitor, monitorState, quoting,
} from "../../testing/sweep.ts";
import { MonitorSweeper } from "./sweeper.ts";
import { findMonitor, updateMonitorFields } from "../db/queries/index.ts";
import { editedMonitor } from "../monitors.ts";
import { createSpreads, isSpreadFault } from "../create-spread.ts";

/** A contract the Provider cannot price. How it SAYS so is its own business and is tested in
 *  `opend/client.test.ts`; what reaches the sweep is the code, named in the batch (#168).
 *
 *  `CODE`, the monitor and combo builders, the quoting fetcher and the settings are
 *  `testing/sweep.ts`'s, shared with `positions.test.ts` — which drives this same sweep for what
 *  it does to HOLDINGS.
 */
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

const monitor = (over: Record<string, unknown> = {}) =>
  insertMonitor(db, { strike_date: future(), ...over });
const combo = (over: Record<string, unknown> = {}) =>
  insertCombo(db, { strike_date: future(), ...over });

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

const row = (id: string) => monitorState(db, id);

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

describe("an edited rule (#292)", () => {
  it("says it crossed when a ringing rule is edited onto a figure already past the new threshold", async () => {
    // ringing on its delta, then edited to watch its mid ≥ 4 while the mid is 5: a new rule,
    // breached from its first sweep, so the owner is told — the old rule's bell must not swallow it
    const id = monitor();
    const s = sweeper(quoting("option_delta", { [CODE]: 0.7 }));
    await s.sweep();
    expect(sent).toHaveLength(1);
    updateMonitorFields(db, id, editedMonitor(findMonitor(db, id)!, { field: "mid_price", threshold: 4 }));
    const after = sweeper(quoting("mid_price", { [CODE]: 5 }));
    await tick(after);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("crossed ≥");
  });

  it("says nothing when a ringing rule is edited onto a rule that never breached", async () => {
    const id = monitor();
    await sweeper(quoting("option_delta", { [CODE]: 0.7 })).sweep();
    updateMonitorFields(db, id, editedMonitor(findMonitor(db, id)!, { field: "mid_price", threshold: 30 }));
    await tick(sweeper(quoting("mid_price", { [CODE]: 5 })));
    // not "back below 30" about a rule that was never above it
    expect(sent).toHaveLength(1);
  });
});

describe("a ringing watch rule recorded as held (#336)", () => {
  /** The watched call sold: `POST /spreads`, one leg held, carrying the rule — at `rule`'s threshold
   *  and direction — which replaces the watch rule with the holding's own. */
  async function hold(code: string, rule: { threshold: number; direction?: string }) {
    const added = await createSpreads({ db, fetchQuotes: fakeFetcher(quoting("option_delta", { [code]: 0.7 })), now: () => now }, {
      strike_date: future(),
      spreads: [{
        name: "c6500", held: true, legs: [{ side: "short", option_type: "CALL", strike: 6500 }],
        monitors: [{ option_type: "CALL", strike: 6500, field: "option_delta", compare: "abs", direction: "above", ...rule }],
      }],
    });
    expect(isSpreadFault(added)).toBe(false);
  }

  it("does not say it crossed a second time when the holding's rule watches it the same way", async () => {
    const code = buildSpxCode(future(), "CALL", 6500);
    monitor({ code });
    await sweeper(quoting("option_delta", { [code]: 0.7 })).sweep();
    expect(sent.filter((t) => t.includes("crossed"))).toHaveLength(1);
    // the threshold moved with it, still breached: the bell is the same bell
    await hold(code, { threshold: 0.65 });
    await tick(sweeper(quoting("option_delta", { [code]: 0.7 })));
    expect(sent.filter((t) => t.includes("crossed"))).toHaveLength(1);
  });

  it("tells the owner afresh where the holding's rule watches another way and is breached", async () => {
    const code = buildSpxCode(future(), "CALL", 6500);
    monitor({ code });
    await sweeper(quoting("option_delta", { [code]: 0.7 })).sweep();
    await hold(code, { threshold: 0.8, direction: "below" });
    await tick(sweeper(quoting("option_delta", { [code]: 0.7 })));
    // a new rule, breached from its first sweep: said, as an edit to another direction says it (#292)
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("fell ≤ 0.8");
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
    expect(s.health.lastSweepOk()).toBe(true);
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

describe("a price with no book (#380)", () => {
  /** what moomoo answers for every option out of hours: bid 0 / ask 0, so the mapping derives no
   *  mid (`midPrice`), and the greeks regardless */
  const noBook: FakeProvider = (codes) =>
    Promise.resolve(codes.map((c) => ({ code: c, name: c, bid_price: 0, ask_price: 0, option_delta: 0.1 })));
  const ringing = (id: string, value: number) => updateMonitorFields(db, id, {
    triggered: 1, last_value: value, last_checked_at: "2026-09-30 20:14:59.000000",
    last_alarm_at: "2026-09-30 19:00:00.000000",
  });

  it("neither clears a ringing ABOVE rule nor says anything, and keeps its figure", async () => {
    // a 0 is never above anything: read as a price, every evening said "back below" and the
    // bell went off until the open
    const id = combo({ direction: "above", threshold: 5 });
    ringing(id, 6.2);
    const before = row(id);
    await sweeper(noBook, { alarmRepeatSeconds: 60 }).sweep();
    expect(sent).toEqual([]);
    expect(row(id)).toEqual(before);
  });

  it("neither rings a BELOW rule nor reminds one already ringing", async () => {
    // a 0 is below everything: read as a price, a profit target rang every evening and reminded
    // all night
    const quiet = combo({ code: "quiet", direction: "below", threshold: 3 });
    const loud = combo({ code: "loud", direction: "below", threshold: 3, legs: [
      { sign: 1, option_type: "CALL", strike: 8200 }, { sign: -1, option_type: "CALL", strike: 8250 },
    ] });
    ringing(loud, 2.5);
    const [q, l] = [row(quiet), row(loud)];
    await sweeper(noBook, { alarmRepeatSeconds: 1 }).sweep();
    expect(sent).toEqual([]);
    expect(row(quiet)).toEqual(q);
    expect(row(loud)).toEqual(l);
  });

  it("is not evaluated with one leg quoted and the other not, as at the open", async () => {
    // the open quotes one leg before the other: the sum of a real mid and a 0 read as one leg's
    // whole price, and rang an above rule — which is what 13 Nov's 09:25 and 09:30 alarms were
    const id = combo({ direction: "above", threshold: 5 });
    const a = buildSpxCode(future(), "CALL", 8100);
    await sweeper((codes) => Promise.resolve(codes.map((c) => (c === a
      ? { code: c, bid_price: 26.2, ask_price: 26.6, mid_price: 26.4 }
      : { code: c, bid_price: 0, ask_price: 0 })))).sweep();
    expect(sent).toEqual([]);
    expect(row(id)!.triggered).toBe(0);
    expect(row(id)!.last_value).toBeNull();
  });

  it("is held, not counted toward quarantine, however long the book stays empty", async () => {
    const id = combo();
    const s = sweeper(noBook, { quarantineAfterSilentSweeps: 1 });
    await s.sweep();
    await tick(s);
    expect(row(id)!.enabled).toBe(1);
    expect(sent).toEqual([]);
    expect(s.silentSweeps.has(id), "a held rule has no run of silence").toBe(false);
  });

  it("ends a run of silence: a held sweep between two silent ones starts the count again", async () => {
    // the run counts CONSECUTIVE sweeps with no figure, and a held sweep is an answer — so a leg that
    // goes missing again afterwards starts from one. Kept from before the hold, the count would reach
    // the limit here and quarantine a rule whose legs the Provider has been returning all along.
    const id = combo();
    const a = buildSpxCode(future(), "CALL", 8100);
    let held = false;
    const s = sweeper((codes) => Promise.resolve(codes
      .filter((c) => held || c === a)
      .map((c) => ({ code: c, name: c, bid_price: 0, ask_price: 0 }))), { quarantineAfterSilentSweeps: 3 });
    await s.sweep();
    await tick(s); // two silent sweeps: one short of the limit
    expect(s.silentSweeps.get(id)).toBe(2);
    held = true;
    await tick(s); // every leg back, one with no book: held
    held = false;
    await tick(s); // the leg missing again: the first of a new run
    expect(row(id)!.enabled).toBe(1);
    expect(s.silentSweeps.get(id)).toBe(1);
    expect(sent).toEqual([]);
  });

  it("still counts a leg the Provider did not return at all: that is silence", async () => {
    const id = combo();
    const a = buildSpxCode(future(), "CALL", 8100);
    await sweeper((codes) => Promise.resolve(codes.filter((c) => c === a)
      .map((c) => ({ code: c, bid_price: 0, ask_price: 0 }))), { quarantineAfterSilentSweeps: 1 }).sweep();
    expect(row(id)!.enabled).toBe(0);
    expect(row(id)!.disabled_reason).toBe("no-figure");
  });

  it("still counts a missing figure on any other field", async () => {
    const id = monitor({ field: "option_vega" });
    await sweeper(noBook, { quarantineAfterSilentSweeps: 1 }).sweep();
    expect(row(id)!.enabled).toBe(0);
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
    expect(s.health.lastSweepOk()).toBe(true);
    expect(s.health.alarmState()).toEqual({ label: "active", bad: false });
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
    expect(s.health.lastSweepOk()).toBe(true);
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
    expect(s.health.consecutiveFailures()).toBe(limit + 1);
    expect(s.health.lastSweepOk()).toBe(false);

    failing = false;
    await s.sweep();
    expect(sent.some((t) => t.includes("recovered"))).toBe(true);
    expect(s.health.consecutiveFailures()).toBe(0);
    expect(s.health.lastSweepOk()).toBe(true);
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
    expect(s.health.consecutiveFailures()).toBe(0);
    // and the RATE spoke instead
    const said = sent.filter((t) => t.includes("unreliable"));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("failed sweeps in the last 15m");
    now = started;
  });

  /** A bout of flapping: `sweeps` sweeps 90s apart from `from` seconds after `started`, every
   *  other one failing — five failures inside the 15m window by the ninth sweep, never two in a
   *  row. Returns how many times the owner has been called unreliable so far. */
  const flappingBouts = (over: Partial<Settings>) => {
    monitor();
    let failing = true;
    const s = sweeper((codes) => {
      if (failing) return Promise.reject(new Error("Client connection failed!"));
      return Promise.resolve(codes.map((c) => ({ code: c, name: c, option_delta: 0.1 })));
    }, over);
    const started = now;
    return async (from: number, sweeps: number) => {
      for (let i = 0; i < sweeps; i += 1) {
        now = new Date(started.getTime() + (from + i * 90) * 1000);
        failing = i % 2 === 0;
        await s.sweep();
      }
      return sent.filter((t) => t.includes("unreliable")).length;
    };
  };

  it("says a provider is unreliable again on FLAPPING_REPEAT_SECONDS, from the last notice", async () => {
    // first said at the fifth failure, 720s in; the failures after it are 180s apart, so the
    // first one 600s on is at 1440s — and at the default 1800 nothing more is said in 1710s
    const bout = flappingBouts({ flappingRepeatSeconds: 600 });
    expect(await bout(0, 20)).toBe(2);
    expect(sent.filter((t) => t.includes("monitoring degraded")), "never five in a row")
      .toEqual([]);
  });

  it("with FLAPPING_REPEAT_SECONDS=0 says it once, and not for a later bout either", async () => {
    // Nothing marks the end of a bout — a success is what flapping looks like — so nothing
    // clears the stamp, and 0 means one notice until the service restarts. At the default the
    // second bout, an hour on, is announced as the first was.
    const once = flappingBouts({ flappingRepeatSeconds: 0 });
    expect(await once(0, 20)).toBe(1);
    expect(await once(3600, 10), "an hour later, flapping again").toBe(1);
  });

  it("announces a later bout at the default interval, as it did before there was a knob", async () => {
    const bout = flappingBouts({});
    expect(await bout(0, 20)).toBe(1);
    expect(await bout(3600, 10)).toBe(2);
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
    expect(s.health.alarmState()).toEqual({ label: "starting", bad: false });
    s.health.sweepOk = true;
    expect(s.health.alarmState()).toEqual({ label: "active", bad: false });
    s.health.sweepOk = false;
    s.health.consecutiveFailuresCount = 1;
    expect(s.health.alarmState()).toEqual({ label: "STALLED (1 failed sweep)", bad: true });
    s.health.consecutiveFailuresCount = 3;
    expect(s.health.alarmState()).toEqual({ label: "STALLED (3 failed sweeps)", bad: true });
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
    s.health.sweepOk = true;                                         // the last one that finished was fine
    s.health.sweepAt = new Date(now.getTime() - interval * STALE_AFTER_SWEEPS * 1000 - 1000);
    expect(s.health.lastSweepOk()).toBe(false);
    const state = s.health.alarmState();
    expect(state.bad).toBe(true);
    expect(state.label).toMatch(/no sweep for \d+s/);
  });

  it("is not stalled merely because one sweep is in flight", () => {
    // a sweep takes real time and may straddle a tick; that is overrun, not death
    const s = sweeper(() => Promise.resolve([]));
    s.health.sweepOk = true;
    s.health.sweepAt = new Date(now.getTime() - interval * 1000);
    expect(s.health.lastSweepOk()).toBe(true);
    expect(s.health.alarmState()).toEqual({ label: "active", bad: false });
  });

  it("calls a FIRST sweep that never came back stalled, not starting", () => {
    // the two halves of /health must not contradict each other. With the "starting" branch above
    // the staleness check, a service whose very first sweep hangs reads `alarms: "starting",
    // bad: false` for ever while `last_sweep_ok` is already false — which is the 2026-10-16
    // failure mode wearing a reassuring label. The case below sets `sweepOk` first and so cannot
    // see the ordering at all (mutation sweep, 2026-11-09).
    const s = sweeper(() => Promise.resolve([]));
    s.health.sweepAt = new Date(now.getTime() - interval * STALE_AFTER_SWEEPS * 1000 - 1000);
    expect(s.health.sweepOk).toBeNull();                       // it has not come back even once
    expect(s.health.lastSweepOk()).toBe(false);
    const state = s.health.alarmState();
    expect(state.bad).toBe(true);
    expect(state.label).toMatch(/no sweep for \d+s/);
  });

  it("is starting, not stalled, before the first sweep", () => {
    // launchd restarts after every merge, and a service that has not swept yet must not cry stall
    const s = sweeper(() => Promise.resolve([]));
    expect(s.health.lastSweepOk()).toBe(true);
    expect(s.health.alarmState()).toEqual({ label: "starting", bad: false });
  });

  it("counts an abandoned sweep as a failure, and says so at the threshold", async () => {
    // what the scheduler's watchdog calls. Without this a stall is cleared by the next tick and
    // leaves no trace at all.
    const s = sweeper(() => Promise.resolve([]));
    const limit = settingsFor(BASE).degradedAfterFailures;
    for (let i = 0; i < limit; i += 1) await s.health.recordStall(90);
    expect(s.health.consecutiveFailures()).toBe(limit);
    expect(s.health.lastSweepOk()).toBe(false);
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
    expect(s.health.lastFetchOk()).toBeNull();                       // nothing asked yet, nothing to claim
    await s.sweep();
    expect(s.health.lastFetchOk()).toBe(false);
    failing = false;
    await s.sweep();
    expect(s.health.lastFetchOk()).toBe(true);
  });

  it("re-stamps the freshness of every batch, which is the only thing it is read for", async () => {
    // `fetched_at` is freshness (CLAUDE.md), and a freshness stamp written once and then kept is
    // worse than no stamp at all: /health goes on reporting the first batch's instant while the
    // market moves. Every other case here sweeps exactly once before reading it, so
    // `this.health.fetchAt ??= this.now()` passed the lot (mutation sweep, 2026-11-09).
    monitor();
    const s = sweeper(quoting("option_delta", { [CODE]: 0.1 }),
      { monitorIntervalSeconds: CADENCE });
    await s.sweep();
    const first = s.health.lastFetchAt();
    expect(first).toEqual(now);

    await tick(s);
    expect(s.health.lastFetchAt()).toEqual(now);
    expect(s.health.lastFetchAt()!.getTime()).toBeGreaterThan(first!.getTime());
  });

  it("re-stamps when each sweep BEGAN, which is what staleness is measured from", async () => {
    // The sibling hole, found by the same sweep and still open: every case about staleness above
    // sets `sweepAt` by hand to state an age, so `this.sweepAt ??= at` passed all of them — and
    // the service it describes is one whose `last_sweep_at` freezes at the first sweep of the
    // process and then reports itself STALLED for ever while sweeping every 15 seconds.
    monitor();
    const s = sweeper(quoting("option_delta", { [CODE]: 0.1 }),
      { monitorIntervalSeconds: CADENCE });
    await s.sweep();
    const first = s.health.lastSweepAt();
    expect(first).toEqual(now);

    await sweepFor(s, CADENCE * STALE_AFTER_SWEEPS * 2);
    expect(s.health.lastSweepAt()).toEqual(now);
    expect(s.health.lastSweepAt()!.getTime()).toBeGreaterThan(first!.getTime());
    // and the engine therefore still calls itself active, which is the half /health reports
    expect(s.health.alarmState()).toEqual({ label: "active", bad: false });
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
    expect(s.health.lastSweepOk()).toBe(true);
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

    expect(s.health.lastSweepOk(), "a sweep that evaluated nothing reported success").toBe(false);
    expect(s.health.consecutiveFailures()).toBe(1);
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
    expect(s.health.lastSweepOk()).toBe(false);
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

    expect(s.health.lastSweepOk(), "the sweep must not fail over one row").toBe(true);
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
    expect(s.health.lastSweepOk()).toBe(true);
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

/** A rule REDEFINED while the sweep is out (#359's review): a held 1×3 corrected to a 1×2 takes its
 *  value rule with it, and a PATCH to /monitors may change a rule's field (#292). The batch was
 *  valued against the row read BEFORE the fetch, so an answer to the old definition must not be
 *  written onto, or alarmed for, the new one: the next sweep reads the rule as it now is. */
describe("a rule redefined while the sweep is out", () => {
  const ratio = (qty: number) => [
    { sign: 1, option_type: "CALL", strike: 8100 }, { sign: -1, option_type: "CALL", strike: 8150, qty },
  ];
  /** the 8100 at 2.00 and the 8150 at 1.00: the 1×3 is worth −1, the 1×2 nothing */
  const mids = (codes: string[]) => codes.map((c) => ({ code: c, name: c, mid_price: c.endsWith("C8100000") ? 2 : 1 }));

  it("is not alarmed on the old definition's figure when its legs change", async () => {
    const id = combo({ code: "ratio", threshold: 0.8, direction: "above", compare: "abs", legs: ratio(3) });
    const racing: FakeProvider = (codes) => {
      db.prepare("update monitors set legs = ? where id = ?").run(JSON.stringify(ratio(2)), id);
      return Promise.resolve(mids(codes));
    };
    await sweeper(racing).sweep();
    expect(sent, "it alarmed a 1×2 on the 1×3's value").toEqual([]);
    expect([row(id)!.triggered, row(id)!.last_value]).toEqual([0, null]);

    // the next sweep values the rule as it now is: 0, inside 0.8
    await sweeper((codes) => Promise.resolve(mids(codes))).sweep();
    expect(sent).toEqual([]);
    expect(row(id)!.last_value).toBe(0);
  });

  it("is not alarmed on the old field's figure when its field changes", async () => {
    const id = monitor({ threshold: 0.6 });
    const racing: FakeProvider = (codes) => {
      db.prepare("update monitors set field = 'mid_price' where id = ?").run(id);
      return Promise.resolve(codes.map((c) => ({ code: c, name: c, option_delta: 0.9, mid_price: 0.1 })));
    };
    await sweeper(racing).sweep();
    expect(sent.filter((t) => t.includes("crossed"))).toHaveLength(0);
    expect([row(id)!.triggered, row(id)!.last_value]).toEqual([0, null]);
  });
});

/** The knobs' range checks were asserted here too, against `settingsFor` — the HARNESS's settings
 *  rather than the service's. `env.test.ts`'s "the knobs a service must not start on" covers the
 *  same three refusals and the same zeros-that-mean-off through `settingsFromEnv`, the real door,
 *  and names the message each one must carry; this file's copy restated it one layer further in,
 *  where the subject is not the alarm engine at all.
 */
