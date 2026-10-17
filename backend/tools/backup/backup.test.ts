/** Backing up a live database.
 *
 *  `make deploy` used `cp`, which copies the main file and not the write-ahead log beside it — so
 *  the backup was correct only as far as the last checkpoint. Demonstrated before this was
 *  written: a database holding 500 rows, copied that way, came back with 1. It is still VALID
 *  SQLite, which is the dangerous part — it opens cleanly and looks fine.
 *
 *  This is the backup taken immediately before a migration runs, which is exactly when you want
 *  it to be whole.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "optionality-backup-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const SCRIPT = new URL("./backup.ts", import.meta.url).pathname;

/** A database with committed rows still sitting in the WAL, which is the live service's normal
 *  state: the sweep writes every 15 seconds and SQLite folds the log in at about 4MB. */
function withPendingWal(path: string, rows: number): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
  db.prepare("insert into t values (1, ?)").run("checkpointed");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  for (let i = 2; i <= rows; i++) db.prepare("insert into t values (?, ?)").run(i, "pending");
  return db;
}
const count = (path: string): number => {
  const db = new DatabaseSync(path, { readOnly: true });
  const n = (db.prepare("select count(*) c from t").get() as { c: number }).c;
  db.close();
  return n;
};

describe("backing up a database with changes still in the log", () => {
  it("captures them, which a plain copy does not", () => {
    const live = join(dir, "live.db");
    const db = withPendingWal(live, 500);
    expect(statSync(`${live}-wal`).size, "the log should hold the pending rows").toBeGreaterThan(0);

    const taken = join(dir, "taken.db");
    execFileSync(process.execPath, [SCRIPT, live, taken]);
    expect(count(taken), "the backup must hold every committed row").toBe(500);

    // the fault it replaces, asserted in the same test so the two cannot drift apart
    const copied = join(dir, "copied.db");
    copyFileSync(live, copied);
    expect(count(copied), "a plain cp sees only as far as the last checkpoint").toBe(1);
    db.close();
  });

  it("works on a database with nothing pending", () => {
    const live = join(dir, "quiet.db");
    const db = withPendingWal(live, 3);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const taken = join(dir, "taken.db");
    execFileSync(process.execPath, [SCRIPT, live, taken]);
    expect(count(taken)).toBe(3);
    db.close();
  });

  it("refuses to overwrite a backup that already exists", () => {
    // a backup names itself by the second, and two deploys inside one second must not silently
    // leave one of them unprotected
    const live = join(dir, "live.db");
    const db = withPendingWal(live, 5);
    const taken = join(dir, "taken.db");
    execFileSync(process.execPath, [SCRIPT, live, taken]);
    expect(() => execFileSync(process.execPath, [SCRIPT, live, taken], { stdio: "pipe" }))
      .toThrow();
    db.close();
  });

  it("names the database it could not find, because this runs inside make deploy", () => {
    // SQLite refuses to open a missing file read-only anyway, so the guard is not what makes this
    // fail — it is what makes the failure readable. A mutation sweep showed the test could not
    // tell "no such database: data/optionality-ts.db" from a raw SQLITE_CANTOPEN, and halfway
    // through a deploy the difference is the whole value.
    let stderr = "";
    try {
      execFileSync(process.execPath, [SCRIPT, join(dir, "nope.db"), join(dir, "out.db")],
        { stdio: "pipe" });
      throw new Error("it should have failed");
    } catch (err) {
      stderr = String((err as { stderr?: Buffer }).stderr ?? "");
    }
    expect(stderr).toContain("no such database");
    expect(stderr).toContain("nope.db");
  });

  it("leaves no log or shm file beside the backup it wrote", () => {
    // the backup is a resting file, not a live database: a stray -wal next to it would make a
    // later `cp` of the BACKUP wrong in the same way
    const live = join(dir, "live.db");
    const db = withPendingWal(live, 20);
    const taken = join(dir, "taken.db");
    execFileSync(process.execPath, [SCRIPT, live, taken]);
    for (const suffix of ["-wal", "-shm"]) {
      expect(() => statSync(`${taken}${suffix}`), `${suffix} should not exist`).toThrow();
    }
    db.close();
  });
});
