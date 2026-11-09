/** The alarm engine's account of its own health: what `/health` reads, and what moves it.
 *
 *  Paired with `routes/health.ts` the way `monitors.ts`, `positions.ts` and `references.ts` are
 *  paired with their routes — the module does the work, the route reports it.
 *
 *  It was nine mutable fields and ten methods on `MonitorSweeper`, interleaved with the sweep
 *  itself, and splitting them out cost nothing because the seam was already drawn: this class
 *  implements `SweeperPort` exactly, which is the interface the HTTP layer had always reached the
 *  engine through (`ports.ts`). The sweep now holds one, calls `success()` or `failure()` at the
 *  end of a sweep, and keeps the database, the quotes and the alarms. Nothing in here opens a
 *  database or sends a quote request; the only IO is a Telegram line.
 *
 *  Everything it remembers is IN MEMORY on purpose, and the reason is the same for every field:
 *  each claim is about a RUN — of failures, of sweeps — and a restart genuinely breaks the run.
 *  Nothing was being swept while the service was down, so a count carried across a restart would
 *  be about a stretch of time the engine did not observe. The cost is that a service restarted
 *  mid-outage reports the failures without the duration, which `degraded.ts` prints as nothing
 *  rather than as a guess, and that a deploy gives a recovering provider its full count again —
 *  the conservative direction in both cases.
 *
 *  WHETHER a run of failures is worth a message is `domain/degraded.ts` and `domain/flapping.ts`,
 *  not this file: the two measure different things (how LONG a failure lasted, and how OFTEN one
 *  happens) and only one of them may speak per sweep, because two notices about one unavailable
 *  provider is the noise that teaches somebody to stop reading the channel.
 */
import { degradedPolicy, degradedVerdict, recoveredNotice } from "optionality/domain/degraded";
import { flappingPolicy, flappingVerdict } from "optionality/domain/flapping";
import type { Settings } from "../env.ts";
import type { Notifier } from "../notify.ts";
import type { SweeperPort } from "../ports.ts";

/** How many sweep intervals may pass with nothing starting before the engine calls itself stalled.
 *
 *  One sweep can legitimately overrun a tick — a batch takes real time. Four in a row is not an
 *  overrun, it is a sweep that is not coming back, and /health must stop calling that "active".
 *  scheduler.ts's watchdog abandons at the same age, so the engine says stalled and then recovers
 *  itself rather than waiting for a restart.
 */
export const STALE_AFTER_SWEEPS = 4;

export interface SweepHealthDeps {
  settings: Settings;
  notify: Notifier;
  now: () => Date;
}

export class SweepHealth implements SweeperPort {
  consecutiveFailuresCount = 0;
  /** When the current run of failures began, and when the owner was last told about it. */
  degradedSince: Date | null = null;
  lastDegradedNoticeAt: Date | null = null;
  /** When each recent sweep failed, for the RATE rather than the run.
   *
   *  A consecutive count measures how LONG a failure lasted and cannot see a provider that keeps
   *  dropping and recovering — which went unnoticed for an hour on 2026-11-08. Pruned to the
   *  window on every append, so this cannot grow: at a 15s sweep and a 15m window it holds at
   *  most 60 entries.
   */
  readonly recentFailures: Date[] = [];
  lastFlappingNoticeAt: Date | null = null;
  /** Stamped at the START of a sweep — one instant per sweep, which is what makes `staleFor` able
   *  to see a sweep that began and never ended. Nothing else notices that. */
  sweepAt: Date | null = null;
  /** null until the first sweep: "starting" is a different thing from "working" */
  sweepOk: boolean | null = null;
  fetchAt: Date | null = null;
  /** What the last batch actually did: null before any was asked for. A port probe cannot answer
   *  this — OpenD can hold the socket open and refuse to log in (2026-10-16). */
  fetchOk: boolean | null = null;

  /** Written out rather than a `constructor(private readonly deps: ...)` parameter property.
   *  Node runs this file by ERASING types, and a parameter property is syntax that has to EMIT code —
   *  so it is rejected outright at load time (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX). tsc accepts it and
   *  vitest transforms it, which is how two of these reached main unable to run (see check-api). */
  private readonly deps: SweepHealthDeps;

  constructor(deps: SweepHealthDeps) {
    this.deps = deps;
  }

  // --- what a sweep tells it ---------------------------------------------------------------
  /** A sweep has begun. One instant per sweep, held by the sweep as a local too: every date a
   *  sweep reckons must come from the same instant or a sweep straddling midnight disagrees with
   *  itself. */
  startedSweep(at: Date): void {
    this.sweepAt = at;
  }

  /** A batch came back, or did not. Separate from the sweep's own verdict because they are
   *  different questions: a batch can arrive and the sweep still fail on the work after it. */
  fetched(ok: boolean, at: Date | null = null): void {
    this.fetchOk = ok;
    if (ok && at !== null) this.fetchAt = at;
  }

  // --- the SweeperPort the /health route reads ---------------------------------------------
  lastSweepAt(): Date | null {
    return this.sweepAt;
  }

  lastFetchAt(): Date | null {
    return this.fetchAt;
  }

  lastSweepOk(): boolean {
    if (this.staleFor() !== null) return false;
    return this.sweepOk ?? true;
  }

  /** Whether the last batch came back, for /health to report in place of a port probe. */
  lastFetchOk(): boolean | null {
    return this.fetchOk;
  }

  consecutiveFailures(): number {
    return this.consecutiveFailuresCount;
  }

  /** The human label the status strip shows. Derived here so the engine gives its own account of
   *  its health rather than the client inferring one. */
  alarmState(): { label: string; bad: boolean } {
    // a sweep that never came back outranks whatever the last one that did come back reported
    const stale = this.staleFor();
    if (stale !== null) {
      return { label: `STALLED (no sweep for ${Math.round(stale)}s)`, bad: true };
    }
    if (this.sweepOk === null) return { label: "starting", bad: false };
    if (this.sweepOk) return { label: "active", bad: false };
    const n = this.consecutiveFailuresCount;
    return { label: `STALLED (${n} failed sweep${n === 1 ? "" : "s"})`, bad: true };
  }

  /** How long since a sweep last BEGAN, if that is longer than the engine tolerates. */
  private staleFor(): number | null {
    if (this.sweepAt === null) return null;   // nothing has started: that is "starting", not stalled
    const age = (this.deps.now().getTime() - this.sweepAt.getTime()) / 1000;
    const limit = this.deps.settings.monitorIntervalSeconds * STALE_AFTER_SWEEPS;
    return age > limit ? age : null;
  }

  // --- the record a sweep leaves -----------------------------------------------------------
  /** A sweep the loop gave up waiting for (scheduler.ts's watchdog).
   *
   *  Counted as a failure, because a sweep that never returned told us less than one that failed:
   *  without this the next tick simply starts another and the stall leaves no trace anywhere.
   */
  async recordStall(ageSeconds: number): Promise<void> {
    const age = Math.round(ageSeconds);
    console.error(`monitor sweep abandoned after ${age}s`);
    await this.failure(`a sweep stuck for ${age}s`);
  }

  /** The default names no vendor on purpose: the Provider is whichever one this deployment is
   *  configured with, and this said "OpenD unreachable?" whatever was answering. Same bug ADR
   *  0018 fixed in `verifyContracts`, which was not the only place it had been written. */
  async failure(reason = "the Provider did not answer"): Promise<void> {
    const { settings, notify } = this.deps;
    const now = this.deps.now();
    this.sweepOk = false;
    this.consecutiveFailuresCount += 1;
    this.degradedSince ??= now;

    // the rate, beside the run: pruned here so the list cannot grow
    this.recentFailures.push(now);
    while (this.recentFailures.length > 0
      && (now.getTime() - this.recentFailures[0]!.getTime()) / 1000 > settings.flappingWindowSeconds) {
      this.recentFailures.shift();
    }

    const announced = this.lastDegradedNoticeAt !== null;
    const { notice } = degradedVerdict(
      {
        failures: this.consecutiveFailuresCount,
        since: this.degradedSince,
        lastNoticeAt: this.lastDegradedNoticeAt,
      },
      degradedPolicy(settings), reason, now,
    );
    // the stamp moves only when something was actually said, which is what makes the interval
    // measure silence rather than sweeps
    if (notice !== null) {
      this.lastDegradedNoticeAt = now;
      await notify(notice);
      return;
    }

    // and only where the sustained notice said nothing: two notices about one unavailable
    // provider is noise, and `announced` is read BEFORE the line above so a sweep cannot both
    // announce an outage and call it unreliable
    const flapping = flappingVerdict(
      { failures: this.recentFailures, lastNoticeAt: this.lastFlappingNoticeAt, announced },
      flappingPolicy(settings), now,
    );
    if (flapping.notice !== null) {
      this.lastFlappingNoticeAt = now;
      await notify(flapping.notice);
    }
  }

  async success(): Promise<void> {
    const { settings, notify } = this.deps;
    const notice = recoveredNotice(
      {
        failures: this.consecutiveFailuresCount,
        since: this.degradedSince,
        lastNoticeAt: this.lastDegradedNoticeAt,
      },
      degradedPolicy(settings), this.deps.now(),
    );
    this.consecutiveFailuresCount = 0;
    this.degradedSince = null;
    this.lastDegradedNoticeAt = null;
    this.sweepOk = true;
    // `recentFailures` is NOT cleared, which is the whole point: a success is exactly what a
    // flapping provider produces between failures, and clearing on one would make this blind to
    // the thing it was written for. Entries age out of the window instead.
    // after the counters are cleared: a failed send must not leave the service looking degraded
    if (notice !== null) await notify(notice);
  }
}
