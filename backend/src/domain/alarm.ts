/** Whether a reading changes a rule's alarm, and what the owner is told about it.
 *
 *  Lifted out of the middle of `MonitorSweeper.evaluate`, where it was four branches tangled with
 *  a row re-read, a silence count, a transaction and the writes — reachable only by driving a
 *  whole sweep against a database and a fake Provider. The decision itself needs none of those:
 *  the reading, what the database currently says, two knobs and a clock.
 *
 *  Not in `domain/`, deliberately. The maths is already there — `isBreached` is the rule, and it
 *  is golden-cased. What is here is this service's POLICY (a cooldown, a reminder cadence) and the
 *  WORDING of a Telegram message, and a domain module owes a golden case and a Python port that
 *  reproduces it exactly (ADR 0014); the notebook package has no use for the sentence the phone
 *  gets, and tying the two would mean a port every time the message is reworded.
 *
 *  The two kinds of answer are separate on purpose. `triggered` is the state the engine KEEPS and
 *  `notice` is what it SAYS, and they do not move together: inside the cooldown a fresh breach
 *  flips the flag and says nothing, and a persisting breach reminds without the flag changing at
 *  all. Collapsing them is how a throttled alarm re-announces itself on every sweep after — the
 *  flag never got written, so the next sweep sees the breach as fresh again.
 */
import { isBreached, type Monitor } from "./monitor.ts";

/** What the database says about this rule right now — re-read after the fetch, in the sweep. */
export interface AlarmState {
  triggered: boolean;
  /** when the owner was last told anything about this rule; null if never */
  lastAlarmAt: Date | null;
}

export interface AlarmPolicy {
  /** throttles state-CHANGE messages, so a value sitting on its threshold cannot flap the phone */
  cooldownSeconds: number;
  /** re-reminds about a breach that persists, so one missed message is not the end of it; 0 off */
  repeatSeconds: number;
}

export const alarmPolicy = (
  s: { alarmCooldownSeconds: number; alarmRepeatSeconds: number },
): AlarmPolicy => ({
  cooldownSeconds: s.alarmCooldownSeconds,
  repeatSeconds: s.alarmRepeatSeconds,
});

export interface AlarmDecision {
  /** the flag's new value, or null when this reading does not change it */
  triggered: boolean | null;
  /** what to send, or null for nothing. Non-null is also exactly when the stamp moves. */
  notice: string | null;
}

const UNCHANGED: AlarmDecision = { triggered: null, notice: null };

/** Never alarmed counts as long ago, not as never: a rule whose first breach the cooldown
 *  swallowed has a flag and no stamp, and reading that as "too soon" would silence it for ever. */
function secondsSince(when: Date | null, now: Date): number {
  if (when === null) return Number.POSITIVE_INFINITY;
  return (now.getTime() - when.getTime()) / 1000;
}

export function alarmTransition(
  monitor: Monitor, value: number, name: string,
  state: AlarmState, policy: AlarmPolicy, now: Date,
): AlarmDecision {
  const breached = isBreached(value, monitor.threshold, monitor.direction, monitor.compare);
  if (breached === state.triggered) {
    // the flag already says this; the only thing left to decide is whether to re-remind
    if (!breached) return UNCHANGED;
    const { repeatSeconds } = policy;
    if (!repeatSeconds || secondsSince(state.lastAlarmAt, now) < repeatSeconds) return UNCHANGED;
    return {
      triggered: null,
      notice: `⚠️ ${name}: ${monitor.field} ${figure(value)} still ${sign(monitor, value)} `
        + `${threshold(monitor, value)} (reminder)`,
    };
  }

  // the state changed, and it is written whether or not the owner hears about it
  const quiet = secondsSince(state.lastAlarmAt, now) < policy.cooldownSeconds;
  if (quiet) return { triggered: breached, notice: null };
  const words = breached
    ? `⚠️ ${name}: ${monitor.field} ${figure(value)} ${crossWord(monitor, value)} ${threshold(monitor, value)}`
    : `✅ ${name}: ${monitor.field} ${figure(value)} ${backWord(monitor, value)} ${threshold(monitor, value)}`;
  return { triggered: breached, notice: words };
}

/** The sentence, restated so it is TRUE of the figure it prints.
 *
 *  Two things have to hold at once, and the first attempt at this broke the second.
 *
 *  It must not assert a falsehood. `isBreached` compares `Math.abs(value)` under `compare: "abs"`,
 *  and the notice read `option_delta -0.151 crossed ≥ 0.12` — where -0.151 is not ≥ 0.12 — and
 *  `back below 0.12` about a value never above it. A short put's delta is negative by nature, so
 *  that is the owner's ordinary configuration, not a corner (review, 2026-11-01, against a live
 *  rule then 90% of the way to firing).
 *
 *  And the FIGURE must stay as it is, which `alarm.test.ts` has required since this module was
 *  written: "a notice reading 0.420 would not match the figure anywhere else on the dashboard".
 *  Printing the magnitude would have satisfied the first and broken that.
 *
 *  So the comparison is mirrored instead of the reading. Under `abs` a negative reading breaches
 *  exactly when it is on the far side of the NEGATED threshold — |v| ≥ t with v < 0 is v ≤ -t, and
 *  |v| ≤ t is v ≥ -t — so the direction word flips and the threshold is shown negated. Every
 *  branch then reads true of the number beside it, in all four combinations of direction and sign,
 *  and a signed rule is untouched.
 */
const signedCompare = (monitor: Monitor) => monitor.compare === "signed";
/** three decimals: a delta's third is the one that moves, and a mid's third is a tenth of a cent */
const figure = (value: number) => value.toFixed(3);
/** a magnitude rule read a negative figure, so the whole comparison is mirrored to suit it */
const mirrored = (monitor: Monitor, value: number) => !signedCompare(monitor) && value < 0;
const threshold = (monitor: Monitor, value: number) =>
  mirrored(monitor, value) ? -monitor.threshold : monitor.threshold;

/** anything that is not "below" is above, matching `isBreached` and the Python's `direction !=`.
 *  Flipped when the comparison is mirrored, which is what keeps the relation true. */
const below = (monitor: Monitor, value: number) =>
  (monitor.direction === "below") !== mirrored(monitor, value);
const sign = (m: Monitor, v: number) => (below(m, v) ? "≤" : "≥");
const crossWord = (m: Monitor, v: number) => (below(m, v) ? "fell ≤" : "crossed ≥");
const backWord = (m: Monitor, v: number) => (below(m, v) ? "back above" : "back below");
