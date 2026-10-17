/** The sweep loop: what is left of the scheduler once the run pipeline went (phase 10).
 *
 *  The cron half — schedules armed from the database, fired into the worker — was deleted with the
 *  worker it fed (ADR 0014). The interval half is what drives the alarm engine, which is why the
 *  scheduler itself survives: deleting it would stop the alarms.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Scheduler } from "./scheduler.ts";

let scheduler: Scheduler;

beforeEach(() => { scheduler = new Scheduler(); });
afterEach(() => { scheduler.stop(); });

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
