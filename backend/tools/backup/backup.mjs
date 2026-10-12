/** Back up a live SQLite database, including whatever is still in its write-ahead log.
 *
 *  `make deploy` used `cp`, and in WAL mode that copies the main file WITHOUT the log beside it —
 *  so the backup was current only as far as the last checkpoint. Measured on a scratch database:
 *  500 committed rows, copied that way, came back as 1. The copy is still valid SQLite, which is
 *  the dangerous part — it opens cleanly, reads fine, and is quietly missing hours of sweeps.
 *
 *  This is the backup taken immediately before a migration runs (ADR 0011), so being whole is the
 *  entire point of it.
 *
 *  SQLite's online backup, as `copy-db` already uses for the same reason: the service is running
 *  and the sweep writes every 15 seconds, so the source is a moving target and a snapshot is what
 *  is wanted. Node rather than the sqlite3 CLI because node is already a hard dependency of the
 *  service and the Makefile has never needed that binary.
 */
import { existsSync } from "node:fs";
import { DatabaseSync, backup } from "node:sqlite";

const [source, target] = process.argv.slice(2);
if (!source || !target) {
  console.error("usage: node backup.mjs <source.db> <target.db>");
  process.exit(2);
}
// loudly, rather than leaving a plausible empty file where a backup should be
if (!existsSync(source)) {
  console.error(`no such database: ${source}`);
  process.exit(1);
}
if (existsSync(target)) {
  console.error(`refusing to overwrite an existing backup: ${target}`);
  process.exit(1);
}

const db = new DatabaseSync(source, { readOnly: true });
try {
  const pages = await backup(db, target);
  console.log(`backed up ${source} -> ${target} (${pages} pages)`);
} finally {
  db.close();
}
