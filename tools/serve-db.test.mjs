/** `make serve`'s snapshot runs with the sweep at an hour, so a local instance is not a second
 *  sweeper beside the live service (Makefile). Since ADR 0025 the database can override that: a
 *  `sweep_interval` row copied with the snapshot would sweep live OpenD every 5–60s from here. So
 *  the recipe clears it from the SNAPSHOT after its backup — and never from the live file (#442's
 *  review).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const TOOL = join(ROOT, "tools/serve-db.mjs");

function database(dir, name) {
  const path = join(dir, name);
  const db = new DatabaseSync(path);
  db.exec("create table sweep_interval (id integer not null check (id = 1), seconds integer not null, set_at datetime not null, primary key (id))");
  db.exec("insert into sweep_interval values (1, 5, '2026-11-17 10:00:00.000000')");
  db.close();
  return path;
}
const rows = (path) => {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return db.prepare("select count(*) as n from sweep_interval").get().n; } finally { db.close(); }
};

describe("the serve snapshot's sweep interval", () => {
  it("is cleared, so the snapshot sweeps at the recipe's hour", () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-db-"));
    const live = database(dir, "optionality-ts.db");
    const serve = database(dir, "optionality-ts.db.serve");
    execFileSync(process.execPath, [TOOL, serve, "--not", live]);
    expect(rows(serve)).toBe(0);
    expect(rows(live), "the live file was touched").toBe(1);
  });

  it("leaves a snapshot from before migration 0016 alone, which has no choice to clear", () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-db-"));
    const live = database(dir, "optionality-ts.db");
    const old = join(dir, "old.serve");
    new DatabaseSync(old).close();
    const run = spawnSync(process.execPath, [TOOL, old, "--not", live], { encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
  });

  it("refuses the live file, by any spelling of its path", () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-db-"));
    const live = database(dir, "optionality-ts.db");
    for (const target of [live, join(dir, ".", "optionality-ts.db")]) {
      const run = spawnSync(process.execPath, [TOOL, target, "--not", live], { encoding: "utf8" });
      expect(run.status, target).not.toBe(0);
      expect(run.stderr).toMatch(/refusing/);
    }
    expect(rows(live)).toBe(1);
  });

  it("is what the serve recipe does, after the backup and before the service starts", () => {
    const recipe = readFileSync(join(ROOT, "Makefile"), "utf8").split(/^serve:\n/m)[1].split(/\n\n/)[0];
    const backup = recipe.indexOf("backup.ts $(TS_DB) $(SERVE_DB)");
    const clear = recipe.indexOf("tools/serve-db.mjs $(SERVE_DB) --not $(TS_DB)");
    const start = recipe.indexOf("backend/src/main.ts");
    expect(backup).toBeGreaterThanOrEqual(0);
    expect(clear, "the recipe no longer clears the snapshot's interval").toBeGreaterThan(backup);
    expect(start).toBeGreaterThan(clear);
  });
});
