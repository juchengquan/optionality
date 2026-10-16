/** When runs fire on their own. Ported from tests/test_scheduler.py (ADR 0009, phase 6).
 *
 *  `validate_cron`'s own tests landed in cron.ts's caller — the schedules route — in phase 5a, where
 *  the 422 is observable. What is here is the job table: which schedules are armed, that the sweep
 *  survives a reload, and that a fired job re-reads the row before acting.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase } from "./db/open.ts";
import type { CreateRunArgs } from "./ports.ts";
import { Scheduler } from "./scheduler.ts";

let dir: string;
let db: ReturnType<typeof createDatabase>;
let created: CreateRunArgs[];
let submitted: string[];
let scheduler: Scheduler;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "optionality-sched-"));
  db = createDatabase(join(dir, "test.db"));
  created = [];
  submitted = [];
  scheduler = new Scheduler({
    db,
    createRun: (args) => { created.push(args); return `run${created.length}`.padEnd(32, "0"); },
    submit: (id) => { submitted.push(id); },
  });
});
afterEach(() => {
  scheduler.stop();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const schedule = (cron: string, enabled: boolean, tz = "America/New_York") => {
  const info = db.prepare(
    "insert into schedules (cron_expr, tz, task_type, config_name, enabled) values (?, ?, 'holdings', 'c1', ?)",
  ).run(cron, tz, enabled ? 1 : 0);
  return Number(info.lastInsertRowid);
};

describe("refreshJobs", () => {
  it("arms the enabled schedules and nothing else", async () => {
    const on = schedule("35 9 * * mon-fri", true);
    schedule("0 16 * * mon-fri", false);
    expect(scheduler.refreshJobs()).toBe(1);
    expect(scheduler.armed()).toEqual([on]);
  });

  it("leaves the sweep running, which is the whole reason it is a separate job", async () => {
    // the monitor sweep shares the scheduler, and editing a schedule must not stop the alarm engine
    // until the next restart. Here the two live in different places, so the rule is structural
    // rather than a job-id convention a future edit could break.
    let sweeps = 0;
    scheduler.startSweep(3600, async () => { sweeps += 1; }, patient);
    expect(sweeps).toBe(1); // fires at once, not an interval from now
    schedule("35 9 * * mon-fri", true);
    scheduler.refreshJobs();
    await new Promise((r) => setTimeout(r, 20));
    expect(sweeps).toBe(1); // still armed, not re-fired and not cancelled
    scheduler.stopSweep();
  });

  it("disarms a schedule that has been disabled", async () => {
    const id = schedule("35 9 * * mon-fri", true);
    scheduler.refreshJobs();
    expect(scheduler.armed()).toEqual([id]);
    db.prepare("update schedules set enabled = 0 where id = ?").run(id);
    scheduler.refreshJobs();
    expect(scheduler.armed()).toEqual([]);
  });

  it("actually stops the old job, rather than only forgetting about it", async () => {
    // Dropping the reference without stopping the timer leaves a zombie firing on the OLD
    // expression for the life of the process. Disabling the schedule hides it — the fire path
    // re-reads the row and finds it disabled — so the case that shows it is a changed cadence:
    // the row is still enabled, and the old every-second job keeps firing beside the new one.
    const id = schedule("* * * * * *", true, "UTC"); // every second
    scheduler.refreshJobs();
    db.prepare("update schedules set cron_expr = '35 9 1 1 *' where id = ?").run(id);
    scheduler.refreshJobs();
    await new Promise((r) => setTimeout(r, 1300));
    expect(created).toEqual([]); // the 1 January job is not due
  });

  it("honours the schedule's own timezone", async () => {
    // 09:35 in New York, which is 13:35 or 14:35 UTC depending on the season. Getting this wrong
    // fires the scan hours from the open.
    const id = schedule("35 9 * * mon-fri", true);
    scheduler.refreshJobs();
    const next = scheduler.nextRun(id)!;
    const inNewYork = new Intl.DateTimeFormat("en-GB", {
      timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).format(next);
    expect(inNewYork).toBe("09:35");
  });

  it("arms a schedule in a different zone at that zone's hour", async () => {
    const id = schedule("0 9 * * *", true, "Asia/Singapore");
    scheduler.refreshJobs();
    const inSingapore = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Singapore", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).format(scheduler.nextRun(id)!);
    expect(inSingapore).toBe("09:00");
  });
});

describe("firing", () => {
  it("creates a run the worker can take, marked as a schedule and as notifying", () => {
    const id = schedule("35 9 * * mon-fri", true);
    scheduler.refreshJobs();
    scheduler.fireSchedule(id);

    expect(created).toEqual([{
      taskType: "holdings", configName: "c1", trigger: "schedule",
      // a scheduled run is one nobody is watching, so it says so when it finishes
      notify: true,
    }]);
    expect(submitted).toEqual(["run1".padEnd(32, "0")]);
  });

  it("actually fires on the cron tick, not only when called by hand", async () => {
    // the one test that pays the clock: everything above calls fireSchedule directly, which proves
    // the decision but not that anything is wired to a timer
    schedule("* * * * * *", true, "UTC"); // every second
    scheduler.refreshJobs();
    await new Promise((r) => setTimeout(r, 1400));
    expect(created.length).toBeGreaterThanOrEqual(1);
    expect(submitted.length).toBe(created.length);
  });

  it("does nothing when the schedule has been disabled since the job was armed", () => {
    // the job was armed when the row looked one way; between then and now it may have changed. Called
    // directly rather than through a cron tick, as the Python's own test does — waiting a second to
    // learn nothing happened is a second spent either way.
    const id = schedule("35 9 * * mon-fri", true);
    scheduler.refreshJobs();
    db.prepare("update schedules set enabled = 0 where id = ?").run(id);
    scheduler.fireSchedule(id);
    expect(created).toEqual([]);
  });

  it("does nothing when the schedule has been deleted since the job was armed", () => {
    const id = schedule("35 9 * * mon-fri", true);
    scheduler.refreshJobs();
    db.prepare("delete from schedules where id = ?").run(id);
    scheduler.fireSchedule(id);
    expect(created).toEqual([]);
  });
});

/** A deadline no test here will reach, for the cases that are not about the watchdog. Written out
 *  at each call rather than made optional: `startSweep` requires the decision, because the absence
 *  of one is exactly what nothing noticed on 2026-10-16. `onStall` throws so that a case which
 *  stalls unexpectedly says so instead of passing quietly. */
const patient = {
  stallAfterSeconds: 3600,
  onStall: () => { throw new Error("unexpected stall"); },
};

describe("the sweep job", () => {
  it("does not start a second sweep on top of one that overran", async () => {
    // the Python's job_defaults coalesce for the same reason: two sweeps at once would make two
    // batched calls and write the same rows twice
    let running = 0;
    let peak = 0;
    // fractional seconds, because an interval can be one — the point is the overrun, not the clock
    scheduler.startSweep(0.05, async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 200));
      running -= 1;
    }, patient);
    await new Promise((r) => setTimeout(r, 300));
    scheduler.stopSweep();
    expect(peak).toBe(1);
  });

  it("stops when asked", async () => {
    let sweeps = 0;
    scheduler.startSweep(0.05, async () => { sweeps += 1; }, patient);
    expect(sweeps).toBe(1);
    scheduler.stopSweep();
    await new Promise((r) => setTimeout(r, 200));
    expect(sweeps).toBe(1);
  });

  it("survives a sweep that throws, rather than stopping the schedule", async () => {
    // a broken sweep must never kill the loop: the next minute may work
    let sweeps = 0;
    scheduler.startSweep(0.05, async () => { sweeps += 1; throw new Error("boom"); }, patient);
    await new Promise((r) => setTimeout(r, 200));
    scheduler.stopSweep();
    expect(sweeps).toBeGreaterThanOrEqual(2);
  });
});

/** Coalescing is right, and on 2026-10-16 it was also how the alarm engine died: an OpenD request
 *  that never answered left `running` true, so every later tick returned at the first line. For
 *  eight minutes nothing swept, nothing threw, and /health reported "active" throughout. The
 *  request now times out (opend/client.ts), and this is the backstop for the next way a sweep can
 *  hang — a thrown failure is recoverable, an unsettled promise is not.
 */
describe("the sweep watchdog", () => {
  /** Real timers, as the rest of this file uses: the point is the clock, not a mock of it. */
  const waitUntil = async (done: () => boolean, ms: number) => {
    const deadline = Date.now() + ms;
    while (!done() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  };

  it("abandons a sweep that has hung, so the loop resumes", async () => {
    let starts = 0;
    scheduler.startSweep(0.05, () => { starts += 1; return new Promise<void>(() => { /* hangs */ }); },
      { stallAfterSeconds: 0.3, onStall: () => { /* counted elsewhere */ } });
    await waitUntil(() => starts >= 2, 1500);
    scheduler.stopSweep();
    expect(starts).toBeGreaterThanOrEqual(2);
  });

  it("says how long the abandoned sweep had been running", async () => {
    // the age is the whole value of the notice: "a sweep has been stuck for 90s" is actionable in a
    // way that "a sweep was abandoned" is not
    const ages: number[] = [];
    scheduler.startSweep(0.05, () => new Promise<void>(() => { /* hangs */ }),
      { stallAfterSeconds: 0.3, onStall: (age) => ages.push(age) });
    await waitUntil(() => ages.length > 0, 1500);
    scheduler.stopSweep();
    expect(ages[0]).toBeGreaterThanOrEqual(0.3);
  });

  it("does not let a hung sweep that finally returns clear a newer sweep's flag", async () => {
    // the abandoned promise is still out there and will settle one day. If its `finally` clears the
    // flag, the next tick starts a sweep ON TOP of the running one — two batched calls at once,
    // which is the very thing coalescing exists to prevent.
    const resolvers: (() => void)[] = [];
    let starts = 0;
    scheduler.startSweep(0.05, () => {
      starts += 1;
      return new Promise<void>((r) => resolvers.push(r));
    }, { stallAfterSeconds: 0.3, onStall: () => { /* counted elsewhere */ } });

    await waitUntil(() => starts >= 2, 1500);
    const afterAbandon = starts;
    resolvers[0]!();                                   // the hung first sweep finally returns
    await new Promise((r) => setTimeout(r, 150));      // several ticks, well inside the second's deadline
    scheduler.stopSweep();
    expect(starts).toBe(afterAbandon);
  });

  it("still coalesces an overrun whose deadline has not passed", async () => {
    // the watchdog must not turn every overrun into an abandonment: a sweep slower than one tick is
    // normal, and two batched calls at once is what coalescing is for
    let running = 0;
    let peak = 0;
    scheduler.startSweep(0.05, async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 200));
      running -= 1;
    }, patient);
    await new Promise((r) => setTimeout(r, 300));
    scheduler.stopSweep();
    expect(peak).toBe(1);
  });
});
