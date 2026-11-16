/** Put a nightly backup back in place of the live database.
 *
 *    node restore.ts <optionality-ts-YYYYMMDD.db.gz> <live.db>
 *    node restore.ts --check <optionality-ts-YYYYMMDD.db.gz>
 *
 *  `make restore FROM=...` (tools/restore.mjs) stops the API around this; run by hand, stop it
 *  first — this refuses while anything has the live file open. `--check` unpacks and checks the
 *  backup in a temporary directory and touches nothing else: it is what `make restore` runs BEFORE
 *  it stops the API, so a backup that is not intact never costs the service a minute.
 *
 *  The order is the point. The backup is unpacked and checked BEFORE the live file is touched; what
 *  it replaces is kept as `<live>.bak-pre-restore-<stamp>`, a name the deploy pruning never deletes;
 *  and the live file's -wal and -shm are removed with it, because left beside the restored file
 *  SQLite would replay that OLD log onto it — a restore that opens cleanly and is wrong.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { gunzipSync } from "node:zlib";

import { verifyCopy } from "./retention.ts";

/** Unpack `from` into `staged` and check it. Null when it is intact; otherwise `staged` is gone and
 *  the refusal is returned, for the caller to print once it has cleaned up. */
function unpackChecked(from: string, staged: string): string | null {
  try {
    writeFileSync(staged, gunzipSync(readFileSync(from)));
    verifyCopy(staged, {}, {});
    return null;
  } catch (err) {
    rmSync(staged, { force: true });
    return `not restoring, the backup is not intact: ${err instanceof Error ? err.message : String(err)}`;
  }
}

const args = process.argv.slice(2);
if (args[0] === "--check") {
  if (!args[1]) {
    console.error("usage: node restore.ts --check <backup.db.gz>");
    process.exit(2);
  }
  const scratch = mkdtempSync(join(tmpdir(), "restore-check-"));
  const refusal = unpackChecked(args[1], join(scratch, "check.db"));
  rmSync(scratch, { recursive: true, force: true });
  if (refusal) {
    console.error(refusal);
    process.exit(1);
  }
  console.log(`${args[1]} is intact`);
  process.exit(0);
}

const [from, live] = args;
if (!from || !live) {
  console.error("usage: node restore.ts <backup.db.gz> <live.db> | --check <backup.db.gz>");
  process.exit(2);
}

function inUse(path: string): boolean {
  try {
    execFileSync("lsof", ["-t", path], { stdio: ["ignore", "pipe", "ignore"] });
    return true; // lsof exits 0 only when something has it open
  } catch {
    return false;
  }
}
if (existsSync(live) && inUse(live)) {
  console.error(`${live} is open — stop the API agent first (make restore does)`);
  process.exit(1);
}

const staged = `${live}.restore-tmp`;
const refusal = unpackChecked(from, staged);
if (refusal) {
  console.error(refusal);
  process.exit(1);
}

if (existsSync(live)) {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const kept = `${live}.bak-pre-restore-${stamp}`;
  // an online backup, so whatever was still in the live file's log is in what is kept
  const db = new DatabaseSync(live, { readOnly: true });
  try {
    await backup(db, kept);
  } finally {
    db.close();
  }
  console.log(`kept what it replaces as ${kept}`);
}
for (const f of [live, `${live}-wal`, `${live}-shm`]) rmSync(f, { force: true });
renameSync(staged, live);
verifyCopy(live, {}, {});
console.log(`restored ${from} -> ${live}`);
