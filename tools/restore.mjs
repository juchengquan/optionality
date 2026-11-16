/** `make restore FROM=<nightly backup>`: put a backup back in place of the live database, with the
 *  API stopped around it — and never left stopped.
 *
 *    node tools/restore.mjs <optionality-ts-YYYYMMDD.db.gz> <live.db>
 *
 *  The order is the point, and the recipe this replaced had it backwards: it booted the API out
 *  FIRST and let `restore.ts` find out afterwards that the backup was not intact, which left the
 *  service down for a typo in FROM; and its start was simply the next line, so any failure after
 *  the stop left it down too. Now:
 *
 *    1. `restore.ts --check`  unpack and check the backup in a temporary directory. A bad one stops
 *                             here, and launchd has heard nothing.
 *    2. bootout, and wait until the agent is unloaded (restore.ts refuses while the file is open).
 *    3. `restore.ts`          the restore itself, which keeps what it replaces.
 *    4. bootstrap and wait for /health — ALWAYS, whatever happened in 2 and 3. The API's boot
 *       migrates an older file forward.
 *
 *  A ^C, a hang-up or a kill arriving between 2 and 4 is held until 4 has run, for the same reason,
 *  and launchctl and restore.ts run in a session of their own, so the terminal's signals never
 *  reach them half-way (use-backend.mjs's system).
 *
 *  Behind `use-backend.mjs`'s system, so `DRY_RUN=1` prints the launchctl calls and the restore and
 *  does none of them (the check in step 1 still runs: it only reads), and `restore.test.mjs` drives
 *  it with a scripted system. `API_HEALTH_URL` moves the health check, for the same suites.
 */
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";

import { LABEL, LOG, healthUrl, plistPath, systemFor, waitForHealth } from "./use-backend.mjs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const RESTORE = "backend/tools/backup/restore.ts";
const USAGE = "usage: make restore FROM=<BACKUP_DIR>/optionality-ts-YYYYMMDD.db.gz";

/** Whether `from` is a backup worth stopping the API for: `restore.ts --check`, run for real
 *  whatever the system, because it only reads. Its own words go to stderr. */
function intact(from, { node, repo }) {
  const r = spawnSync(node, [RESTORE, "--check", from], { cwd: repo, stdio: ["ignore", "inherit", "inherit"] });
  // before the stop: a ^C here is the owner changing their mind, and nothing needs finishing
  return r.status === 0;
}

export async function restoreLive({
  from, live, home, uid, sys, say = console.log, node = process.execPath, repo = ROOT,
  url = healthUrl(), waits = { unload: 30, health: 60 },
}) {
  if (!intact(from, { node, repo })) {
    throw new Error(`${from} is not intact (above): nothing was restored, and the API was not stopped.`);
  }
  const domain = `gui/${uid}`;
  const service = `${domain}/${LABEL}`;
  const plist = plistPath(home);

  say(`stopping ${LABEL} to restore ${from}`);
  sys.launchctl(["bootout", service]);
  let failure = null;
  try {
    for (let i = 0; sys.launchctl(["print", service]).status === 0; i++) {
      if (i >= waits.unload) throw new Error(`${LABEL} is still loaded ${waits.unload}s after bootout; nothing was restored.`);
      await sys.sleep(1000);
    }
    const status = sys.run(node, [RESTORE, from, live]);
    if (status !== 0) throw new Error(`restore.ts exited ${status} (above); the live file is as it was unless it says otherwise.`);
  } catch (err) {
    failure = err;
  }

  // ALWAYS, from here: the API is started again whatever happened above
  const lines = failure ? [failure.message] : [];
  const boot = sys.launchctl(["bootstrap", domain, plist]);
  if (boot.status !== 0 && sys.launchctl(["print", service]).status !== 0) {
    lines.push(`launchctl bootstrap refused ${plist}: ${boot.output.trim()}. The API is NOT running: `
      + "`make use BACKEND=ts` installs and starts it.");
  } else {
    try {
      await waitForHealth(sys, { url, seconds: waits.health });
      if (failure) lines.push(`${LABEL} was started again and answers /health.`);
    } catch (err) {
      lines.push(`${LABEL} was started again, but ${err.message}: read ${LOG} (\`make api-logs\`).`);
    }
  }
  if (lines.length > 0) throw new Error(lines.join("\n"));
  say(sys.dry ? "dry run: nothing was done" : `restored ${from}; ${LABEL} is running and answers /health`);
}

async function main([from, live]) {
  if (!from || !live) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  // held, not obeyed: a ^C, a closed terminal or a kill between the stop and the start must not
  // leave the API stopped. The children are detached (use-backend.mjs), so these reach only us. A
  // hang-up also takes the terminal, so a write to it may fail: that must not stop the restore.
  for (const stream of [process.stdout, process.stderr]) stream.on("error", () => {});
  const hold = () => console.error("finishing first: the API is started again before this exits");
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, hold);
  await restoreLive({
    from, live, home: process.env.HOME || homedir(), uid: process.getuid(), sys: systemFor(process.env),
  });
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  });
}
