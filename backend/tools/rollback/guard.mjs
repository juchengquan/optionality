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
const count = (db, table, where = "") => {
  try {
    return db.prepare(`select count(*) n from ${table} ${where}`).get().n;
  } catch {
    // the table does not exist on this side, which for the Python is the point
    return 0;
  }
};

/** The columns the OWNER sets, and deliberately not the engine's.
 *
 *  This compared names and codes alone, so it answered "a rollback would lose nothing" and exited
 *  0 while every edit since the cutover was about to be discarded — a corrected entry, a moved
 *  threshold, a rule muted by hand. A code review found it by building the case.
 *
 *  `triggered`, `last_value`, `last_checked_at`, `last_alarm_at`, `scope` and `disabled_reason`
 *  are left out on purpose: the sweep rewrites them every fifteen seconds, so including them
 *  would make "they agree" unreachable within one sweep of the cutover — and the cutover's own
 *  failure path depends on reaching it. */
const py = open(python);
const ts = open(typescript);

const WATCHED = {
  positions: ["entry", "contracts", "strategy", "strike_date", "legs"],
  monitors: ["threshold", "direction", "compare", "enabled", "strike_date", "option_type",
    "strike", "legs"],
};

/** Rows by the identity a rollback would match them on, with the watched columns beside each.
 *
 *  A monitor's identity is (code, field), not code: `uq_monitor_code_field UNIQUE (code, field)`
 *  means one contract legitimately carries several rules — a mid, a delta and a vega alarm — and
 *  comparing codes alone made two of three invisible. */
const columnsOf = (db, table) => {
  try {
    return new Set(db.prepare("select name from pragma_table_info(?)").all(table).map((r) => r.name));
  } catch {
    return new Set();
  }
};

/** The watched columns both sides actually have.
 *
 *  Computed once from both schemas rather than probed per side: the first spelling narrowed the
 *  shared WATCHED array in place as it probed, so whichever database was read first silently
 *  decided what the other was compared on. A column only one side has is not comparable at all —
 *  `opened_at` is the live example, and it is counted separately as a total loss. */
const comparable = (table) => {
  const both = columnsOf(py, table);
  const mine = columnsOf(ts, table);
  return WATCHED[table].filter((c) => both.has(c) && mine.has(c));
};

const rowsOf = (db, table, key, cols) => {
  const out = new Map();
  try {
    for (const r of db.prepare(`select ${[...key, ...cols].join(", ")} from ${table}`).all()) {
      out.set(key.map((k) => r[k]).join(" / "), r);
    }
  } catch {
    return new Map();
  }
  return out;
};

const diff = (table, key) => {
  const cols = comparable(table);
  const before = rowsOf(py, table, key, cols);
  const after = rowsOf(ts, table, key, cols);
  const lost = [...after.keys()].filter((k) => !before.has(k));
  const back = [...before.keys()].filter((k) => !after.has(k));
  const changed = [];
  for (const [k, now] of after) {
    const was = before.get(k);
    if (!was) continue;
    for (const col of cols) {
      if (String(now[col]) !== String(was[col])) {
        changed.push(`${k} (${col} ${was[col]} -> ${now[col]})`);
      }
    }
  }
  return { lost, back, changed };
};

const pos = diff("positions", ["name"]);
const mon = diff("monitors", ["code", "field"]);
const { lost: lostPositions, back: backPositions } = pos;
const { lost: lostMonitors, back: backMonitors } = mon;
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
if (pos.changed.length) {
  lines.push(`  holdings CHANGED:   ${pos.changed.join("; ")}`);
  lines.push("                      (the Python's older values come back in their place)");
}
if (lostMonitors.length) lines.push(`  alarm rules LOST:   ${lostMonitors.join(", ")}`);
if (backMonitors.length) lines.push(`  alarm rules BACK:   ${backMonitors.join(", ")}`);
if (mon.changed.length) lines.push(`  alarm rules CHANGED: ${mon.changed.join("; ")}`);
// total, not partial: the Python schema has no column and no table for these
if (schedules) lines.push(`  ${schedules} exit schedule${schedules === 1 ? "" : "s"} LOST entirely — the Python has no opened_at`);
if (samples) {
  lines.push(`  ${samples} daily sample${samples === 1 ? "" : "s"} LOST entirely, and unrebuildable`);
  // inside the guard, not after it: as a bare push it printed beneath whatever line came last,
  // which on a names-only difference was a justification for something not being lost
  lines.push("                      (a leg's IV and vega are only knowable on the day)");
}

if (lostPositions.length + backPositions.length + pos.changed.length
    + lostMonitors.length + backMonitors.length + mon.changed.length
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
