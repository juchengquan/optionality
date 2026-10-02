/** The run queue and the run lifecycle. Ported from tests/test_worker.py (ADR 0009, phase 6c).
 *
 *  The Python's tests call `_execute` directly, and so do most of these: what the queue guarantees is
 *  tested separately, because "one run at a time, in order" is the invariant and not an incidental.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase } from "./db/open.ts";
import { settingsFor, type Settings } from "./env.ts";
import { HOLDINGS_BODY } from "./fixtures.ts";
import type { AlertRequest, RunOutcome, RunRequest } from "./runner.ts";
import { TaskFailed } from "./runner.ts";
import { Worker } from "./worker.ts";

let dir: string;
let db: ReturnType<typeof createDatabase>;
let sent: string[];
let alerts: AlertRequest[];
let pings: string[];
let requests: RunRequest[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "optionality-worker-"));
  db = createDatabase(join(dir, "test.db"));
  sent = [];
  alerts = [];
  pings = [];
  requests = [];
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const OK: RunOutcome = {
  html: "<p>ok</p>",
  summary: [{ strike_date: "2026-12-18" }],
  warnings: null,
  details: null,
  notifyError: null,
};

interface Script {
  outcome?: RunOutcome | (() => RunOutcome);
  fail?: Error;
  alertResult?: { sent: boolean; reason?: string };
  alertThrows?: Error;
}

function worker(script: Script = {}, over: Partial<Settings> = {}) {
  return new Worker({
    db,
    settings: settingsFor({ retryDelaySeconds: 0, ...over }),
    runner: {
      run: async (request) => {
        requests.push(request);
        if (script.fail) throw script.fail;
        const outcome = script.outcome ?? OK;
        return typeof outcome === "function" ? outcome() : outcome;
      },
      alert: async (request) => {
        alerts.push(request);
        if (script.alertThrows) throw script.alertThrows;
        return script.alertResult ?? { sent: true };
      },
    },
    send: (text) => { sent.push(text); },
    now: () => new Date("2026-10-02T05:00:00Z"),
    pingHealthcheck: async (url) => { pings.push(url); },
  });
}

/** A worker whose pipeline is exactly the given function, so a test can count calls to it. */
function countingWorker(run: () => Promise<RunOutcome> | never, over: Partial<Settings> = {}) {
  return new Worker({
    db,
    settings: settingsFor({ retryDelaySeconds: 0, ...over }),
    runner: { run: async () => run(), alert: async () => ({ sent: false }) },
    send: () => {},
  });
}

const config = (body: unknown = HOLDINGS_BODY, name = "c1") => {
  db.prepare(
    `insert into configs (name, task_type, body, created_at, updated_at)
     values (?, 'holdings', ?, '2026-08-01 00:00:00.000000', '2026-08-01 00:00:00.000000')`,
  ).run(name, JSON.stringify(body));
};

const run = (id: string) => db.prepare("select * from runs where id = ?").get(id) as
  { status: string; error: string | null; started_at: string | null; finished_at: string | null;
    attempt: number; trigger: string; notify: number } | undefined;
const report = (id: string) => db.prepare("select * from reports where run_id = ?").get(id) as
  { html: string; summary: string } | undefined;
const runs = () => db.prepare("select * from runs order by attempt").all() as { id: string; attempt: number; trigger: string }[];

describe("a run that succeeds", () => {
  it("stores the report and marks the run finished", async () => {
    config();
    const w = worker();
    const id = w.createRun({ taskType: "holdings", configName: "c1", trigger: "api", notify: true });
    await w.execute(id);

    const r = run(id)!;
    expect(r.status).toBe("succeeded");
    expect(r.started_at).not.toBeNull();
    expect(r.finished_at).not.toBeNull();
    expect(r.error).toBeNull();
    expect(report(id)!.html).toBe("<p>ok</p>");
    expect(JSON.parse(report(id)!.summary).summary).toEqual([{ strike_date: "2026-12-18" }]);
  });

  it("asks the pipeline to notify only when the run was asked to", async () => {
    // the notification travels with the run rather than crossing the boundary twice
    config();
    const w = worker();
    await w.execute(w.createRun({ taskType: "holdings", configName: "c1", trigger: "api", notify: true }));
    await w.execute(w.createRun({ taskType: "holdings", configName: "c1", trigger: "api", notify: false }));
    expect(requests.map((r) => r.notify)).toEqual([true, false]);
  });

  it("records a report that was produced but could not be sent, without failing the run", async () => {
    config();
    const w = worker({ outcome: { ...OK, notifyError: "smtp refused" } });
    const id = w.createRun({ taskType: "holdings", configName: "c1", trigger: "api", notify: true });
    await w.execute(id);
    const r = run(id)!;
    expect(r.status).toBe("succeeded");
    expect(r.error).toBe("run succeeded but notification failed: smtp refused");
    expect(report(id)).toBeTruthy();
  });

  it("hands the pipeline the stored config body and the OpenD address", async () => {
    config();
    const w = worker({}, { opendHost: "10.0.0.2", opendPort: 11112 });
    await w.execute(w.createRun({ taskType: "holdings", configName: "c1", trigger: "api", notify: false }));
    expect(requests[0]!.config).toEqual(HOLDINGS_BODY);
    expect(requests[0]!.opendHost).toBe("10.0.0.2");
    expect(requests[0]!.opendPort).toBe(11112);
  });

  it("pings the healthcheck after a SCHEDULED run and not an api one", async () => {
    // a scheduler that has quietly stopped is noticed by something outside the service
    config();
    const w = worker({}, { healthcheckUrl: "https://hc.example/abc" });
    await w.execute(w.createRun({ taskType: "holdings", configName: "c1", trigger: "schedule", notify: false }));
    expect(pings).toEqual(["https://hc.example/abc"]);
    await w.execute(w.createRun({ taskType: "holdings", configName: "c1", trigger: "api", notify: false }));
    expect(pings).toHaveLength(1);
  });

  it("does not ping when no url is configured", async () => {
    config();
    const w = worker();
    await w.execute(w.createRun({ taskType: "holdings", configName: "c1", trigger: "schedule", notify: false }));
    expect(pings).toEqual([]);
  });

  it("survives a healthcheck that is down", async () => {
    config();
    const w = new Worker({
      db,
      settings: settingsFor({ healthcheckUrl: "https://hc.example/abc" }),
      runner: { run: async () => OK, alert: async () => ({ sent: false }) },
      send: () => {},
      pingHealthcheck: async () => { throw new Error("unreachable"); },
    });
    const id = w.createRun({ taskType: "holdings", configName: "c1", trigger: "schedule", notify: false });
    await w.execute(id);
    expect(run(id)!.status).toBe("succeeded");
  });
});

describe("a run that fails", () => {
  const boom = new TaskFailed("Client connection failed!");

  it("records why, and finishes", async () => {
    config();
    const w = worker({ fail: boom });
    const id = w.createRun({ taskType: "holdings", configName: "c1", trigger: "api", notify: false });
    await w.execute(id);
    const r = run(id)!;
    expect(r.status).toBe("failed");
    expect(r.error).toBe("Client connection failed!");
    expect(r.finished_at).not.toBeNull();
    expect(report(id)).toBeUndefined();
  });

  it("fails rather than crashing when the config has gone", async () => {
    // a schedule can outlive the config it points at if a delete slipped through
    const w = worker();
    const id = w.createRun({ taskType: "holdings", configName: "ghost", trigger: "api", notify: false });
    await w.execute(id);
    expect(run(id)!.error).toBe("config 'ghost' not found");
  });

  it("does nothing at all for a run id that is not there", async () => {
    const w = worker();
    await expect(w.execute("nope")).resolves.toBeUndefined();
  });

  it("retries once when it was scheduled, and not when it was asked for", async () => {
    // an api run failed in front of someone who asked for it; a scheduled one failed in front of
    // nobody
    config();
    const w = worker({ fail: boom });
    await w.execute(w.createRun({ taskType: "holdings", configName: "c1", trigger: "schedule", notify: true }));
    const all = runs();
    expect(all).toHaveLength(2);
    expect(all[1]!.attempt).toBe(2);
    expect(all[1]!.trigger).toBe("schedule");
    expect(sent).toEqual([]); // the retry speaks, not the first failure
    w.stop();
  });

  it("does not retry an api run", async () => {
    config();
    const w = worker({ fail: boom });
    await w.execute(w.createRun({ taskType: "holdings", configName: "c1", trigger: "api", notify: true }));
    expect(runs()).toHaveLength(1);
  });

  it("actually submits the retry when its delay elapses", async () => {
    config();
    let attempts = 0;
    // counted where the pipeline is CALLED. Counting in a `get fail()` counts twice, because the
    // fake reads the property to test it and again to throw it.
    const w = countingWorker(() => { attempts += 1; throw boom; });
    w.submit(w.createRun({ taskType: "holdings", configName: "c1", trigger: "schedule", notify: true }));
    await w.idle();
    await new Promise((r) => setTimeout(r, 30)); // the 0-second retry timer
    await w.idle();
    expect(attempts).toBe(2);
    expect(runs()).toHaveLength(2);
    w.stop();
  });

  it("does not run a pending retry once the worker has stopped", async () => {
    config();
    let attempts = 0;
    const w = countingWorker(() => { attempts += 1; throw boom; }, { retryDelaySeconds: 0.05 });
    await w.execute(w.createRun({ taskType: "holdings", configName: "c1", trigger: "schedule", notify: true }));
    w.stop();
    await new Promise((r) => setTimeout(r, 120));
    expect(attempts).toBe(1);
  });

  it("clears the pending timer, so the process can exit without waiting for it", async () => {
    // a separate claim from the one above: `submit` refusing is what stops the retry RUNNING, and
    // clearing the timer is what lets a deploy finish. RETRY_DELAY_SECONDS is 300 by default, and a
    // kickstart should not hold for five minutes.
    config();
    const w = countingWorker(() => { throw boom; }, { retryDelaySeconds: 300 });
    const before = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    await w.execute(w.createRun({ taskType: "holdings", configName: "c1", trigger: "schedule", notify: true }));
    expect(process.getActiveResourcesInfo().filter((r) => r === "Timeout").length).toBe(before + 1);
    w.stop();
    expect(process.getActiveResourcesInfo().filter((r) => r === "Timeout").length).toBe(before);
  });
});

describe("the final failure of a scheduled run", () => {
  const boom = new TaskFailed("Client connection failed!");

  it("says so on telegram, with the hint that explains what to do", async () => {
    config();
    const w = worker({ fail: boom }, { telegramBotToken: "t", telegramChatId: "42" });
    await w.execute(w.createRun({
      taskType: "holdings", configName: "c1", trigger: "schedule", notify: true, attempt: 2,
    }));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("failed");
    // the gateway logging itself out is the failure the owner hits, read on a phone
    expect(sent[0]).toContain("OpenD");
    expect(runs()).toHaveLength(1); // no third attempt
  });

  it("leaves out the hint when the failure is not a connection", async () => {
    config();
    const w = worker({ fail: new TaskFailed("strike 9999 not found") },
      { telegramBotToken: "t", telegramChatId: "42" });
    await w.execute(w.createRun({
      taskType: "holdings", configName: "c1", trigger: "schedule", notify: true, attempt: 2,
    }));
    expect(sent[0]).not.toContain("OpenD");
  });

  it("stays quiet when telegram is not configured", async () => {
    config();
    const w = worker({ fail: boom });
    await w.execute(w.createRun({
      taskType: "holdings", configName: "c1", trigger: "schedule", notify: true, attempt: 2,
    }));
    expect(sent).toEqual([]);
  });

  it("asks the pipeline for an email as well, with the error in it", async () => {
    config();
    const w = worker({ fail: boom });
    const id = w.createRun({
      taskType: "holdings", configName: "c1", trigger: "schedule", notify: true, attempt: 2,
    });
    await w.execute(id);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.subject).toContain("failed");
    expect(alerts[0]!.message).toContain("Client connection failed");
    expect(alerts[0]!.message).toContain("OpenD");
    expect(alerts[0]!.message).toContain(id);
  });

  it("records the run as failed even when both alerts fail to send", async () => {
    // the owner finds out from the dashboard if nothing else reaches them
    config();
    const w = new Worker({
      db,
      settings: settingsFor({ telegramBotToken: "t", telegramChatId: "42" }),
      runner: {
        run: async () => { throw boom; },
        alert: async () => { throw new Error("smtp down"); },
      },
      send: () => { throw new Error("telegram down"); },
    });
    const id = w.createRun({
      taskType: "holdings", configName: "c1", trigger: "schedule", notify: true, attempt: 2,
    });
    await w.execute(id);
    expect(run(id)!.status).toBe("failed");
    expect(run(id)!.error).toBe("Client connection failed!");
  });
});

describe("the queue", () => {
  it("runs one at a time, in the order submitted", async () => {
    // what "one worker thread owns run execution" means here: a run makes a minutes-long OpenD
    // conversation, and two of them are two request budgets
    config();
    const order: string[] = [];
    let concurrent = 0;
    let peak = 0;
    const w = new Worker({
      db,
      settings: settingsFor(),
      runner: {
        run: async (request) => {
          concurrent += 1;
          peak = Math.max(peak, concurrent);
          order.push(String((request.config as { tag?: string }).tag ?? "?"));
          await new Promise((r) => setTimeout(r, 10));
          concurrent -= 1;
          return OK;
        },
        alert: async () => ({ sent: false }),
      },
      send: () => {},
    });
    for (const tag of ["a", "b", "c"]) {
      config({ tag }, tag);
      w.submit(w.createRun({ taskType: "holdings", configName: tag, trigger: "api", notify: false }));
    }
    await w.idle();
    expect(peak).toBe(1);
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("counts what is waiting, not what is running", async () => {
    config();
    const w = worker();
    expect(w.queueDepth()).toBe(0);
    w.submit(w.createRun({ taskType: "holdings", configName: "c1", trigger: "api", notify: false }));
    w.submit(w.createRun({ taskType: "holdings", configName: "c1", trigger: "api", notify: false }));
    // the first is pulled off immediately, so one is left waiting
    expect(w.queueDepth()).toBe(1);
    await w.idle();
    expect(w.queueDepth()).toBe(0);
  });

  it("keeps going after a run fails, and after one crashes outside its own error handling", async () => {
    // a broken job must never kill the loop. The second case needs something that throws OUTSIDE
    // execute's own try: storing a report for a run that already has one, which the primary key
    // refuses. That is reachable — a retry of a run whose report was already written.
    config();
    let n = 0;
    const w = new Worker({
      db,
      settings: settingsFor(),
      runner: {
        run: async () => {
          n += 1;
          if (n === 1) throw new TaskFailed("first one fails");
          return OK;
        },
        alert: async () => ({ sent: false }),
      },
      send: () => {},
    });
    const a = w.createRun({ taskType: "holdings", configName: "c1", trigger: "api", notify: false });
    const b = w.createRun({ taskType: "holdings", configName: "c1", trigger: "api", notify: false });
    const c = w.createRun({ taskType: "holdings", configName: "c1", trigger: "api", notify: false });
    // b stores a report; submitting it twice makes the second insert collide
    w.submit(a);
    w.submit(b);
    w.submit(b);
    w.submit(c);
    await w.idle();
    expect(run(a)!.status).toBe("failed");
    // the second execution of b set it running again and then crashed on the duplicate report, so it
    // is left mid-flight. The Python does the same with an uncaught crash — a run stuck on "running"
    // is how you see one, and inventing a status for it would be guessing what happened.
    expect(run(b)!.status).toBe("running");
    // what matters: the crash did not stop the queue, and the run after it still ran
    expect(run(c)!.status).toBe("succeeded");
  });

  it("takes no new work once stopped", async () => {
    config();
    const w = worker();
    w.stop();
    w.submit(w.createRun({ taskType: "holdings", configName: "c1", trigger: "api", notify: false }));
    expect(w.queueDepth()).toBe(0);
  });
});

describe("createRun", () => {
  it("writes a queued run with a uuid4 hex id", async () => {
    const w = worker();
    const id = w.createRun({ taskType: "holdings", configName: "c1", trigger: "api", notify: true });
    expect(id).toHaveLength(32);
    const r = run(id)!;
    expect(r.status).toBe("queued");
    expect(r.attempt).toBe(1);
    expect(r.notify).toBe(1);
    expect(r.started_at).toBeNull();
    expect(r.finished_at).toBeNull();
  });
});
