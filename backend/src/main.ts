/** The process. launchd runs this file directly — Node executes TypeScript with no build step, which
 *  keeps the property that what is in the working tree is what runs (ADR 0009).
 *
 *  The whole service: the routes, the alarm engine and its sweep loop, and the bot. The run pipeline —
 *  the worker, its Python runner and the cron schedules that fed it — was retired in phase 10
 *  (ADR 0014); nothing had used it since 2026-08-10.
 *
 *  **The bot is NOT started unless OPTIONALITY_BOT=1.** The token allows one getUpdates consumer
 *  (CLAUDE.md), and only the launchd plist sets the flag, so `make serve` and every other local run
 *  cannot become a second consumer and take a random half of the owner's commands.
 */
import { serve } from "@hono/node-server";

import { createApp } from "./app.ts";
import type { Deps } from "./deps.ts";
import { migrate } from "./db/migrate.ts";
import { openDatabase } from "./db/open.ts";
import { settingsFromEnv } from "./env.ts";
import { OpendClient } from "./opend/client.ts";
import { probeOpend } from "./opend/probe.ts";
import { Scheduler } from "./scheduler.ts";
import { MonitorSweeper, STALE_AFTER_SWEEPS } from "./sweeper.ts";
import { telegramApi, telegramSender } from "./telegram.ts";
import { TelegramBot } from "./bot/bot.ts";

const settings = settingsFromEnv();
const db = openDatabase(settings.dbPath);

/** Before anything serves. The schema and the code that reads it travel together in the working
 *  tree (ADR 0009), so they must not be able to get out of step — and a failure here is fatal on
 *  purpose: a service that starts on a schema it does not match is worse than one that does not
 *  start. launchd's KeepAlive will keep trying, and the log will say which migration. */
const applied = migrate(db);
if (applied.length > 0) console.info(`applied ${applied.length} migration(s): ${applied.join(", ")}`);
const send = telegramSender(settings.telegramBotToken, settings.telegramChatId);

const opend = new OpendClient({
  host: settings.opendHost,
  port: settings.moomooWsPort,
  key: settings.moomooWsKey,
});

const scheduler = new Scheduler();
const sweeper = new MonitorSweeper({
  db, settings, fetchQuotes: opend.asFetcher(), send,
});

const deps: Deps = {
  settings,
  db,
  now: () => new Date(),
  sweeper,
  opendReachable: probeOpend,
  fetchQuotes: opend.asFetcher(),
};

const port = Number(process.env.PORT ?? 31417);
// 127.0.0.1: reachable only via the tailscale serve proxy and localhost, never the LAN
const server = serve({ fetch: createApp(deps).fetch, port, hostname: "127.0.0.1" });

const bot = new TelegramBot({
  db,
  settings,
  api: telegramApi(settings.telegramBotToken),
  fetchQuotes: opend.asFetcher(),
  sweeper,
});

// sweep at once as well as on the interval. Without that every restart left the alarm engine quiet
// and the dashboard's cache empty for a whole MONITOR_INTERVAL_SECONDS — and restarts happen after
// every merge.
scheduler.startSweep(settings.monitorIntervalSeconds, () => sweeper.sweep(), {
  // the same age at which the engine calls itself stalled, so the two agree: /health says it, and
  // the next tick does something about it rather than coalescing behind a sweep that is not coming
  // back. The request timeout in opend/client.ts should mean this never fires; it fired on
  // 2026-10-16 because nothing bounded the ask.
  stallAfterSeconds: settings.monitorIntervalSeconds * STALE_AFTER_SWEEPS,
  onStall: (age) => { void sweeper.recordStall(age); },
});

// one getUpdates consumer per token: only the plist sets the flag
const botWanted = process.env.OPTIONALITY_BOT === "1"
  && Boolean(settings.telegramBotToken && settings.telegramChatId);
if (botWanted) {
  await bot.start();
  void bot.run();
}

console.log(
  `optionality backend on 127.0.0.1:${port} — `
  + `sweeping every ${settings.monitorIntervalSeconds}s, `
  + `bot ${botWanted ? "polling" : "not started (set OPTIONALITY_BOT=1)"}`,
);

/** Every way out of this process says so on the way.
 *
 *  On 2026-10-16 the service restarted at 15:55:45 and nothing anywhere said why: no `SIGTERM:
 *  stopping` in our log, no crash report in DiagnosticReports, no launchd record, and the unified
 *  log had already rolled past it. The agent has KeepAlive, so it healed itself and the only
 *  evidence it had ever happened was a process whose start time disagreed with the deploy's.
 *
 *  These three turn the next one into something readable. `exit` fires for every path out — a
 *  clean stop, an uncaught throw, a drained event loop, an explicit exit — so the log always ends
 *  with a line saying which. The two before it exist because an unhandled rejection or an uncaught
 *  exception otherwise takes the process down with its reason on stderr and nothing tying it to
 *  this service. Both still exit non-zero: a server that keeps serving after an unhandled rejection
 *  is in a state nobody has reasoned about, which is worse than a restart launchd will perform
 *  anyway.
 */
process.on("uncaughtException", (err) => {
  console.error("FATAL uncaughtException — exiting:", err);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error("FATAL unhandledRejection — exiting:", reason);
  process.exit(1);
});
process.on("exit", (code) => {
  console.error(`process exiting with code ${code} (pid ${process.pid})`);
});

/** launchd sends SIGTERM on `kickstart -k`, which is how every deploy restarts this. Stopping in order
 *  matters: the scheduler must not arm another sweep while the database is closing. */
let shuttingDown = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal}: stopping`);
    bot.stop();
    scheduler.stop();
    server.close();
    opend.close();
    db.close();
    process.exit(0);
  });
}
