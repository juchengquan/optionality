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
import { makeProvider } from "./provider.ts";
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

/** Chosen here and nowhere else: everything below takes the port, and only `/health` and the
 *  shutdown below need the Provider itself (ADR 0015). An unknown name is fatal — see provider.ts. */
const provider = makeProvider(settings);

const scheduler = new Scheduler();
const sweeper = new MonitorSweeper({
  db, settings, fetchQuotes: provider.fetchQuotes, send,
});

const deps: Deps = {
  settings,
  db,
  now: () => new Date(),
  sweeper,
  provider,
};

const port = Number(process.env.PORT ?? 31417);
// 127.0.0.1: reachable only via the tailscale serve proxy and localhost, never the LAN
const server = serve({ fetch: createApp(deps).fetch, port, hostname: "127.0.0.1" });

const bot = new TelegramBot({
  db,
  settings,
  api: telegramApi(settings.telegramBotToken),
  fetchQuotes: provider.fetchQuotes,
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
  + `reading ${provider.name}, sweeping every ${settings.monitorIntervalSeconds}s, `
  + `bot ${botWanted ? "polling" : "not started (set OPTIONALITY_BOT=1)"}`,
);

/** Every way out of this process says so on the way.
 *
 *  On 2026-10-16 the service restarted at 15:55:45 and nothing in its own log said why: no
 *  `SIGTERM: stopping`, no crash report for it, no launchd record.
 *
 *  Explained on 2026-10-17, and it was not this service: the MACHINE panicked. The report is
 *  /Library/Logs/DiagnosticReports/panic-full-2026-10-16-155443.0002.panic — "userspace watchdog
 *  timeout: no successful checkins from WindowServer in 120 seconds" — after half an hour of memory
 *  pressure (two JetsamEvents at 14:59, with a python3.12 outside this repo at ~38 GB and fseventsd
 *  at ~45 GB). `last` shows a reboot at 15:33 with no shutdown before it, which is what a panic
 *  looks like. A panic signals nothing, so no handler below could have logged it.
 *
 *  It did not heal itself either. LaunchAgents load at GUI login, not at boot, and FileVault is on,
 *  which disables automatic login: nothing ran — no API, no alarms, no bot — until the console
 *  login at 15:55, 22 minutes later. That login also loaded the retired Python agent's plist, which
 *  then crash-looped against this port from 15:56:12 until it was found and retired a day later.
 *  For the next unexplained restart, look first at `last` (a reboot with no shutdown) and at
 *  DiagnosticReports for a `.panic`.
 *
 *  These three turn a restart that IS this process's into something readable. `exit` fires for
 *  every path out — a clean stop, an uncaught throw, a drained event loop, an explicit exit — so
 *  the log always ends with a line saying which. The two before it exist because an unhandled rejection or an uncaught
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
    provider.close();
    db.close();
    process.exit(0);
  });
}
