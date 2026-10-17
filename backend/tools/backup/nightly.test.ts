/** The nightly backup and both retention rules.
 *
 *  The live database is the one thing on this machine that cannot be rebuilt: rules and holdings can
 *  be retyped, the daily samples cannot (ADR 0011). One copy protects against a dead disk but not
 *  against bad data, which the next night copies faithfully over the last good one — so a history is
 *  kept: 14 nights, and the first backup of each of the last 12 months.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { retainDeploy, retainNightly, verifyCopy } from "./retention.mjs";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "optionality-nightly-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const SCRIPT = new URL("./nightly.mjs", import.meta.url).pathname;
const nightly = (yyyymmdd: string) => `optionality-ts-${yyyymmdd}.db.gz`;

/** every day from `from` for `n` days, as nightly file names */
function days(from: string, n: number): string[] {
  const start = Date.parse(`${from}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) =>
    nightly(new Date(start + i * 86_400_000).toISOString().slice(0, 10).replaceAll("-", "")));
}

describe("which nightly backups are kept", () => {
  it("keeps the last 14 nights", () => {
    const files = days("2026-10-01", 20);
    const { keep } = retainNightly(files);
    expect(keep.filter((f) => f >= nightly("20261007"))).toHaveLength(14);
    expect(keep).toContain(nightly("20261020"));
    expect(keep).not.toContain(nightly("20261006"));
  });

  it("keeps the first backup of each of the last 12 months, beyond the 14 nights", () => {
    const files = days("2025-01-01", 600); // well over a year of nights
    const { keep, drop } = retainNightly(files);
    const monthly = keep.filter((f) => !days("2026-08-10", 14).includes(f));
    expect(monthly).toHaveLength(12);
    // the earliest of its month, the 12 most recent months that have one
    expect(monthly.every((f) => f.endsWith("01.db.gz"))).toBe(true);
    expect(monthly[0]).toBe(nightly("20250901"));
    expect(drop).toContain(nightly("20250801"));
    expect(keep.length + drop.length).toBe(files.length);
  });

  it("keeps the earliest backup a month HAS, when the machine was off on the 1st", () => {
    const files = [nightly("20260903"), nightly("20260915"), ...days("2026-10-10", 14)];
    expect(retainNightly(files).keep).toContain(nightly("20260903"));
    expect(retainNightly(files).drop).toEqual([nightly("20260915")]);
  });

  it("never touches a file it did not name", () => {
    const files = [...days("2026-01-01", 300), "notes.txt", "optionality-ts-restore-test.db.gz"];
    const { keep, drop } = retainNightly(files);
    expect(drop.filter((f) => !/^optionality-ts-\d{8}\.db\.gz$/.test(f))).toEqual([]);
    expect(keep).not.toContain("notes.txt");
  });
});

describe("which deploy backups are kept", () => {
  const deploy = (stamp: string) => `optionality-ts.db.bak-${stamp}`;

  it("keeps the last 10 and every backup that was given a name", () => {
    const rotating = Array.from({ length: 15 }, (_, i) => deploy(`202610${String(i + 1).padStart(2, "0")}-120000`));
    const named = ["optionality-ts.db.bak-predelete-20261012-214223", "optionality-ts.db.bak-pre-0005-20261017-154615"];
    const { keep, drop } = retainDeploy([...rotating, ...named]);
    expect(keep).toEqual(expect.arrayContaining(named));
    expect(keep.filter((f) => rotating.includes(f))).toEqual(rotating.slice(-10));
    expect(drop).toEqual(rotating.slice(0, 5));
  });

  it("takes a dropped backup's -wal and -shm with it", () => {
    const old = deploy("20261001-120000");
    const files = [old, `${old}-wal`, `${old}-shm`, ...Array.from({ length: 10 }, (_, i) => deploy(`2026101${i}-120000`))];
    expect(retainDeploy(files).drop.sort()).toEqual([old, `${old}-shm`, `${old}-wal`]);
  });

  it("never touches the live database or anything else in data/", () => {
    const files = ["optionality-ts.db", "optionality-ts.db-wal", "optionality-ts.db-shm", "optionality.db",
      ...Array.from({ length: 12 }, (_, i) => deploy(`2026100${i}-120000`))];
    const { drop } = retainDeploy(files);
    expect(drop.some((f) => !f.startsWith("optionality-ts.db.bak-"))).toBe(false);
  });
});

describe("the nightly run", () => {
  function live(path: string, rows: number): DatabaseSync {
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("CREATE TABLE monitors (id INTEGER PRIMARY KEY, v TEXT)");
    db.prepare("insert into monitors values (1, 'checkpointed')").run();
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    // the rest still in the write-ahead log, the live service's normal state
    for (let i = 2; i <= rows; i++) db.prepare("insert into monitors values (?, 'pending')").run(i);
    return db;
  }

  it("writes one gzipped file holding every committed row, including the ones still in the WAL", () => {
    const src = join(dir, "live.db");
    const out = join(dir, "backups");
    const db = live(src, 50);
    execFileSync(process.execPath, [SCRIPT, src, out, "--today", "20261017"]);
    db.close();

    expect(readdirSync(out)).toEqual([nightly("20261017")]); // nothing beside it: no -wal, no -shm
    const restored = join(dir, "restored.db");
    writeFileSync(restored, gunzipSync(readFileSync(join(out, nightly("20261017")))));
    const back = new DatabaseSync(restored, { readOnly: true });
    expect(back.prepare("select count(*) n from monitors").get()).toEqual({ n: 50 });
    expect(back.prepare("pragma integrity_check").get()).toEqual({ integrity_check: "ok" });
    back.close();
  });

  it("replaces tonight's file if it runs twice, and prunes what the rule drops", () => {
    const src = join(dir, "live.db");
    const out = join(dir, "backups");
    const db = live(src, 3);
    execFileSync("mkdir", ["-p", out]);
    for (const f of days("2026-09-01", 30)) writeFileSync(join(out, f), "old");
    execFileSync(process.execPath, [SCRIPT, src, out, "--today", "20261017"]);
    execFileSync(process.execPath, [SCRIPT, src, out, "--today", "20261017"]);
    db.close();

    const kept = readdirSync(out).sort();
    expect(kept).toContain(nightly("20261017"));
    expect(kept).toContain(nightly("20260901")); // September's first
    expect(kept.filter((f) => f >= nightly("20260918"))).toHaveLength(14);
    expect(kept).toHaveLength(15);
  });
});

describe("checking a copy before it is kept", () => {
  it("refuses a copy that is missing rows the live database had before it was taken", () => {
    // the failure `cp` produced: valid SQLite, opens cleanly, quietly missing what was in the WAL
    const copy = join(dir, "copy.db");
    const c = new DatabaseSync(copy);
    c.exec("CREATE TABLE monitors (id INTEGER PRIMARY KEY)");
    c.prepare("insert into monitors values (1)").run();
    c.close();
    expect(() => verifyCopy(copy, { monitors: 50 }, { monitors: 50 })).toThrow(/monitors: 1 rows/);
  });

  it("accepts a copy taken while the sweep was adding rows, between the before and after counts", () => {
    const copy = join(dir, "copy.db");
    const c = new DatabaseSync(copy);
    c.exec("CREATE TABLE position_samples (id INTEGER PRIMARY KEY)");
    for (let i = 1; i <= 7; i++) c.prepare("insert into position_samples values (?)").run(i);
    c.close();
    expect(() => verifyCopy(copy, { position_samples: 6 }, { position_samples: 8 })).not.toThrow();
  });

  it("refuses a copy that is not intact", () => {
    const copy = join(dir, "copy.db");
    writeFileSync(copy, "this is not a database");
    expect(() => verifyCopy(copy, {}, {})).toThrow();
  });
});

describe("restoring a nightly backup", () => {
  const RESTORE = new URL("./restore.mjs", import.meta.url).pathname;
  const run = (...args: string[]) => execFileSync(process.execPath, [RESTORE, ...args], { encoding: "utf8" });

  /** a nightly file holding `rows` monitors */
  function nightlyOf(rows: number): string {
    const src = join(dir, `src-${rows}.db`);
    const db = new DatabaseSync(src);
    db.exec("CREATE TABLE monitors (id INTEGER PRIMARY KEY)");
    for (let i = 1; i <= rows; i++) db.prepare("insert into monitors values (?)").run(i);
    db.close();
    const out = join(dir, `out-${rows}`);
    execFileSync(process.execPath, [SCRIPT, src, out, "--today", "20261017"]);
    return join(out, nightly("20261017"));
  }

  it("puts the backup in place, and removes the live file's -wal and -shm first", () => {
    // left beside the restored file, SQLite would replay the OLD log onto it
    const live = join(dir, "live.db");
    const db = new DatabaseSync(live);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("CREATE TABLE monitors (id INTEGER PRIMARY KEY)");
    for (let i = 1; i <= 99; i++) db.prepare("insert into monitors values (?)").run(i);
    // closed without checkpointing would be the crash case; a copy of the sidecars stands in for it
    execFileSync("cp", [`${live}-wal`, `${dir}/stale-wal`]);
    db.close();
    execFileSync("cp", [`${dir}/stale-wal`, `${live}-wal`]);

    run(nightlyOf(3), live);

    expect(readdirSync(dir).filter((f) => f.startsWith("live.db-"))).toEqual([]);
    const back = new DatabaseSync(live, { readOnly: true });
    expect(back.prepare("select count(*) n from monitors").get()).toEqual({ n: 3 });
    back.close();
  });

  it("keeps what it replaced, under a name the deploy pruning never deletes", () => {
    const live = join(dir, "optionality-ts.db");
    const db = new DatabaseSync(live);
    db.exec("CREATE TABLE monitors (id INTEGER PRIMARY KEY)");
    db.prepare("insert into monitors values (1)").run();
    db.close();
    run(nightlyOf(3), live);
    const saved = readdirSync(dir).filter((f) => f.startsWith("optionality-ts.db.bak-pre-restore-"));
    expect(saved).toHaveLength(1);
    expect(retainDeploy([...saved, ...Array.from({ length: 20 }, (_, i) => `optionality-ts.db.bak-202610${10 + i}-120000`)]).drop)
      .not.toContain(saved[0]);
  });

  it("refuses a backup that is not intact, and leaves the live file alone", () => {
    const live = join(dir, "live.db");
    const db = new DatabaseSync(live);
    db.exec("CREATE TABLE monitors (id INTEGER PRIMARY KEY)");
    db.close();
    const bad = join(dir, "bad.db.gz");
    writeFileSync(bad, gzipSync(Buffer.from("not a database")));
    expect(() => run(bad, live)).toThrow();
    const back = new DatabaseSync(live, { readOnly: true });
    expect(back.prepare("select count(*) n from monitors").get()).toEqual({ n: 0 });
    back.close();
  });
});
