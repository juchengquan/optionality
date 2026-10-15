/** What a rollback would cost, before it costs it.
 *
 *  `make rollback` swapped the launchd agent, printed /health and said "rolled back to the Python
 *  service". It said nothing about the database — and the two have diverged since the cutover.
 *  Measured on the live pair on 2026-10-15, a rollback would have:
 *
 *    - restored four positions the owner had deliberately closed, showing them as open
 *    - lost the one actually held
 *    - lost ALL seven monitors, so every alarm
 *    - lost every exit schedule and the entire vol history
 *
 *  The last two are total rather than partial: ADR 0011 added `positions.opened_at` and the
 *  `position_samples` table to the TypeScript side only, so the Python schema has nowhere to put
 *  them. The samples in particular cannot be rebuilt, because a leg's IV and vega are only
 *  knowable on the day they were observed.
 *
 *  So this is not a degraded safety net, it is a trap: in a crisis it hands you a dashboard
 *  showing closed trades and no alarms. The rollback window stays open until phase 10
 *  (2026-11-02), and this is what makes it survivable — it refuses, and says exactly what would
 *  go. The override is a word you have to type, and it prints the loss anyway, so the decision is
 *  never taken silently.
 */
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const args = process.argv.slice(2);
const forced = args.includes("--i-accept-the-loss");
const [python, typescript] = args.filter((a) => !a.startsWith("--"));

if (!python || !typescript) {
  console.error("usage: node guard.mjs <python.db> <typescript.db> [--i-accept-the-loss]");
  process.exit(2);
}
for (const path of [python, typescript]) {
  // refuse rather than guess: a missing database is not an empty one, and reading it as empty
  // would report "nothing would be lost" about the very file that holds everything
  if (!existsSync(path)) {
    console.error(`no such database: ${path} — cannot say what a rollback would cost`);
    process.exit(2);
  }
}

const open = (path) => new DatabaseSync(path, { readOnly: true });
const names = (db, table, column) => {
  try {
    return db.prepare(`select ${column} v from ${table} order by ${column}`).all().map((r) => r.v);
  } catch {
    return [];
  }
};
const count = (db, table, where = "") => {
  try {
    return db.prepare(`select count(*) n from ${table} ${where}`).get().n;
  } catch {
    // the table does not exist on this side, which for the Python is the point
    return 0;
  }
};

const py = open(python);
const ts = open(typescript);

const lostPositions = names(ts, "positions", "name").filter((n) => !names(py, "positions", "name").includes(n));
const backPositions = names(py, "positions", "name").filter((n) => !names(ts, "positions", "name").includes(n));
const lostMonitors = names(ts, "monitors", "code").filter((c) => !names(py, "monitors", "code").includes(c));
const backMonitors = names(py, "monitors", "code").filter((c) => !names(ts, "monitors", "code").includes(c));
const schedules = count(ts, "positions", "where opened_at is not null");
const samples = count(ts, "position_samples");

py.close();
ts.close();

const lines = [];
if (lostPositions.length) lines.push(`  holdings LOST:      ${lostPositions.join(", ")}`);
if (backPositions.length) {
  lines.push(`  holdings RESTORED:  ${backPositions.join(", ")}`);
  lines.push("                      (shown as open again, whether or not you closed them)");
}
if (lostMonitors.length) lines.push(`  alarm rules LOST:   ${lostMonitors.join(", ")}`);
if (backMonitors.length) lines.push(`  alarm rules BACK:   ${backMonitors.join(", ")}`);
// total, not partial: the Python schema has no column and no table for these
if (schedules) lines.push(`  ${schedules} exit schedule${schedules === 1 ? "" : "s"} LOST entirely — the Python has no opened_at`);
if (samples) lines.push(`  ${samples} daily sample${samples === 1 ? "" : "s"} LOST entirely, and unrebuildable`);
lines.push("                      (a leg's IV and vega are only knowable on the day)");

if (lostPositions.length + backPositions.length + lostMonitors.length + backMonitors.length
    + schedules + samples === 0) {
  console.log("the two databases agree — a rollback would lose nothing");
  process.exit(0);
}

const header = forced
  ? "rolling back ANYWAY, accepted on the command line. This is what goes:"
  : "REFUSING to roll back. The Python database is frozen at the cutover minute, and this is\nwhat the swap would do:";
console.error(`\n${header}\n`);
console.error(lines.join("\n"));

if (forced) {
  console.error("\n  ...proceeding, because --i-accept-the-loss was given.\n");
  process.exit(0);
}
console.error(
  "\nNothing has changed. If you meant it, re-run with --i-accept-the-loss."
  + "\nPhase 10 (2026-11-02) removes this path and the Python with it.\n",
);
process.exit(1);
