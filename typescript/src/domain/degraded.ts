/** What the owner is told when the service cannot see the market, and how often.
 *
 *  A decision, so it lives here rather than in the sweeper (ADR 0017): whether to speak, and the
 *  words. The sweeper keeps the counting and the sending.
 *
 *  ## Why the reminder exists
 *
 *  On 2026-11-08 moomoo's OpenD exited cleanly after 23 days up, nothing restarted it, and the
 *  sweep failed 646 times over 2h42m. The owner was told ONCE — at the fifth failure, correctly —
 *  and then heard nothing for the rest of it. The first notice was not the bug; the silence after
 *  it was. A message that arrives while you are making coffee is a message you did not get, and
 *  the engine went on knowing something the owner no longer did.
 *
 *  So this mirrors what a persisting breach already does in `alarm.ts`: one notice when the state
 *  changes, then a reminder at an interval while it has not changed back. The shapes are
 *  deliberately alike — `AlarmPolicy.repeatSeconds` and `DegradedPolicy.repeatSeconds` mean the
 *  same thing, and 0 turns each off.
 *
 *  ## What this is NOT
 *
 *  Not an Alarm. CONTEXT.md reserves that word for a Monitor whose threshold is breached and the
 *  message sent when that changes; this is the service reporting on itself, and no rule is
 *  involved. It is also not Quarantine: nothing is disabled here, because a provider that cannot
 *  answer says nothing about whether a rule is evaluable (ADR 0015).
 */

export interface DegradedState {
  /** consecutive failed sweeps, counting the one being recorded */
  failures: number;
  /** when the run of failures began; null when the service was restarted mid-outage */
  since: Date | null;
  /** when the owner was last told anything about this outage; null if never */
  lastNoticeAt: Date | null;
}

export interface DegradedPolicy {
  /** how many consecutive failures before the owner hears about it at all */
  afterFailures: number;
  /** re-reminds while it has not recovered, so one missed message is not the end of it; 0 off */
  repeatSeconds: number;
}

export const degradedPolicy = (
  s: { degradedAfterFailures: number; degradedRepeatSeconds: number },
): DegradedPolicy => ({
  afterFailures: s.degradedAfterFailures,
  repeatSeconds: s.degradedRepeatSeconds,
});

export interface DegradedVerdict {
  /** what to send, or null for nothing. Non-null is also exactly when the stamp moves. */
  notice: string | null;
}

const SILENT: DegradedVerdict = { notice: null };

/** How long it has been broken, or "" when the start is unknown.
 *
 *  Unknown is a real case rather than a defensive one: the failure counter lives in memory, so a
 *  service restarted mid-outage has failures and no start. Saying nothing is honest; deriving a
 *  start from the failure count would read as measured and be a guess about the sweep interval.
 */
function over(since: Date | null, now: Date): string {
  if (since === null) return "";
  const seconds = Math.floor((now.getTime() - since.getTime()) / 1000);
  if (seconds < 60) return " over under a minute";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return ` over ${minutes}m`;
  return ` over ${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

function since(when: Date | null, now: Date): number {
  if (when === null) return Number.POSITIVE_INFINITY;
  return (now.getTime() - when.getTime()) / 1000;
}

/** Whether to say anything about a failed sweep, and what.
 *
 *  `reason` comes from the caller and names no vendor: the Provider is whichever one this
 *  deployment is configured with, and a notice that says "OpenD" while IBKR is answering is the
 *  bug #205 removed from the sweeper's default.
 */
export function degradedVerdict(
  state: DegradedState, policy: DegradedPolicy, reason: string, now: Date,
): DegradedVerdict {
  const { failures } = state;
  if (failures < policy.afterFailures) return SILENT;

  const told = state.lastNoticeAt !== null;
  if (told) {
    // a reminder is due by the clock, not by the failure count, so the interval means the same
    // thing whatever MONITOR_INTERVAL_SECONDS is set to
    const { repeatSeconds } = policy;
    if (!repeatSeconds || since(state.lastNoticeAt, now) < repeatSeconds) return SILENT;
    return {
      notice: `⚠️ monitoring still degraded: ${failures} consecutive sweep failures`
        + `${over(state.since, now)} (${reason})`,
    };
  }

  // Past the threshold with nothing sent yet means the first notice never got out — a failed
  // Telegram send, or a service that started up already broken. The owner hears the FIRST
  // wording rather than a reminder, because "still degraded" implies an earlier message.
  return { notice: `⚠️ monitoring degraded: ${failures} consecutive sweep failures (${reason})` };
}

/** What to say when it comes back, or null when the owner was never told it was broken.
 *
 *  Announcing a recovery from a problem nobody heard about is noise, and noise is what teaches
 *  someone to stop reading the channel the alarms arrive on.
 */
export function recoveredNotice(
  state: DegradedState, policy: DegradedPolicy, now: Date,
): string | null {
  if (state.failures < policy.afterFailures) return null;
  const elapsed = over(state.since, now);
  return `✅ monitoring recovered${elapsed ? ` after${elapsed.replace(" over", "")}` : ""}`;
}
