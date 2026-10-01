/** Copy the Python's database into a fresh one with the TypeScript schema (ADR 0009, phase 4).
 *
 *     node backend/tools/copy-db/copy.ts [source] [target]
 *
 *  Values are carried across untouched — the datetime text, the 0/1 booleans, and the JSON with
 *  Python's own spacing all stay exactly as they are. Keeping the bytes is what makes the copy
 *  verifiable field by field, and what leaves the Python able to open the result if the cutover
 *  has to be undone.
 *
 *  The source is opened READ-ONLY and the target must not already exist. The live file is the
 *  owner's watchlist and run history, and this script has no business being able to touch it.
 *
 *  ## Why it snapshots first
 *
 *  The service may be running, and the sweeper writes `last_value` and `last_checked_at` on every
 *  monitor every sweep. Copying from the live file and then verifying against it compares a
 *  snapshot to a moving target, and ordinary progress reads as corruption — which is exactly the
 *  mistake phase 0 made with a WebSocket read against an older TCP baseline. So the first thing
 *  that happens is a consistent snapshot via SQLite's online backup, and everything afterwards —
 *  the copy, the verification, and the Python readback — refers to THAT.
 */
import { existsSync, rmSync } from "node:fs";
import { backup } from "node:sqlite";

import { createDatabase, openReadOnly } from "../../src/db/open.ts";
import { TABLES, readTable, verify } from "./verify.ts";

const source = process.argv[2] ?? "data/optionality.db";
const target = process.argv[3] ?? "data/optionality-next.db";
const snapshotPath = `${target}.snapshot`;

if (!existsSync(source)) throw new Error(`no such source database: ${source}`);
if (existsSync(target)) throw new Error(`target already exists, refusing to overwrite: ${target}`);

for (const suffix of ["", "-wal", "-shm"]) rmSync(`${snapshotPath}${suffix}`, { force: true });
const live = openReadOnly(source);
const pages = await backup(live, snapshotPath);
live.close();
console.log(`snapshot of ${source}: ${pages} pages -> ${snapshotPath}`);

const from = openReadOnly(snapshotPath);
const to = createDatabase(target);

let written = 0;
// one transaction for the whole copy: a half-copied database should not survive a failure, and
// with foreign_keys ON a row whose parent has not arrived yet would fail anyway
to.exec("BEGIN");
try {
  for (const table of TABLES) {
    const rows = readTable(from, table);
    if (rows.length === 0) {
      console.log(`  ${table.padEnd(18)} 0 rows`);
      continue;
    }
    // by name, never by position: the live monitors table carries its columns in the order
    // migrations appended them, and the fresh schema declares them in models.py order
    const columns = Object.keys(rows[0]!);
    const quoted = columns.map((c) => `"${c}"`).join(", ");
    const placeholders = columns.map(() => "?").join(", ");
    const insert = to.prepare(`insert into ${table} (${quoted}) values (${placeholders})`);
    for (const row of rows) insert.run(...columns.map((c) => row[c] as never));
    written += rows.length;
    console.log(`  ${table.padEnd(18)} ${rows.length} rows`);
  }
  to.exec("COMMIT");
} catch (err) {
  to.exec("ROLLBACK");
  throw err;
}

console.log(`\ncopied ${written} rows into ${target}`);

const result = verify(from, to);
console.log(`verified ${result.compared} field values across ${result.rows} rows`);
for (const d of result.divergences) console.log(`  ${d.table}/${d.row}: ${d.detail}`);
if (result.divergences.length > 0) {
  console.log(`\n${result.divergences.length} DIVERGENCES — the copy is not faithful`);
  process.exit(1);
}
// the count is part of the result: "no divergences" from a comparison that walked nothing reads
// exactly like a clean one
if (result.compared < 100) {
  console.log(`\nonly ${result.compared} values compared — the verification is not looking`);
  process.exit(2);
}
console.log(`no divergences\n\nnow check the Python reads it the same way:`);
console.log(`  uv run python backend/tools/copy-db/python_can_read.py ${snapshotPath} ${target}`);
