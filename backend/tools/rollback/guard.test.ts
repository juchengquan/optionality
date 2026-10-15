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
type Mon = string | { code: string; field?: string; threshold?: number; enabled?: number };
const mon = (m: Mon) => (typeof m === "string" ? { code: m } : m);

function pythonDb(
  path: string, positions: (string | { name: string; entry?: number })[], monitors: Mon[],
): void {
  const db = new DatabaseSync(path);
  db.exec(`create table positions (id text primary key, name text, entry real, contracts integer,
                                   strategy text, strike_date text, legs text);
           create table monitors (id text primary key, code text, field text, threshold real,
                                  direction text, compare text, enabled integer, strike_date text,
                                  option_type text, strike real, legs text)`);
  for (const [i, p] of positions.entries()) {
    const row = typeof p === "string" ? { name: p } : p;
    db.prepare("insert into positions values (?, ?, ?, 1, null, '2026-11-20', '[]')")
      .run(`p${i}`, row.name, row.entry ?? 1.0);
  }
  for (const [i, m] of monitors.entries()) {
    const r = mon(m);
    db.prepare(`insert into monitors values (?, ?, ?, ?, 'above', 'abs', ?, '2026-11-20',
                                             'CALL', 8000, null)`)
      .run(`m${i}`, r.code, r.field ?? "mid_price", r.threshold ?? 5, r.enabled ?? 1);
  }
  db.close();
}

/** The TypeScript shape: the two extra columns and the samples table ADR 0011 added. */
function tsDb(
  path: string, positions: { name: string; opened?: string | null; entry?: number }[],
  monitors: Mon[], samples = 0,
): void {
  const db = new DatabaseSync(path);
  db.exec(`create table positions (id text primary key, name text, entry real, contracts integer,
                                   strategy text, strike_date text, legs text, opened_at text);
           create table monitors (id text primary key, code text, field text, threshold real,
                                  direction text, compare text, enabled integer, strike_date text,
                                  option_type text, strike real, legs text);
           create table position_samples (position_id text, observed_on text);
           create table schema_migrations (name text, applied_at text)`);
  for (const [i, p] of positions.entries()) {
    db.prepare(`insert into positions values (?, ?, ?, 1, null, '2026-11-20', '[]', ?)`)
      .run(`q${i}`, p.name, p.entry ?? 1.0, p.opened ?? null);
  }
  for (const [i, m] of monitors.entries()) {
    const r = mon(m);
    db.prepare(`insert into monitors values (?, ?, ?, ?, 'above', 'abs', ?, '2026-11-20',
                                             'CALL', 8000, null)`)
      .run(`n${i}`, r.code, r.field ?? "mid_price", r.threshold ?? 5, r.enabled ?? 1);
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

describe("what a name-and-code diff could not see", () => {
  /** The guard compared position NAMES and monitor CODES and nothing else, so it answered "the
   *  two databases agree — a rollback would lose nothing" and exited 0 while every edit made
   *  since the cutover was about to be discarded. A code review found it by building the case;
   *  these are that case, as tests.
   *
   *  Identity matters as much as the fields: `uq_monitor_code_field UNIQUE (code, field)` means
   *  one contract legitimately carries several rules, so comparing codes alone makes two of
   *  three rules invisible.
   */
  it("sees a corrected entry on a holding that is present in both", async () => {
    pythonDb(join(dir, "py.db"), [{ name: "same", entry: 1.0 }], ["US.X"]);
    tsDb(join(dir, "ts.db"), [{ name: "same", entry: 9.99 }], ["US.X"]);

    const { code, out } = run();
    expect(code, out).not.toBe(0);
    expect(out).toContain("same");
    expect(out).toMatch(/1(\.0+)?\s*->\s*9\.99|9\.99/);
  });

  it("sees the rules a shared CODE was hiding, because identity is code AND field", async () => {
    // three rules on one contract is legal and ordinary: a mid, a delta and a vega alarm
    pythonDb(join(dir, "py.db"), ["same"], [{ code: "US.X", field: "mid_price" }]);
    tsDb(join(dir, "ts.db"), [{ name: "same" }], [
      { code: "US.X", field: "mid_price" },
      { code: "US.X", field: "option_delta" },
      { code: "US.X", field: "option_vega" },
    ]);

    const { code, out } = run();
    expect(code, out).not.toBe(0);
    expect(out).toContain("option_delta");
    expect(out).toContain("option_vega");
  });

  it("sees a moved threshold, which is the figure the alarm fires on", async () => {
    pythonDb(join(dir, "py.db"), ["same"], [{ code: "US.X", threshold: 5 }]);
    tsDb(join(dir, "ts.db"), [{ name: "same" }], [{ code: "US.X", threshold: 7.51 }]);

    const { code, out } = run();
    expect(code, out).not.toBe(0);
    expect(out).toContain("7.51");
  });

  it("sees a rule you muted, since the rollback would un-mute it", async () => {
    pythonDb(join(dir, "py.db"), ["same"], [{ code: "US.X", enabled: 1 }]);
    tsDb(join(dir, "ts.db"), [{ name: "same" }], [{ code: "US.X", enabled: 0 }]);

    const { code } = run();
    expect(code).not.toBe(0);
  });

  it("still allows it when the databases genuinely agree, field for field", async () => {
    // the guard has to stay passable, or the cutover's own failure path cannot use it
    pythonDb(join(dir, "py.db"), [{ name: "same", entry: 2.43 }], [{ code: "US.X", threshold: 7 }]);
    tsDb(join(dir, "ts.db"), [{ name: "same", entry: 2.43 }], [{ code: "US.X", threshold: 7 }]);

    const { code, out } = run();
    expect(code, out).toBe(0);
  });

  it("ignores the engine's own columns, which move every sweep", async () => {
    // last_checked_at, last_value, triggered and scope change every fifteen seconds. Refusing
    // over those would make "they agree" unreachable within one sweep of the cutover, which is
    // the window the cutover's failure path depends on.
    pythonDb(join(dir, "py.db"), ["same"], ["US.X"]);
    tsDb(join(dir, "ts.db"), [{ name: "same" }], ["US.X"]);
    const db = new DatabaseSync(join(dir, "ts.db"));
    db.exec("alter table monitors add column last_value real");
    db.exec("update monitors set last_value = 0.42");
    db.close();

    const { code, out } = run();
    expect(code, out).toBe(0);
  });
});

describe("comparing only what both schemas have", () => {
  it("compares a column one side lacks not at all, rather than letting read order decide", async () => {
    // The first spelling narrowed a shared module-level list in place while probing, so whichever
    // database was read first decided what the other was compared on. `opened_at` is the live
    // example of a column only one side has, and it is counted separately as a total loss.
    pythonDb(join(dir, "py.db"), [{ name: "same", entry: 2.43 }], [{ code: "US.X" }]);
    tsDb(join(dir, "ts.db"), [{ name: "same", entry: 2.43, opened: "2026-10-06" }], [{ code: "US.X" }]);

    const { code, out } = run();
    // refuses for the schedule, which is a total loss, and NOT for a phantom column difference
    expect(code, out).not.toBe(0);
    expect(out).toMatch(/1 exit schedule/);
    expect(out).not.toMatch(/CHANGED/);
  });
});
