/** The sweep loop, on a plain interval. What drives the alarm engine.
 *
 *  This held the cron schedule too, ported from scheduler.py (ADR 0009, phase 6): schedules armed
 *  from the database and fired into the worker. That half went with the run pipeline in phase 10
 *  (ADR 0014), and croner with it. This half must NOT go — main.ts calls `startSweep` with the
 *  sweeper, so deleting the scheduler would stop the alarms.
 */
/** What to do about a sweep that has not come back.
 *
 *  REQUIRED, not optional. Abandoning a sweep is a judgement only the caller can make — it knows
 *  what a sweep costs and what a missed one costs — but on 2026-10-16 the absence of any such
 *  judgement was what let the alarm engine die quietly, and an absent argument is the one thing a
 *  compiler can police. main.ts sets the deadline from the sweep interval and counts the stall as a
 *  failed sweep, which is what makes it visible on /health and, at the threshold, on Telegram.
 */
export interface SweepWatchdog {
  /** how long a single sweep may be unfinished before the loop stops waiting for it; asked at each
   *  tick when it is a function, because it follows the interval and the interval may change */
  stallAfterSeconds: number | (() => number);
  /** told the abandoned sweep's age in seconds, for the record it leaves */
  onStall: (ageSeconds: number) => void;
}

export class Scheduler {
  private sweepTimer: ReturnType<typeof setTimeout> | null = null;

  /** The sweep, on a plain interval.
   *
   *  An interval rather than a cron expression, because an interval is what this is: a cron pattern
   *  cannot express it anyway — the seconds field tops out at 60, so a step of 60 in that position
   *  is a syntax error — and 60 is a real setting. A chain of timeouts rather than setInterval since
   *  #442, so each tick can arm the next at the interval in force.
   *
   *  Fires immediately as well as on the interval. Without that every restart left the alarm engine
   *  quiet and the dashboard's cache empty for a whole MONITOR_INTERVAL_SECONDS — and restarts happen
   *  after every merge.
   */
  startSweep(
    everySeconds: number | (() => number), sweep: () => Promise<void>, watchdog: SweepWatchdog,
  ): void {
    this.stopSweep();
    const seconds = (x: number | (() => number)) => (typeof x === "function" ? x() : x);
    let running = false;
    let startedAt = 0;
    // which sweep the flag belongs to. Bumped when one is abandoned, so the abandoned promise's
    // `finally` can tell that the flag it would clear is no longer its own.
    let generation = 0;
    const run = () => {
      // coalesce, as the Python's job_defaults do: a sweep that overruns its interval must not have a
      // second one started on top of it
      if (running) {
        const age = (Date.now() - startedAt) / 1000;
        if (age < seconds(watchdog.stallAfterSeconds)) return;
        // Give up on it. Coalescing forever is indistinguishable from a stopped engine, and the
        // promise cannot be cancelled — only disowned.
        generation += 1;
        watchdog.onStall(age);
      }
      running = true;
      startedAt = Date.now();
      const mine = generation;
      // a broken sweep must never kill the loop — the next minute may work
      void Promise.resolve(sweep())
        .catch((err: unknown) => { console.error("monitor sweep failed:", err); })
        .finally(() => { if (mine === generation) running = false; });
    };
    // Each tick arms the next, at the interval in force THEN (#442): the page may change it, and a
    // timer armed once at boot would sweep at the old one until a restart. Asked before the sweep
    // starts, so a sweep that overruns does not push the next tick later.
    const tick = () => {
      this.sweepTimer = setTimeout(tick, seconds(everySeconds) * 1000);
      run();
    };
    this.sweepTimer = setTimeout(tick, seconds(everySeconds) * 1000);
    run();
  }

  stopSweep(): void {
    if (this.sweepTimer !== null) clearTimeout(this.sweepTimer);
    this.sweepTimer = null;
  }
}
