/** What a rollback would cost, before it costs it.
 *
 *  `make rollback` swapped the launchd agent, printed /health and said "rolled back to the Python
 *  service". It said nothing about the database, and the two have diverged since the cutover:
 *  measured on 2026-10-15, rolling back would have restored four positions the owner had
 *  deliberately closed, lost the one actually held, lost ALL seven monitors, and lost every exit
 *  schedule and the whole vol history — the Python schema has no `position_samples` and no
 *  `opened_at` (ADR 0011 diverged them).
 *
 *  That is not a degraded safety net, it is a trap: in a crisis it hands you a dashboard showing
 *  closed trades and no alarms. The window stays open until phase 10, so the guard is what makes
 *  it survivable — it refuses, and says exactly what would go.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "optionality-guard-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const SCRIPT = new URL("./guard.mjs", import.meta.url).pathname;

/** The Python shape: no position_samples, no opened_at, no schema_migrations. */
function pythonDb(path: string, positions: string[], monitors: string[]): void {
  const db = new DatabaseSync(path);
  db.exec(`create table positions (id text primary key, name text, entry real);
           create table monitors (id text primary key, code text)`);
  for (const [i, n] of positions.entries()) {
    db.prepare("insert into positions values (?, ?, 1.0)").run(`p${i}`, n);
  }
  for (const [i, c] of monitors.entries()) {
    db.prepare("insert into monitors values (?, ?)").run(`m${i}`, c);
  }
  db.close();
}

/** The TypeScript shape: the two extra columns and the samples table ADR 0011 added. */
function tsDb(
  path: string, positions: { name: string; opened?: string | null }[],
  monitors: string[], samples = 0,
): void {
  const db = new DatabaseSync(path);
  db.exec(`create table positions (id text primary key, name text, entry real, opened_at text);
           create table monitors (id text primary key, code text);
           create table position_samples (position_id text, observed_on text);
           create table schema_migrations (name text, applied_at text)`);
  for (const [i, p] of positions.entries()) {
    db.prepare("insert into positions values (?, ?, 1.0, ?)").run(`q${i}`, p.name, p.opened ?? null);
  }
  for (const [i, c] of monitors.entries()) {
    db.prepare("insert into monitors values (?, ?)").run(`n${i}`, c);
  }
  for (let i = 0; i < samples; i++) {
    db.prepare("insert into position_samples values ('q0', ?)").run(`2026-10-${10 + i}`);
  }
  db.close();
}

/** BOTH streams. The guard writes its report to stderr — it is a warning either way, including
 *  when it is proceeding — and the first spelling of this read stdout alone, so the forced case
 *  looked silent when it was not. */
const run = (args: string[] = []): { code: number; out: string } => {
  const r = spawnSync("node", [SCRIPT, join(dir, "py.db"), join(dir, "ts.db"), ...args],
    { encoding: "utf8" });
  return { code: r.status ?? -1, out: (r.stdout ?? "") + (r.stderr ?? "") };
};

describe("refusing a rollback that would lose live state", () => {
  it("refuses, and names every holding that would vanish", async () => {
    pythonDb(join(dir, "py.db"), ["old_condor"], ["old_rule"]);
    tsDb(join(dir, "ts.db"), [{ name: "live_spread", opened: "2026-10-06" }], ["live_rule"], 4);

    const { code, out } = run();
    expect(code, out).not.toBe(0);
    expect(out).toContain("live_spread");
    expect(out).toContain("live_rule");
  });

  it("names what it would RESURRECT, which is the half nobody expects", async () => {
    // the dangerous direction: a rollback does not just lose the new, it brings back trades that
    // were deliberately closed, and shows them as open
    pythonDb(join(dir, "py.db"), ["closed_1030", "closed_1120b"], []);
    tsDb(join(dir, "ts.db"), [{ name: "live_spread" }], []);

    const { out } = run();
    expect(out).toContain("closed_1030");
    expect(out).toContain("closed_1120b");
  });

  it("says the exit schedules and the samples go entirely, not partly", async () => {
    // the Python schema has neither column nor table, so this is not a diff — it is a total loss,
    // and the samples cannot be rebuilt because IV and vega are only knowable on the day
    pythonDb(join(dir, "py.db"), ["old"], []);
    tsDb(join(dir, "ts.db"), [{ name: "a", opened: "2026-10-06" }, { name: "b", opened: null }], [], 7);

    const { out } = run();
    expect(out).toMatch(/1 exit schedule/);
    expect(out).toMatch(/7 .*sample/i);
  });

  it("allows it when the two databases agree, because then it costs nothing", async () => {
    pythonDb(join(dir, "py.db"), ["same"], ["rule"]);
    tsDb(join(dir, "ts.db"), [{ name: "same" }], ["rule"]);

    const { code, out } = run();
    expect(code, out).toBe(0);
  });

  it("allows it when explicitly forced, and says what was accepted", async () => {
    // a guard that cannot be overridden is a guard someone works around. The override is a word
    // you have to type, and it prints the loss anyway so it is never silent.
    pythonDb(join(dir, "py.db"), ["old"], []);
    tsDb(join(dir, "ts.db"), [{ name: "live" }], [], 3);

    const { code, out } = run(["--i-accept-the-loss"]);
    expect(code, out).toBe(0);
    expect(out).toContain("live");
    expect(out).toMatch(/accepted|proceeding/i);
  });

  it("refuses rather than guessing when a database is missing", async () => {
    pythonDb(join(dir, "py.db"), ["old"], []);
    const { code, out } = run();
    expect(code).not.toBe(0);
    expect(out).toMatch(/no such database|cannot/i);
  });
});
