/** When runs fire on their own. Ported from scheduler.py (ADR 0009, phase 6).
 *
 *  croner rather than APScheduler. It reads a five-field crontab the same way — `35 9 * * mon-fri`
 *  with a New York timezone fires at 09:35 Eastern, checked against the Python's own trigger. Schedule
 *  cron tz stays America/New_York (CLAUDE.md).
 */
import type { DatabaseSync } from "node:sqlite";
import { Cron } from "croner";

import { findSchedule, listSchedules } from "./db/queries.ts";
import { fromSqliteBool } from "./db/values.ts";
import type { CreateRunArgs } from "./ports.ts";
import type { TaskType } from "./schemas/config-body.ts";

export interface SchedulerDeps {
  db: DatabaseSync;
  createRun: (args: CreateRunArgs) => string;
  submit: (runId: string) => void;
}

/** The scheduler, holding the jobs it has created.
 *
 *  `refreshJobs` must only touch `schedule-*` jobs (CLAUDE.md): the monitor sweep is an interval job
 *  on the same scheduler and has to survive every reload, or editing a schedule would stop the alarm
 *  engine until the next restart. Here that is a separate map rather than an id prefix, so the rule
 *  is structural instead of a convention a future edit could break.
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
  /** how long a single sweep may be unfinished before the loop stops waiting for it */
  stallAfterSeconds: number;
  /** told the abandoned sweep's age in seconds, for the record it leaves */
  onStall: (ageSeconds: number) => void;
}

export class Scheduler {
  private readonly scheduleJobs = new Map<number, Cron>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  /** Written out rather than a `constructor(private readonly deps: ...)` parameter property.
   *  Node runs this file by ERASING types, and a parameter property is syntax that has to EMIT code —
   *  so it is rejected outright at load time (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX). tsc accepts it and
   *  vitest transforms it, which is how two of these reached main unable to run (see check-api). */
  private readonly deps: SchedulerDeps;

  constructor(deps: SchedulerDeps) {
    this.deps = deps;
  }

  /** Rebuild the schedule jobs from the database. Returns how many are now armed. */
  refreshJobs(): number {
    for (const job of this.scheduleJobs.values()) job.stop();
    this.scheduleJobs.clear();
    for (const row of listSchedules(this.deps.db)) {
      if (!fromSqliteBool(row.enabled)) continue;
      const job = new Cron(row.cron_expr, { timezone: row.tz, protect: true }, () => {
        this.fireSchedule(row.id);
      });
      this.scheduleJobs.set(row.id, job);
    }
    return this.scheduleJobs.size;
  }

  /** The sweep, on a plain interval.
   *
   *  setInterval rather than a cron expression, because an interval is what this is: the Python uses
   *  APScheduler's "interval" trigger, and a cron pattern cannot express it anyway — the seconds
   *  field tops out at 60, so a step of 60 in that position is a syntax error — and 60 is the real
   *  setting.
   *
   *  Fires immediately as well as on the interval. Without that every restart left the alarm engine
   *  quiet and the dashboard's cache empty for a whole MONITOR_INTERVAL_SECONDS — and restarts happen
   *  after every merge.
   */
  startSweep(
    everySeconds: number, sweep: () => Promise<void>, watchdog: SweepWatchdog,
  ): void {
    this.stopSweep();
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
        if (age < watchdog.stallAfterSeconds) return;
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
    this.sweepTimer = setInterval(run, everySeconds * 1000);
    run();
  }

  stopSweep(): void {
    if (this.sweepTimer !== null) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  /** Job ids, for a test to see what is armed. */
  armed(): number[] {
    return [...this.scheduleJobs.keys()].sort((a, b) => a - b);
  }

  /** When the next fire is due, for a test to prove the timezone was honoured. */
  nextRun(scheduleId: number): Date | null {
    return this.scheduleJobs.get(scheduleId)?.nextRun() ?? null;
  }

  stop(): void {
    for (const job of this.scheduleJobs.values()) job.stop();
    this.scheduleJobs.clear();
    this.stopSweep();
  }

  /** Create the run this schedule asks for and hand it to the worker.
   *
   *  Re-reads the row: the job was armed when the schedule looked one way, and between then and now
   *  it may have been disabled or deleted. A fired job for a schedule that no longer wants to fire
   *  does nothing.
   */
  fireSchedule(scheduleId: number): void {
    const row = findSchedule(this.deps.db, scheduleId);
    if (!row || !fromSqliteBool(row.enabled)) return;
    const runId = this.deps.createRun({
      taskType: row.task_type as TaskType,
      configName: row.config_name,
      trigger: "schedule",
      // a scheduled run is one nobody is watching, so it says so when it finishes
      notify: true,
    });
    this.deps.submit(runId);
  }
}
