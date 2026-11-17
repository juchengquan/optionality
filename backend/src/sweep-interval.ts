/** The sweep's interval in force, where it came from, and the knobs it moves (#442, ADR 0025).
 *
 *  The ONE behaviour knob kept in the database. `.env`'s MONITOR_INTERVAL_SECONDS is the default and
 *  stays in force until the page chooses a preset; the page's choice is a row in `sweep_interval`,
 *  and clearing it is the way back. Paired with `routes/settings.ts` the way `references.ts` is with
 *  its routes: this module does the work, the route reports it.
 *
 *  READ, never remembered. The engine asks at every tick, the health account at every reading and
 *  `/health` at every request, so a choice made on the page is in force at the next sweep with no
 *  restart — and there is no copy in memory for the routes, which may not reach the engine, to have
 *  to update.
 */
import type { DatabaseSync } from "node:sqlite";

import { isSweepPreset, type SweepSeconds, sweepsFor } from "optionality/domain/cadence";
import { clearSweepInterval, readSweepInterval, writeSweepInterval } from "./db/queries/index.ts";
import { toSqlDatetime } from "./db/time.ts";
import type { Settings } from "./env.ts";

export type SweepSource = "settings" | "env";

export interface SweepInterval {
  /** the interval the engine sweeps at now */
  seconds: number;
  /** "settings" when the page chose it, "env" when it is `.env`'s */
  source: SweepSource;
  /** `.env`'s interval: the default, and what every counted knob was sized at */
  defaultSeconds: number;
  /** a stored value that was not used, as it was found, or null. The route writes only a preset, so
   *  this is a hand edit — or a database that could not be read at all, which sweeps at `.env`'s
   *  rather than throwing: this is read at every tick, and a throw there would stop the alarms. */
  refused: string | null;
}

function fromEnv(settings: Settings, refused: string | null): SweepInterval {
  const seconds = settings.monitorIntervalSeconds;
  return { seconds, source: "env", defaultSeconds: seconds, refused };
}

export function sweepInterval(db: DatabaseSync, settings: Settings): SweepInterval {
  let stored: unknown;
  try {
    stored = readSweepInterval(db)?.seconds;
  } catch (err) {
    return fromEnv(settings, `unreadable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (stored === undefined) return fromEnv(settings, null);
  if (!isSweepPreset(stored)) return fromEnv(settings, JSON.stringify(stored));
  return {
    seconds: stored, source: "settings", defaultSeconds: settings.monitorIntervalSeconds, refused: null,
  };
}

/** The page's choice, or null for `.env`'s; answered with the interval now in force. */
export function chooseSweepInterval(
  db: DatabaseSync, settings: Settings, seconds: SweepSeconds | null, now: Date,
): SweepInterval {
  if (seconds === null) clearSweepInterval(db);
  else writeSweepInterval(db, seconds, toSqlDatetime(now));
  return sweepInterval(db, settings);
}

/** The knobs COUNTED IN SWEEPS, at the interval in force: each keeps the time it was sized for at
 *  `.env`'s interval (the owner's decision; `domain/cadence.ts`).
 *
 *  Three, and the list is the whole of it — every other knob is already a time:
 *  - `degradedAfterFailures`: consecutive failed sweeps before the degraded notice;
 *  - `quarantineAfterSilentSweeps`: consecutive sweeps a figure may not arrive for;
 *  - `flappingAfterFailures`: failed sweeps inside a WINDOW of time before the unreliable notice.
 *    Not a run, but still a count of sweeps: a faster sweep fails more often in the same outage, so
 *    five failures in fifteen minutes at 5s is 25s of failure where at 15s it was 75s. Kept as the
 *    time of failure, it scales like the other two.
 *  The fourth thing counted in sweeps, `STALE_AFTER_SWEEPS`, is the engine's own and is scaled
 *  there, with a floor (`engine/health.ts`).
 */
export function atInterval(settings: Settings, everySeconds: number): Settings {
  const sized = settings.monitorIntervalSeconds;
  const scaled = (count: number) => sweepsFor(count, sized, everySeconds);
  return {
    ...settings,
    degradedAfterFailures: scaled(settings.degradedAfterFailures),
    flappingAfterFailures: scaled(settings.flappingAfterFailures),
    quarantineAfterSilentSweeps: scaled(settings.quarantineAfterSilentSweeps),
  };
}
