/** The process. launchd runs this file directly — Node executes TypeScript with no build step, which
 *  keeps the property that what is in the working tree is what runs (ADR 0009).
 *
 *  This is the whole service as of phase 6c: the routes, the alarm engine, the schedule, and the queue
 *  that owns run execution. The Telegram bot is phase 7, and the cutover is phase 9 — until then this
 *  listens on a port of its own so it can run beside the Python without either moving.
 */
import { serve } from "@hono/node-server";

import { createApp } from "./app.ts";
import type { Deps } from "./deps.ts";
import { openDatabase } from "./db/open.ts";
import { settingsFromEnv } from "./env.ts";
import { OpendClient } from "./opend/client.ts";
import { probeOpend } from "./opend.ts";
import { PythonRunner } from "./runner.ts";
import { Scheduler } from "./scheduler.ts";
import { MonitorSweeper } from "./sweeper.ts";
import { telegramSender } from "./telegram.ts";
import { Worker } from "./worker.ts";

const settings = settingsFromEnv();
const db = openDatabase(settings.dbPath);
const send = telegramSender(settings.telegramBotToken, settings.telegramChatId);

const opend = new OpendClient({
  host: settings.opendHost,
  port: settings.moomooWsPort,
  key: settings.moomooWsKey,
});

/** The run pipeline stays in Python (ADR 0009 phase 6). `uv run` is invoked from the repository root,
 *  two levels up from this file — the same working tree launchd runs. */
const runner = new PythonRunner({ cwd: new URL("../..", import.meta.url).pathname });

const worker = new Worker({ db, settings, runner, send });
const scheduler = new Scheduler({
  db,
  createRun: (args) => worker.createRun(args),
  submit: (runId) => worker.submit(runId),
});
const sweeper = new MonitorSweeper({
  db, settings, fetchQuotes: opend.asFetcher(), send,
});

const deps: Deps = {
  settings,
  db,
  now: () => new Date(),
  worker,
  runs: worker,
  scheduler,
  sweeper,
  opendReachable: probeOpend,
  // the report page's wrapper. The Python's full_html_document adds a stylesheet; the stored html is
  // already a document's body, and phase 7 brings the styling with the rest of the notifications.
  htmlDocument: (body) => `<html><body>${body}</body></html>`,
  fetchQuotes: opend.asFetcher(),
};

const port = Number(process.env.PORT ?? 31417);
// 127.0.0.1: reachable only via the tailscale serve proxy and localhost, never the LAN
const server = serve({ fetch: createApp(deps).fetch, port, hostname: "127.0.0.1" });

const armed = scheduler.refreshJobs();
// sweep at once as well as on the interval. Without that every restart left the alarm engine quiet
// and the dashboard's cache empty for a whole MONITOR_INTERVAL_SECONDS — and restarts happen after
// every merge.
scheduler.startSweep(settings.monitorIntervalSeconds, () => sweeper.sweep());

console.log(
  `optionality backend on 127.0.0.1:${port} — ${armed} schedule(s) armed, `
  + `sweeping every ${settings.monitorIntervalSeconds}s`,
);

/** launchd sends SIGTERM on `kickstart -k`, which is how every deploy restarts this. Stopping in order
 *  matters: the scheduler must not arm another sweep while the database is closing. */
let shuttingDown = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal}: stopping`);
    scheduler.stop();
    worker.stop();
    server.close();
    opend.close();
    db.close();
    process.exit(0);
  });
}
