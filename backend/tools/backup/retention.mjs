/** What to keep, and how to tell a whole copy from a broken one.
 *
 *  Pure, so the rules are tested exactly (nightly.test.ts) rather than by running them on the real
 *  data/ directory. Both functions decide only about the files they recognise by name; anything else
 *  in the directory is never in `drop`, so a file someone put there by hand is never deleted.
 */
import { DatabaseSync } from "node:sqlite";

const NIGHTLY = /^optionality-ts-(\d{4})(\d{2})(\d{2})\.db\.gz$/;
const NIGHTS = 14;
const MONTHS = 12;

/** Nightly backups: the last 14 nights, and the earliest backup of each of the last 12 months that
 *  has one — "earliest", not "the 1st", because the machine is not always awake on the 1st. */
export function retainNightly(files) {
  const managed = files.filter((f) => NIGHTLY.test(f)).sort();
  const keep = new Set(managed.slice(-NIGHTS));
  const firstOfMonth = new Map();
  for (const f of managed) {
    const [, y, m] = NIGHTLY.exec(f);
    if (!firstOfMonth.has(`${y}${m}`)) firstOfMonth.set(`${y}${m}`, f);
  }
  for (const f of [...firstOfMonth.values()].slice(-MONTHS)) keep.add(f);
  return { keep: managed.filter((f) => keep.has(f)), drop: managed.filter((f) => !keep.has(f)) };
}

const DEPLOY = /^optionality-ts\.db\.bak-(\d{8}-\d{6})$/;
const DEPLOY_KEPT = 10;

/** `make deploy`'s backups: the last 10 that carry only a timestamp, and every one that was given a
 *  name (`bak-predelete-...`, `bak-pre-0005-...`), which is how a backup taken before something
 *  destructive is kept for good. A dropped backup takes its -wal and -shm with it. */
export function retainDeploy(files) {
  const rotating = files.filter((f) => DEPLOY.test(f)).sort();
  const dropped = new Set(rotating.slice(0, Math.max(0, rotating.length - DEPLOY_KEPT)));
  const drop = files.filter((f) => dropped.has(f.replace(/-(wal|shm)$/, "")));
  const keep = files.filter((f) => f.startsWith("optionality-ts.db.bak-") && !drop.includes(f));
  return { keep, drop };
}

/** Every user table's row count. */
export function rowCounts(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = db.prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%'")
      .all().map((r) => r.name);
    return Object.fromEntries(tables.map((t) => [t, db.prepare(`select count(*) n from "${t}"`).get().n]));
  } finally {
    db.close();
  }
}

/** Throws unless `copy` is intact and holds, for every table, at least the rows the live database had
 *  before the copy was taken and at most the rows it had after. The sweep keeps writing while the
 *  copy is made, so exact equality would fail on a correct copy; a copy below `before` is the one
 *  `cp` used to produce — valid SQLite, quietly missing what was in the write-ahead log. */
export function verifyCopy(copy, before, after) {
  const db = new DatabaseSync(copy, { readOnly: true });
  try {
    const check = db.prepare("pragma integrity_check").get().integrity_check;
    if (check !== "ok") throw new Error(`integrity_check: ${check}`);
  } finally {
    db.close();
  }
  const counts = rowCounts(copy);
  for (const table of Object.keys(before)) {
    const n = counts[table] ?? 0;
    const lo = before[table];
    const hi = after[table] ?? lo;
    if (n < lo || n > hi) throw new Error(`${table}: ${n} rows, expected ${lo}..${hi}`);
  }
}
