/** The process. launchd runs this file directly — Node executes TypeScript with no build step,
 *  which keeps the property that what is in the working tree is what runs (ADR 0009).
 *
 *  Not yet the deployed service: the worker, the scheduler and the sweeper land in phase 6, and the
 *  cutover is phase 9. Until then the ports below answer honestly rather than plausibly — a stub
 *  that returns a zero depth and a schedule that silently does not fire would look like a working
 *  service, which is the one thing it must not do.
 */
import { serve } from "@hono/node-server";

import { createApp } from "./app.ts";
import type { Deps } from "./deps.ts";
import { openDatabase } from "./db/open.ts";
import { settingsFromEnv } from "./env.ts";
import { probeOpend } from "./opend.ts";

const settings = settingsFromEnv();
const notYet = (what: string) => () => {
  throw new Error(`${what} is not implemented until phase 6`);
};

const deps: Deps = {
  settings,
  db: openDatabase(settings.dbPath),
  now: () => new Date(),
  worker: { queueDepth: notYet("the worker"), submit: notYet("the worker") },
  runs: { createRun: notYet("run creation") },
  scheduler: { refreshJobs: notYet("the scheduler") },
  sweeper: {
    lastSweepAt: notYet("the sweeper"),
    lastSweepOk: notYet("the sweeper"),
    consecutiveFailures: notYet("the sweeper"),
    alarmState: notYet("the sweeper"),
    lastFetchAt: notYet("the sweeper"),
  },
  opendReachable: probeOpend,
  htmlDocument: (body) => body,
};

const port = Number(process.env.PORT ?? 31417);
serve({ fetch: createApp(deps).fetch, port, hostname: "127.0.0.1" });
// 127.0.0.1: reachable only via the tailscale serve proxy and localhost, never the LAN. A port of
// its own so that it can run beside the Python during the cutover without either moving.
console.log(`optionality backend listening on 127.0.0.1:${port} (phase 5: routes only)`);
