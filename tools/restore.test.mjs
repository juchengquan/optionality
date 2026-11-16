/** `make restore`, held without launchd: `restoreLive` is driven through a scripted stand-in for the
 *  system, as `use-backend.test.mjs` drives `switchTo`, and the backup check is the REAL one
 *  (`restore.ts --check`) against fixture backups in a temporary directory. Nothing here runs
 *  launchctl, touches the live database or reaches port 31415.
 *
 *  Written because the recipe this replaces stopped the API FIRST and checked the backup second:
 *  a FROM that was not intact left the service down, and a failure anywhere after the stop left it
 *  down too, since the start was the recipe's next line.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gzipSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LABEL, PORT } from "./use-backend.mjs";
import { restoreLive } from "./restore.mjs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const SCRIPT = join(ROOT, "tools", "restore.mjs");
// a launchd domain nobody has: were a real system ever to get this far, it would ask about nobody's agent
const UID = 99999;
const darwin = process.platform === "darwin";

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "restore-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function backupOf(rows) {
  const db = new DatabaseSync(join(dir, `src-${rows}.db`));
  db.exec("CREATE TABLE monitors (id INTEGER PRIMARY KEY)");
  for (let i = 1; i <= rows; i++) db.prepare("insert into monitors values (?)").run(i);
  db.close();
  const path = join(dir, `backup-${rows}.db.gz`);
  writeFileSync(path, gzipSync(readFileSync(join(dir, `src-${rows}.db`))));
  return path;
}

function badBackup() {
  const path = join(dir, "bad.db.gz");
  writeFileSync(path, gzipSync(Buffer.from("not a database")));
  return path;
}

/** The system, scripted: every call recorded; launchctl's answers, the restore's exit and /health's
 *  answers are whatever the test says. */
function scripted({ print = () => 113, bootstrap = 0, restore = 0, health = () => 200 } = {}) {
  const calls = [];
  let prints = 0, polls = 0;
  return {
    calls,
    dry: false,
    launchctl(args) {
      calls.push(`launchctl ${args.join(" ")}`);
      if (args[0] === "print") return { status: print(prints++), output: "" };
      if (args[0] === "bootstrap") return { status: bootstrap, output: bootstrap ? "Bootstrap failed: 5" : "" };
      return { status: 0, output: "" };
    },
    run(cmd, args) { calls.push(`run ${args.join(" ")}`); return restore; },
    write() { throw new Error("restore writes no plist"); },
    async portHeld() { return false; },
    async listener() { return null; },
    async health(url) { calls.push(`health ${url}`); return health(polls++); },
    async sleep() {},
  };
}

const options = (sys, from) => ({
  from, live: join(dir, "live.db"), home: join(dir, "home"), uid: UID, sys, say: () => {},
});
const plist = () => join(dir, "home", "Library", "LaunchAgents", `${LABEL}.plist`);
const touchesLaunchd = (sys) => sys.calls.some((c) => c.startsWith("launchctl"));

describe("make restore", () => {
  it("checks the backup BEFORE it stops the API, and a bad one never stops it", async () => {
    for (const from of [badBackup(), join(dir, "missing.db.gz")]) {
      const sys = scripted();
      await expect(restoreLive(options(sys, from))).rejects.toThrow(/not intact.*API was not stopped/s);
      expect(touchesLaunchd(sys), from).toBe(false);
      expect(sys.calls).toEqual([]);
    }
  });

  it("stops the API, restores, starts it again and waits for /health, in that order", async () => {
    const sys = scripted({ print: (n) => (n < 1 ? 0 : 113), health: (n) => (n < 2 ? null : 200) });
    const from = backupOf(3);
    await restoreLive(options(sys, from));
    expect(sys.calls).toEqual([
      `launchctl bootout gui/${UID}/${LABEL}`,
      `launchctl print gui/${UID}/${LABEL}`,
      `launchctl print gui/${UID}/${LABEL}`,
      `run backend/tools/backup/restore.ts ${from} ${join(dir, "live.db")}`,
      `launchctl bootstrap gui/${UID} ${plist()}`,
      `health http://127.0.0.1:${PORT}/health`,
      `health http://127.0.0.1:${PORT}/health`,
      `health http://127.0.0.1:${PORT}/health`,
    ]);
  });

  it("starts the API again when the restore itself fails", async () => {
    const sys = scripted({ restore: 1 });
    await expect(restoreLive(options(sys, backupOf(3)))).rejects.toThrow(/restore\.ts exited 1.*started again/s);
    expect(sys.calls).toContain(`launchctl bootstrap gui/${UID} ${plist()}`);
    expect(sys.calls.at(-1)).toMatch(/^health /);
  });

  it("starts the API again when it will not unload, and restores nothing", async () => {
    const sys = scripted({ print: () => 0 });
    await expect(restoreLive(options(sys, backupOf(3)))).rejects.toThrow(/still loaded/);
    expect(sys.calls.some((c) => c.startsWith("run"))).toBe(false);
    expect(sys.calls).toContain(`launchctl bootstrap gui/${UID} ${plist()}`);
  });

  it("says so, and where to look, when /health never answers 200 after the start", async () => {
    const sys = scripted({ health: () => 503 });
    await expect(restoreLive(options(sys, backupOf(3)))).rejects.toThrow(/no 200 from .*\/health.*optionality-api\.log/s);
  });

  it("says so when launchd refuses to start it again", async () => {
    const sys = scripted({ bootstrap: 5 });
    await expect(restoreLive(options(sys, backupOf(3)))).rejects.toThrow(/bootstrap.*NOT running/s);
  });
});

describe.skipIf(!darwin)("make restore's command line, under DRY_RUN=1", () => {
  const cli = (args) => spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8", env: { ...process.env, DRY_RUN: "1", HOME: join(dir, "home") },
  });

  it("refuses a bad backup without a word to launchd", () => {
    const r = cli([badBackup(), join(dir, "live.db")]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not intact/);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/launchctl/);
  });

  it("prints the whole restore for a good backup and does none of it", () => {
    mkdirSync(join(dir, "data"));
    const live = join(dir, "data", "live.db");
    writeFileSync(live, "the live file");
    const r = cli([backupOf(3), live]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/would run: launchctl bootout/);
    expect(r.stdout).toMatch(/would run: .*restore\.ts/);
    expect(r.stdout).toMatch(/would run: launchctl bootstrap/);
    expect(readdirSync(join(dir, "data"))).toEqual(["live.db"]);
  });

  it("answers its usage without arguments", () => {
    expect(cli([]).status).toBe(2);
  });
});
