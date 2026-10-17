/** The nightly backup: a checked, gzipped online copy of the live database, and the history pruned.
 *
 *    node nightly.ts <live.db> <backup dir> [--today YYYYMMDD]
 *
 *  One file per night, `optionality-ts-YYYYMMDD.db.gz`, by this machine's own calendar. It is the
 *  same online backup `make deploy` takes (backup.ts), so whatever is still in the write-ahead log
 *  is in it; it is checked (retention.ts: verifyCopy) BEFORE it replaces anything, and compressed
 *  into a single file, because syncing a SQLite file without its -wal is how a copy goes quietly
 *  wrong. Run twice in a night, the second run replaces the first.
 *
 *  Then the directory is pruned to 14 nights and the first of each of the last 12 months. The
 *  history is the point: bad data is copied faithfully into the next night's backup, and a mistake is
 *  usually noticed days later.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { gzipSync } from "node:zlib";

import { retainNightly, rowCounts, verifyCopy } from "./retention.ts";

const args = process.argv.slice(2);
const [source, dir] = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--today");
const todayFlag = args.indexOf("--today");
if (!source || !dir) {
  console.error("usage: node nightly.ts <live.db> <backup dir> [--today YYYYMMDD]");
  process.exit(2);
}
if (!existsSync(source)) {
  console.error(`no such database: ${source}`);
  process.exit(1);
}

const local = new Date();
const today = todayFlag >= 0
  ? (args[todayFlag + 1] ?? "")
  : `${local.getFullYear()}${String(local.getMonth() + 1).padStart(2, "0")}${String(local.getDate()).padStart(2, "0")}`;
if (!/^\d{8}$/.test(today)) {
  console.error(`--today must be YYYYMMDD, not ${today}`);
  process.exit(2);
}

mkdirSync(dir, { recursive: true });
const name = `optionality-ts-${today}.db.gz`;
const copy = join(dir, `.tmp-${process.pid}.db`);
const packed = join(dir, `.tmp-${process.pid}.db.gz`);
const removeCopy = () => { for (const f of [copy, `${copy}-wal`, `${copy}-shm`]) rmSync(f, { force: true }); };

try {
  const before = rowCounts(source);
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    await backup(db, copy);
  } finally {
    db.close();
  }
  const after = rowCounts(source);
  verifyCopy(copy, before, after);
  writeFileSync(packed, gzipSync(readFileSync(copy), { level: 9 }));
  renameSync(packed, join(dir, name));
  const rows = Object.entries(rowCounts(copy)).map(([t, n]) => `${t} ${n}`).join(", ");
  console.log(`backed up ${source} -> ${join(dir, name)} (${rows})`);
} catch (err) {
  rmSync(packed, { force: true });
  console.error(`backup FAILED, nothing replaced: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
} finally {
  removeCopy();
}

const { drop } = retainNightly(readdirSync(dir));
for (const f of drop) rmSync(join(dir, f));
if (drop.length > 0) console.log(`pruned ${drop.length}: ${drop.join(", ")}`);
