/** The sweep's interval in force, where it came from, and the knobs it moves (#442, ADR 0025). */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { createDatabase } from "./db/open.ts";
import { readSweepInterval } from "./db/queries/index.ts";
import { DEFAULTS, type Settings } from "./env.ts";
import { atInterval, chooseSweepInterval, refusalWords, sweepInterval } from "./sweep-interval.ts";

/** `.env` as the live service has it: a 15s sweep, and the counted knobs at their defaults. */
const ENV: Settings = { ...DEFAULTS, monitorIntervalSeconds: 15 };
const NOW = new Date("2026-11-17T10:00:00.000Z");

let db: DatabaseSync | null = null;
function open(): DatabaseSync {
  db = createDatabase(join(mkdtempSync(join(tmpdir(), "optionality-interval-")), "t.db"));
  return db;
}
afterEach(() => {
  try { db?.close(); } catch { /* a test may have closed it */ }
  db = null;
});

describe("the interval in force", () => {
  it("is .env's while the page has chosen nothing", () => {
    expect(sweepInterval(open(), ENV))
      .toEqual({ seconds: 15, source: "env", defaultSeconds: 15, refused: null });
  });

  it("is the page's choice once it has made one, with .env's still named as the default", () => {
    const d = open();
    chooseSweepInterval(d, ENV, 5, NOW);
    expect(sweepInterval(d, ENV))
      .toEqual({ seconds: 5, source: "settings", defaultSeconds: 15, refused: null });
  });

  it("goes back to .env's when the choice is cleared, by deleting it rather than storing 15", () => {
    const d = open();
    chooseSweepInterval(d, ENV, 60, NOW);
    expect(chooseSweepInterval(d, ENV, null, NOW)).toEqual(
      { seconds: 15, source: "env", defaultSeconds: 15, refused: null });
    expect(readSweepInterval(d)).toBeUndefined();
  });

  it("stamps when the choice was made", () => {
    const d = open();
    chooseSweepInterval(d, ENV, 30, NOW);
    expect(readSweepInterval(d)).toEqual({ id: 1, seconds: 30, set_at: "2026-11-17 10:00:00.000000" });
  });

  it("refuses a stored value that is not a preset — a hand edit — and sweeps at .env's", () => {
    // the route writes only a preset, so anything else got in by hand: refused when READ, never a
    // crash and never a sweep every 2 seconds
    const d = open();
    for (const [stored, said] of [[7, "7"], [2, "2"], ["fast", "\"fast\""], [5.5, "5.5"]] as const) {
      d.prepare("insert or replace into sweep_interval values (1, ?, '2026-11-17 10:00:00.000000')")
        .run(stored);
      expect(sweepInterval(d, ENV), String(stored))
        .toEqual({ seconds: 15, source: "env", defaultSeconds: 15, refused: said });
    }
  });

  it("sweeps at .env's when the database cannot be read at all, rather than throwing", () => {
    // read at every tick of the loop: a throw there would stop the alarms
    const d = open();
    d.close();
    const read = sweepInterval(d, ENV);
    expect(read.seconds).toBe(15);
    expect(read.source).toBe("env");
    expect(read.refused).toMatch(/^unreadable: /);
  });
});

describe("what the log says of a refused value", () => {
  it("names what was stored and the interval used instead", () => {
    expect(refusalWords({ seconds: 15, source: "env", defaultSeconds: 15, refused: "2" })).toBe(
      "sweep_interval in the database is 2, not one of the presets: sweeping every 15s, "
      + "MONITOR_INTERVAL_SECONDS, until it is set from the page");
  });

  it("says a database it could not read as that, not as a value", () => {
    expect(refusalWords({ seconds: 15, source: "env", defaultSeconds: 15, refused: "unreadable: gone" }))
      .toBe("sweep_interval could not be read (gone): sweeping every 15s, MONITOR_INTERVAL_SECONDS");
  });
});

describe("the knobs counted in sweeps, at the interval in force", () => {
  // sized at .env's 15s: degraded 5 sweeps (75s), flapping 5 failures (75s of them), quarantine
  // 10 sweeps (150s) — the owner's decision is that each keeps its TIME
  const counted = (s: Settings) => [
    s.degradedAfterFailures, s.flappingAfterFailures, s.quarantineAfterSilentSweeps,
  ];

  it("are .env's at .env's interval", () => {
    expect(counted(atInterval(ENV, 15))).toEqual([5, 5, 10]);
  });

  it("triple at 5s, so a faster sweep checks more often and judges no sooner", () => {
    expect(counted(atInterval(ENV, 5))).toEqual([15, 15, 30]);
  });

  it("shrink at 60s, rounded up so none is judged in less time than it was sized for", () => {
    expect(counted(atInterval(ENV, 60))).toEqual([2, 2, 3]);
  });

  it("keep a knob that is off, off", () => {
    const off = { ...ENV, quarantineAfterSilentSweeps: 0, flappingAfterFailures: 0 };
    expect(counted(atInterval(off, 5))).toEqual([15, 0, 0]);
  });

  it("are sized at .env's interval, whatever it is", () => {
    expect(counted(atInterval({ ...ENV, monitorIntervalSeconds: 60 }, 5))).toEqual([60, 60, 120]);
  });

  it("leave every knob that is a time, not a count, as it was", () => {
    const at = atInterval(ENV, 5);
    expect({ ...at, degradedAfterFailures: 5, flappingAfterFailures: 5, quarantineAfterSilentSweeps: 10 })
      .toEqual(ENV);
  });
});
