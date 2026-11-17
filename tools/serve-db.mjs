/** Clears the sweep's interval from `make serve`'s SNAPSHOT (#442's review).
 *
 *  The recipe runs the snapshot with MONITOR_INTERVAL_SECONDS=3600 so a local instance is not a
 *  second sweeper beside the live service. A `sweep_interval` row (ADR 0025) overrides `.env`, so a
 *  snapshot carrying one would sweep live OpenD every 5–60s from here: deleted, so the hour holds.
 *
 *  `node tools/serve-db.mjs <snapshot> --not <live>` — refuses to touch the live file, by whatever
 *  spelling of its path, because the live row is the owner's choice.
 */
import { realpathSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const [target, flag, live] = process.argv.slice(2);
if (!target || flag !== "--not" || !live) {
  console.error("usage: node tools/serve-db.mjs <snapshot> --not <live database>");
  process.exit(2);
}
if (realpathSync(target) === realpathSync(live)) {
  console.error(`refusing to clear sweep_interval in ${target}: it is the live database`);
  process.exit(1);
}
const db = new DatabaseSync(target);
try {
  // a live file not yet migrated past 0016 has no such table, and no choice to clear: the service
  // migrates the snapshot at boot and starts with none
  const exists = db.prepare("select 1 from sqlite_master where type = 'table' and name = 'sweep_interval'").get();
  const cleared = exists === undefined ? 0 : Number(db.prepare("delete from sweep_interval").run().changes);
  if (cleared > 0) console.log(`cleared the page's sweep interval from ${target}: it sweeps at the recipe's interval`);
} finally {
  db.close();
}
