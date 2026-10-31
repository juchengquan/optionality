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
import { isBreached, type Monitor } from "./domain/monitor.ts";

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
      notice: `⚠️ ${name}: ${monitor.field} ${figure(value)} still ${sign(monitor)} `
        + `${monitor.threshold} (reminder)`,
    };
  }

  // the state changed, and it is written whether or not the owner hears about it
  const quiet = secondsSince(state.lastAlarmAt, now) < policy.cooldownSeconds;
  if (quiet) return { triggered: breached, notice: null };
  const words = breached
    ? `⚠️ ${name}: ${monitor.field} ${figure(value)} ${crossWord(monitor)} ${monitor.threshold}`
    : `✅ ${name}: ${monitor.field} ${figure(value)} ${backWord(monitor)} ${monitor.threshold}`;
  return { triggered: breached, notice: words };
}

/** three decimals: a delta's third is the one that moves, and a mid's third is a tenth of a cent */
const figure = (value: number) => value.toFixed(3);

/** anything that is not "below" is above, matching `isBreached` and the Python's `direction !=` */
const below = (monitor: Monitor) => monitor.direction === "below";
const sign = (monitor: Monitor) => (below(monitor) ? "≤" : "≥");
const crossWord = (monitor: Monitor) => (below(monitor) ? "fell ≤" : "crossed ≥");
const backWord = (monitor: Monitor) => (below(monitor) ? "back above" : "back below");
