/** A provider that keeps failing and recovering, which no consecutive count can see.
 *
 *  A decision, so it lives here rather than in the sweeper (ADR 0017): whether to speak, and the
 *  words. The sweeper keeps the counting and the sending.
 *
 *  ## Why this exists, measured
 *
 *  On 2026-11-08 a launchd agent — added that afternoon to supervise OpenD — was killing it 27
 *  seconds after every start and restarting it a minute later. 39 starts in an hour, `/quotes`
 *  502ing in the gaps, the sweep failing roughly a third of the time. The owner found it by
 *  looking at the dashboard.
 *
 *  Nothing in the service noticed, and `degraded.ts` could not have: it counts CONSECUTIVE
 *  failures, and every success in between reset the counter below its threshold. So an hour of
 *  intermittent failure produced no notice at all, while a five-minute total outage would have
 *  produced one in the first minute. A consecutive count measures the LENGTH of a failure, and
 *  nothing measures how OFTEN one happens.
 *
 *  That is the gap: a provider which is down is detected, and a provider which is unreliable is
 *  not. This measures the rate instead — failures inside a moving window, whatever happened
 *  between them.
 *
 *  ## What it is NOT
 *
 *  Not an Alarm: CONTEXT.md reserves that word for a Monitor whose threshold is breached, and
 *  this is the service reporting on itself. Not Quarantine either — nothing is disabled, because
 *  a provider that cannot answer says nothing about whether a rule is evaluable (ADR 0015).
 *
 *  And it does not speak over `degraded.ts`. Two notices about one provider being unavailable is
 *  noise, and noise is what teaches somebody to stop reading the channel the alarms arrive on.
 */

export interface FlappingState {
  /** when each recent sweep failed. The caller keeps this bounded; anything outside the window
   *  is ignored here rather than trusted to have been pruned. */
  failures: Date[];
  /** when the owner was last told the provider is unreliable; null if never */
  lastNoticeAt: Date | null;
  /** whether `degraded.ts` has already announced a sustained outage. Its notice covers the same
   *  provider, so this one stays quiet underneath it. */
  announced: boolean;
}

export interface FlappingPolicy {
  /** how far back to look */
  windowSeconds: number;
  /** how many failures inside that window before the owner hears about it; 0 off */
  afterFailures: number;
  /** the least time from the last notice to the next, whether or not it stopped flapping in
   *  between; 0 never sends another. This said "re-reminds while it is still flapping; 0 off",
   *  true of the reminder but not of "still": a later bout is held to the same interval, and
   *  with 0 never announced, unless the caller clears `lastNoticeAt` — which the sweep does not */
  repeatSeconds: number;
}

export const flappingPolicy = (
  s: { flappingWindowSeconds: number; flappingAfterFailures: number; flappingRepeatSeconds: number },
): FlappingPolicy => ({
  windowSeconds: s.flappingWindowSeconds,
  afterFailures: s.flappingAfterFailures,
  repeatSeconds: s.flappingRepeatSeconds,
});

export interface FlappingVerdict {
  /** what to send, or null for nothing. Non-null is also exactly when the stamp moves. */
  notice: string | null;
}

const SILENT: FlappingVerdict = { notice: null };

/** The window, said the way a person would. */
function spoken(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

function since(when: Date | null, now: Date): number {
  if (when === null) return Number.POSITIVE_INFINITY;
  return (now.getTime() - when.getTime()) / 1000;
}

/** Whether to say the provider is unreliable, and what. */
export function flappingVerdict(
  state: FlappingState, policy: FlappingPolicy, now: Date,
): FlappingVerdict {
  const { afterFailures, windowSeconds, repeatSeconds } = policy;
  if (!afterFailures) return SILENT;

  // a sustained outage is already being reported, in words that fit it better
  if (state.announced) return SILENT;

  // inclusive at the edge: a failure exactly `windowSeconds` old is the oldest one this window is
  // about, and excluding it would make the count depend on the millisecond a sweep landed on
  const inside = state.failures.filter((at) => since(at, now) <= windowSeconds);
  if (inside.length < afterFailures) return SILENT;

  if (state.lastNoticeAt !== null) {
    if (!repeatSeconds || since(state.lastNoticeAt, now) < repeatSeconds) return SILENT;
  }

  return {
    notice: `⚠️ monitoring unreliable: ${inside.length} failed sweeps in the last `
      + `${spoken(windowSeconds)}, with successes in between — a provider that keeps dropping `
      + "and recovering",
  };
}
