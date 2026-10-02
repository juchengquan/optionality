/** THE single owner of run execution (ADR 0009, phase 6c).
 *
 *  "One worker thread owns run execution" (CLAUDE.md) is the Python's phrasing, and it exists because
 *  Python threads and SQLite need it to: a run holds a session for minutes, and two of them writing
 *  the same rows is a corruption. Node is single-threaded, so the same guarantee is a PROMISE QUEUE
 *  rather than a thread — one run at a time, in submission order, and a crashed run never stops the
 *  queue. Same promise, different mechanism.
 *
 *  What the queue protects is unchanged: a run makes a minutes-long OpenD conversation, and the sweep
 *  makes a single bounded call every minute. Those must not become one request budget.
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  findConfig, findRun, insertReport, insertRun, updateRunFields,
} from "./db/queries.ts";
import type { RunRow } from "./db/rows.ts";
import { toSqlDatetime } from "./db/time.ts";
import { toSqliteBool } from "./db/values.ts";
import type { Settings } from "./env.ts";
import type { CreateRunArgs } from "./ports.ts";
import { PythonRunner, TaskFailed } from "./runner.ts";
import type { NotifySender } from "./sweeper.ts";

export interface WorkerDeps {
  db: DatabaseSync;
  settings: Settings;
  runner: Pick<PythonRunner, "run" | "alert">;
  /** the telegram failure alert. The sweeper's own sender, so there is one place it can be wrong. */
  send: NotifySender;
  now?: () => Date;
  /** pinged after a SCHEDULED run succeeds, so a silent scheduler is noticed by something external */
  pingHealthcheck?: (url: string) => Promise<void>;
}

/** uuid4().hex in the Python — 32 hex characters, which the column is sized for. */
const newId = () => randomUUID().replaceAll("-", "");

export class Worker {
  private readonly deps: WorkerDeps;
  private readonly queue: string[] = [];
  private busy = false;
  private readonly retryTimers = new Set<ReturnType<typeof setTimeout>>();
  private stopped = false;
  /** resolves when the queue is empty and nothing is running; a test waits on this instead of sleeping */
  private idleWaiters: (() => void)[] = [];

  constructor(deps: WorkerDeps) {
    this.deps = deps;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** The run row, before anything has executed it. */
  createRun(args: CreateRunArgs & { attempt?: number }): string {
    const id = newId();
    insertRun(this.deps.db, {
      id,
      task_type: args.taskType,
      config_name: args.configName,
      trigger: args.trigger,
      notify: toSqliteBool(args.notify),
      attempt: args.attempt ?? 1,
      status: "queued",
      error: null,
      created_at: toSqlDatetime(this.now()),
      started_at: null,
      finished_at: null,
    });
    return id;
  }

  submit(runId: string): void {
    if (this.stopped) return;
    this.queue.push(runId);
    this.pump();
  }

  /** How many runs are waiting. Not counting the one executing, as `queue.qsize()` does not. */
  queueDepth(): number {
    return this.queue.length;
  }

  /** Stop taking work and drop any pending retry.
   *
   *  Two separate things. `submit` refusing once stopped is what prevents the retry from RUNNING;
   *  clearing the timers is what lets the process EXIT — a pending retry is up to
   *  RETRY_DELAY_SECONDS of held-open event loop, which is five minutes by default, and a deploy
   *  should not wait for it. */
  stop(): void {
    this.stopped = true;
    for (const timer of this.retryTimers) clearTimeout(timer);
    this.retryTimers.clear();
  }

  /** Resolves once nothing is queued or running. */
  idle(): Promise<void> {
    if (!this.busy && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private pump(): void {
    if (this.busy) return;
    const next = this.queue.shift();
    if (next === undefined) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const resolve of waiters) resolve();
      return;
    }
    this.busy = true;
    // A broken job must never kill the loop: whatever happens to this run, the next one runs.
    //
    // One try/catch rather than .catch().finally(). With the two, .finally still runs when .catch
    // re-throws — so the queue kept moving even without the catch, and the catch's real job (stopping
    // an unhandled rejection, which terminates the process) was invisible to every test. Here the
    // catch is what reaches the two lines that continue the queue, so a test can see it.
    void (async () => {
      try {
        await this.execute(next);
      } catch (err) {
        console.error(`run ${next} crashed outside job error handling:`, err);
      }
      this.busy = false;
      this.pump();
    })();
  }

  /** Exposed so a test can drive one run without the queue, as the Python's tests call _execute. */
  async execute(runId: string): Promise<void> {
    const { db, settings } = this.deps;
    const run = findRun(db, runId);
    if (!run) return;
    const config = findConfig(db, run.config_name);

    updateRunFields(db, runId, { status: "running", started_at: toSqlDatetime(this.now()) });

    let outcome;
    try {
      if (!config) throw new TaskFailed(`config '${run.config_name}' not found`);
      outcome = await this.deps.runner.run({
        task: run.task_type,
        config: JSON.parse(config.body) as unknown,
        notify: run.notify !== 0,
        opendHost: settings.opendHost,
        opendPort: settings.opendPort,
      });
    } catch (err) {
      await this.handleFailure(run, err, config?.body);
      return;
    }

    insertReport(db, {
      run_id: runId,
      summary: JSON.stringify({
        summary: outcome.summary, warnings: outcome.warnings, details: outcome.details,
      }),
      html: outcome.html,
      created_at: toSqlDatetime(this.now()),
    });
    updateRunFields(db, runId, {
      status: "succeeded",
      finished_at: toSqlDatetime(this.now()),
      // a report that was produced and could not be sent is a succeeded run with something to say,
      // not a failed one
      ...(outcome.notifyError
        ? { error: `run succeeded but notification failed: ${outcome.notifyError}` }
        : {}),
    });

    if (run.trigger === "schedule") await this.ping();
  }

  private async handleFailure(run: RunRow, err: unknown, configBody?: string): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    updateRunFields(this.deps.db, run.id, {
      status: "failed", error: message, finished_at: toSqlDatetime(this.now()),
    });

    // an API run failed in front of someone who asked for it; a scheduled one failed in front of
    // nobody, so it gets one retry and then says so out loud
    if (run.trigger !== "schedule") return;
    if (run.attempt === 1) {
      const retryId = this.createRun({
        taskType: run.task_type as CreateRunArgs["taskType"],
        configName: run.config_name,
        trigger: "schedule",
        notify: run.notify !== 0,
        attempt: 2,
      });
      this.scheduleRetry(this.deps.settings.retryDelaySeconds, retryId);
      return;
    }
    await this.sendFailureAlert(run, message, configBody);
  }

  private scheduleRetry(delaySeconds: number, runId: string): void {
    if (this.stopped) return;
    const timer = setTimeout(() => {
      this.retryTimers.delete(timer);
      this.submit(runId);
    }, delaySeconds * 1000);
    this.retryTimers.add(timer);
  }

  private async sendFailureAlert(run: RunRow, message: string, configBody?: string): Promise<void> {
    // the gateway logging itself out is the failure the owner hits, and the message is read on a
    // phone where "connection failed" alone says nothing about what to do
    const hint = /connect/i.test(message)
      ? " The OpenD gateway may be logged out or unreachable — check OpenD on the host."
      : "";
    const text = `❌ optionality ${run.task_type} run failed (${run.config_name}, `
      + `attempt ${run.attempt}): ${message}.${hint}`;
    const { settings } = this.deps;
    if (settings.telegramBotToken && settings.telegramChatId) {
      try {
        await this.deps.send(text);
      } catch (err) {
        console.error(`telegram failure alert for run ${run.id} could not be sent:`, err);
      }
    }

    // and an email as well, when the config asks for one. That half stays in Python: it is SMTP with
    // an app password, and the alternative is a mail dependency in a service that has four.
    if (!configBody) return;
    try {
      await this.deps.runner.alert({
        task: run.task_type,
        config: JSON.parse(configBody) as unknown,
        subject: `❌ optionality ${run.task_type} run failed`,
        message: `<p>Run <b>${run.id}</b> (${run.task_type} / ${run.config_name}) failed after `
          + `${run.attempt} attempt(s).</p><p>Error: ${message}.${hint}</p>`,
      });
    } catch (err) {
      console.error(`failure email for run ${run.id} could not be sent:`, err);
    }
  }

  private async ping(): Promise<void> {
    const url = this.deps.settings.healthcheckUrl;
    if (!url) return;
    try {
      await (this.deps.pingHealthcheck ?? defaultPing)(url);
    } catch {
      console.warn("healthcheck ping failed");
    }
  }
}

async function defaultPing(url: string): Promise<void> {
  await fetch(url, { signal: AbortSignal.timeout(10_000) });
}
