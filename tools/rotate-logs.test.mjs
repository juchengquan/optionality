/** `tools/rotate-logs.mjs`, against log files in a temporary directory — never ~/Library/Logs.
 *
 *  Written because nothing rotated the agents' logs: on 2026-11-16 Caddy's was 54 MB and the API's
 *  6 MB and growing, each written by launchd through a descriptor it holds open.
 */
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { rotateLogs } from "./rotate-logs.mjs";

const SCRIPT = new URL("./rotate-logs.mjs", import.meta.url).pathname;
const MB = 1024 * 1024;

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rotate-logs-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const big = (name, text, size = 2 * MB) => writeFileSync(join(dir, name), text.padEnd(size, "."));
const unzip = (name) => gunzipSync(readFileSync(join(dir, name))).toString();

describe("rotating the agents' logs", () => {
  it("copies a log over the limit aside, gzipped, and empties it IN PLACE", async () => {
    big("optionality-ui.log", "first");
    const before = statSync(join(dir, "optionality-ui.log")).ino;
    await rotateLogs(dir, { maxBytes: MB, keep: 3, say: () => {} });
    expect(statSync(join(dir, "optionality-ui.log")).size).toBe(0);
    // the same file, not a new one: launchd's open descriptor still points at it
    expect(statSync(join(dir, "optionality-ui.log")).ino).toBe(before);
    expect(unzip("optionality-ui.log.1.gz")).toMatch(/^first\.+$/);
  });

  it("keeps a writer that holds the file open appending at the start, not at its old offset", async () => {
    // launchd opens StandardOutPath with O_APPEND: after the truncate its next line lands at byte 0
    big("optionality-api.log", "old");
    const fd = openSync(join(dir, "optionality-api.log"), "a");
    await rotateLogs(dir, { maxBytes: MB, keep: 3, say: () => {} });
    writeSync(fd, "after\n");
    closeSync(fd);
    expect(readFileSync(join(dir, "optionality-api.log"), "utf8")).toBe("after\n");
  });

  it("shifts the older copies along and drops what is past `keep`", async () => {
    for (const n of [1, 2, 3]) writeFileSync(join(dir, `optionality-api.log.${n}.gz`), `copy ${n}`);
    big("optionality-api.log", "newest");
    await rotateLogs(dir, { maxBytes: MB, keep: 3, say: () => {} });
    expect(readdirSync(dir).filter((f) => f.startsWith("optionality-api.log.")).sort())
      .toEqual(["optionality-api.log.1.gz", "optionality-api.log.2.gz", "optionality-api.log.3.gz"]);
    expect(unzip("optionality-api.log.1.gz")).toMatch(/^newest/);
    expect(readFileSync(join(dir, "optionality-api.log.2.gz"), "utf8")).toBe("copy 1");
    expect(readFileSync(join(dir, "optionality-api.log.3.gz"), "utf8")).toBe("copy 2");
  });

  it("leaves a log under the limit, and anything that is not one of ours, alone", async () => {
    writeFileSync(join(dir, "optionality-opend.log"), "small");
    big("someone-else.log", "theirs");
    await rotateLogs(dir, { maxBytes: MB, keep: 3, say: () => {} });
    expect(readFileSync(join(dir, "optionality-opend.log"), "utf8")).toBe("small");
    expect(statSync(join(dir, "someone-else.log")).size).toBe(2 * MB);
    expect(readdirSync(dir).sort()).toEqual(["optionality-opend.log", "someone-else.log"]);
  });

  it("runs from the command line with its defaults, and says what it rotated", () => {
    big("optionality-ui.log", "x", 11 * MB);
    const r = spawnSync(process.execPath, [SCRIPT, dir], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/optionality-ui\.log: 11\.0 MB/);
    expect(existsSync(join(dir, "optionality-ui.log.1.gz"))).toBe(true);
  });
});

describe.skipIf(process.platform !== "darwin")("the backup agent runs it", () => {
  const TEMPLATE = new URL("../deploy/macos/optionality-backup.launchd.plist.template", import.meta.url).pathname;

  /** The agent's ProgramArguments as launchd will read them, rendered as `make launchd-backup-install`
   *  renders the template, with "node" a stub that records each call and fails the backup on demand. */
  function agent(node) {
    const plist = join(dir, "backup.plist");
    writeFileSync(plist, readFileSync(TEMPLATE, "utf8")
      .replaceAll("__NODE__", node).replaceAll("__REPO__", dir)
      .replaceAll("__HOME__", join(dir, "a home")).replaceAll("__BACKUP_DIR__", join(dir, "Mobile Documents", "b")));
    expect(spawnSync("plutil", ["-lint", plist]).status).toBe(0);
    return JSON.parse(spawnSync("plutil", ["-extract", "ProgramArguments", "json", "-o", "-", plist], { encoding: "utf8" }).stdout);
  }

  it("rotates after the backup, even when the backup fails, and exits with the backup's status", () => {
    const calls = join(dir, "calls");
    const node = join(dir, "node stub");
    writeFileSync(node, `#!/bin/sh\nprintf '%s|' "$@" >> "${calls}"; echo >> "${calls}"\ncase "$1" in *nightly.ts) exit "$BACKUP_EXIT";; esac\n`);
    spawnSync("chmod", ["+x", node]);
    const [cmd, ...args] = agent(node);
    for (const backupExit of ["0", "3"]) {
      rmSync(calls, { force: true });
      const r = spawnSync(cmd, args, { cwd: dir, env: { PATH: "/usr/bin:/bin", BACKUP_EXIT: backupExit } });
      expect(r.status).toBe(Number(backupExit));
      expect(readFileSync(calls, "utf8").split("\n").filter(Boolean)).toEqual([
        `backend/tools/backup/nightly.ts|data/optionality-ts.db|${join(dir, "Mobile Documents", "b")}|`,
        `tools/rotate-logs.mjs|${join(dir, "a home", "Library", "Logs")}|`,
      ]);
    }
  });
});
