/** The rows a sweep test needs in a database, and a fetcher that prices them.
 *
 *  Here rather than in a test file because two suites drive the sweep now: `sweeper.test.ts` for
 *  the alarms, and `positions.test.ts` for what the same batch does to holdings — the sampler and
 *  the manage-by notice, which are `positions.ts`'s and spent 494 lines inside the alarm engine's
 *  suite because that is where the batch happened to be. Nobody looking for the sampler's tests
 *  found them there.
 *
 *  Each builder takes its database explicitly rather than closing over a fixture: the fixture is
 *  per-test (a fresh temp database in `beforeEach`), and a module-level one shared between files
 *  is how two suites end up writing to each other's rows.
 */
import type { DatabaseSync } from "node:sqlite";

import { toSqliteJson } from "../src/db/values.ts";
import type { Settings } from "../src/env.ts";
import type { FakeProvider } from "./harness.ts";

/** The Python's own fixture settings: telegram configured, no cooldown. The display zone is the
 *  owner's, so a UTC-only test cannot pass by coincidence — both suites pin TZ=UTC. */
export const SWEEP_SETTINGS: Partial<Settings> = {
  telegramBotToken: "t", telegramChatId: "c", alarmCooldownSeconds: 0, displayTz: "Asia/Singapore",
};

/** A single-contract monitor on SPXW, as the dashboard's form would have made it. */
export const SINGLE_CODE = "US.SPXW261218C6500000";

let seq = 0;

/** One monitor row, and its id. `strike_date` is the caller's business: it is reckoned from the
 *  test's own clock, which this module deliberately knows nothing about. */
export function insertMonitor(db: DatabaseSync, over: Record<string, unknown> = {}): string {
  seq += 1;
  const row = {
    id: `m${seq}`.padEnd(32, "0"),
    strike_date: "",
    code: SINGLE_CODE, option_type: "CALL", strike: 6500,
    field: "option_delta", threshold: 0.6, direction: "above", compare: "abs",
    legs: null as unknown, scope: null as string | null, enabled: 1, disabled_reason: null,
    ...over,
  };
  db.prepare(
    `insert into monitors (id, code, strike_date, option_type, strike, field, threshold,
       direction, compare, legs, scope, enabled, disabled_reason, triggered, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '2026-08-01 00:00:00.000000')`,
  ).run(row.id, row.code, row.strike_date, row.option_type, row.strike, row.field,
    row.threshold, row.direction, row.compare,
    row.legs === null ? null : toSqliteJson(row.legs), row.scope,
    row.enabled, row.disabled_reason);
  return row.id;
}

/** A two-leg call spread as a combo monitor: one code of its own, legs that each price. */
export function insertCombo(db: DatabaseSync, over: Record<string, unknown> = {}): string {
  return insertMonitor(db, {
    code: "sep-condor", option_type: "CMB", strike: 0, field: "mid_price", threshold: 10,
    direction: "below",
    legs: [
      { sign: 1, option_type: "CALL", strike: 8100 },
      { sign: -1, option_type: "CALL", strike: 8150 },
    ],
    ...over,
  });
}

/** A fetcher returning one field per code, read from a mutable table so a test can move the
 *  market. A code absent from the table is simply not answered for — which is what "subscribed,
 *  nothing yet" looks like to the sweep, and is NOT the same as `unknown`. */
export function quoting(field: string, values: Record<string, number>): FakeProvider {
  return (codes) => Promise.resolve(
    codes.filter((c) => c in values).map((c) => ({ code: c, name: c, [field]: values[c] })),
  );
}

export interface MonitorState {
  triggered: number;
  last_value: number | null;
  last_checked_at: string | null;
  enabled: number;
  disabled_reason: string | null;
}

/** What a sweep left on a monitor row. */
export function monitorState(db: DatabaseSync, id: string): MonitorState | undefined {
  return db.prepare("select * from monitors where id = ?").get(id) as MonitorState | undefined;
}
