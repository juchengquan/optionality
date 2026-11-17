/** The sweep's interval as the page sets it, and what becomes of a knob counted in sweeps (#442).
 *
 *  A decision, so it lives here rather than in the engine (ADR 0017), and it is cased and ported:
 *  both backends must scale the same knob to the same count, or the one running the service would
 *  quarantine a rule a sweep before or after the other.
 *
 *  ## Why a count becomes a time
 *
 *  The owner's decision, 2026-11-17 (ADR 0025). `DEGRADED_AFTER_FAILURES` (5) and
 *  `QUARANTINE_AFTER_SILENT_SWEEPS` (10) were sized at the .env interval, 15s: 75s and 150s. Left as
 *  counts, a 5s sweep would call monitoring degraded after 25s and quarantine a rule after 50s — the
 *  faster sweep checking more often AND judging sooner. So every knob counted in sweeps keeps its
 *  TIME, as sized at the .env interval, and its count follows the interval in force.
 *
 *  Rounded UP: a time that is not a whole number of sweeps becomes the next whole one, so a knob is
 *  never judged in less time than it was sized for — at 60s, five failures at 15s (75s) are two
 *  sweeps (120s), never one (60s). A count of 0, which turns its knob off, stays 0.
 */

/** The intervals the page offers, in seconds. Nothing below 5: each sweep is one moomoo snapshot
 *  call, limited to 60 per 30s and shared with every open page's polls. */
export const SWEEP_PRESETS = [5, 10, 15, 30, 60] as const;
export type SweepSeconds = (typeof SWEEP_PRESETS)[number];

/** Whether a value is one of the presets — a number, never the text of one. The database is read
 *  through this, because a hand-edited row is the one way a value the route refuses gets in. */
export function isSweepPreset(value: unknown): value is SweepSeconds {
  return typeof value === "number" && (SWEEP_PRESETS as readonly number[]).includes(value);
}

/** A knob counted in sweeps, sized at `sizedAtSeconds`, as a count at `everySeconds`: the same
 *  time, rounded up to a whole sweep. */
export function sweepsFor(count: number, sizedAtSeconds: number, everySeconds: number): number {
  return Math.ceil((count * sizedAtSeconds) / everySeconds);
}
