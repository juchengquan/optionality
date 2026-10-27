/** The alarm engine. Ported from monitor.py's MonitorSweeper (ADR 0009, phase 6).
 *
 *  One batched call per sweep for the WHOLE watchlist. The dashboard does NOT render those records:
 *  it polls `/quotes` for a live batch of its own, one per poll per open tab (ADR 0010). A row's
 *  value and its 🔔 still come from the same instant — `buildEntries` reads the watched figure once
 *  and derives both the fill bar and the bell from it with `isBreached`, this engine's own
 *  predicate — but that instant is the poll's, not the sweep's, so the dashboard's bell may lead or
 *  lag what has been sent. `cachedRecords` (and `cachedQuotes`, built on it) still hold the sweep's
 *  own view of its last batch; NO ROUTE CALLS EITHER, and the comments there say why they are kept.
 *
 *  The alarm flips truthfully AT the threshold — no value hysteresis; flapping is throttled by the
 *  per-monitor cooldown, and a persisting breach re-reminds on a fixed cadence.
 *
 *  Nothing here is auto-deleted except an expired monitor past its retention window. A rule the
 *  engine cannot evaluate is quarantined — disabled with a notice, kept for inspection — and never
 *  removed. There are two such faults, and they are symmetrical: a contract the Provider does not
 *  recognise, and a figure that never arrives for one it does. The second used to be a log line
 *  and a `continue`, which is the quietest failure this service had: an alarm that cannot fire
 *  reads exactly like one that is not breached (#167).
 */
import type { DatabaseSync } from "node:sqlite";

import { noticeManageBy, recordSamples } from "./positions.ts";
import { isBreached, monitorLegCodes, monitorValue } from "./domain/monitor.ts";
import type { Monitor } from "./domain/monitor.ts";
import { exitPolicy } from "./domain/exit.ts";
import { positionLegCodes } from "./domain/position.ts";
import { atomic } from "./db/open.ts";
import {
  clearMonitorLinks, deleteMonitorRow, enabledMonitors, findMonitor, listMonitors, listPositions,
  positionsForMonitors, updateMonitorFields,
} from "./db/queries.ts";
import type { MonitorRow } from "./db/rows.ts";
import { fromSqlDatetime, toSqlDatetime } from "./db/time.ts";
import { toSqliteBool, } from "./db/values.ts";
import type { Settings } from "./env.ts";
import type { DisabledReason } from "./schemas/monitor.ts";
import { toMonitor, toPosition } from "./hydrate.ts";
import { displayRecords, fetchResilient, type QuoteFetcher, type QuoteRecord } from "./quotes.ts";
import { displayTime } from "./domain/timefmt.ts";
import { buildEntries, type WatchlistEntry } from "./watchlist.ts";
import { forEntry } from "./monitors.ts";

/** Sending a message to the owner's phone. The real Telegram client arrives in phase 7. */
export type NotifySender = (text: string) => Promise<void> | void;

export interface SweeperDeps {
  db: DatabaseSync;
  settings: Settings;
  fetchQuotes: QuoteFetcher;
  send: NotifySender;
  now?: () => Date;
}

/** How many sweep intervals may pass with nothing starting before the engine calls itself stalled.
 *
 *  One sweep can legitimately overrun a tick — a batch takes real time. Four in a row is not an
 *  overrun, it is a sweep that is not coming back, and /health must stop calling that "active".
 *  scheduler.ts's watchdog abandons at the same age, so the engine says stalled and then recovers
 *  itself rather than waiting for a restart.
 */
export const STALE_AFTER_SWEEPS = 4;

/** The date a sweep reckons expiry against: the UTC day, as the Python's `utcnow().date()` gives.
 *
 *  Deliberately NOT the market date, even though `dte` on the dashboard is. The two genuinely differ
 *  for the hours when New York is a day behind UTC, so a contract can read `dte: 0` while the sweep
 *  already calls it expired. Carried across unchanged: changing it would mute a monitor on a
 *  different day from the one the Python would have, and that is a decision, not a port. */
function utcDate(when: Date): string {
  return when.toISOString().slice(0, 10);
}

function addDays(isoDate: string, days: number): string {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Why a rule's figure did not arrive, in the words the notice needs.
 *
 *  `monitorValue` answers null for two different faults and the notice is the only place the
 *  difference shows: a leg that was never priced is the Provider missing a CONTRACT, while a
 *  priced leg without the figure is the Provider not serving that FIELD — which is what an
 *  entitlement looks like. Blaming the field for an unpriced leg would send the owner to the wrong
 *  question.
 */
function silence(monitor: Monitor, byCode: Record<string, QuoteRecord>): string {
  const unpriced = monitorLegCodes(monitor).filter((code) => byCode[code] === undefined);
  if (unpriced.length > 0) return `no quote for ${unpriced.sort().join(", ")}`;
  return `no ${monitor.field} in the quote`;
}

export class MonitorSweeper {
  consecutiveFailuresCount = 0;
  /** Consecutive sweeps a monitor's figure has failed to arrive for, by monitor id.
   *
   *  In memory, like `consecutiveFailuresCount` and for the same reason: the claim is about a RUN
   *  of sweeps, and a restart genuinely breaks the run — nothing was being swept while the service
   *  was down, so a count carried across it would be about a stretch of time the engine did not
   *  observe. The cost is that a deploy gives a silent rule its N sweeps again, which is the
   *  conservative direction.
   */
  readonly silentSweeps = new Map<string, number>();
  sweepAt: Date | null = null;
  /** null until the first sweep: "starting" is a different thing from "working" */
  sweepOk: boolean | null = null;
  /** the last successful batch, kept so the dashboard renders the same instant the alarm engine
   *  evaluated rather than fetching a second, slightly different one */
  lastRecords: QuoteRecord[] = [];
  lastBadCodes: string[] = [];
  fetchAt: Date | null = null;
  /** What the last batch actually did: null before any was asked for. A port probe cannot answer
   *  this — OpenD can hold the socket open and refuse to log in (2026-10-16). */
  fetchOk: boolean | null = null;

  /** Written out rather than a `constructor(private readonly deps: ...)` parameter property.
   *  Node runs this file by ERASING types, and a parameter property is syntax that has to EMIT code —
   *  so it is rejected outright at load time (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX). tsc accepts it and
   *  vitest transforms it, which is how two of these reached main unable to run (see check-api). */
  private readonly deps: SweeperDeps;

  constructor(deps: SweeperDeps) {
    this.deps = deps;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  // --- the SweeperPort the /health route reads ---------------------------------------------
  lastSweepAt(): Date | null {
    return this.sweepAt;
  }

  lastFetchAt(): Date | null {
    return this.fetchAt;
  }

  /** How long since a sweep last BEGAN, if that is longer than the engine tolerates.
   *
   *  `sweepAt` is stamped at the start of a sweep on purpose — one instant per sweep — which makes
   *  it a start time, not a completion. Nothing else notices a sweep that began and never ended.
   */
  private staleFor(): number | null {
    if (this.sweepAt === null) return null;   // nothing has started: that is "starting", not stalled
    const age = (this.now().getTime() - this.sweepAt.getTime()) / 1000;
    const limit = this.deps.settings.monitorIntervalSeconds * STALE_AFTER_SWEEPS;
    return age > limit ? age : null;
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

  /** The last sweep's quotes indexed by code, display-stamped.
   *
   *  Positions read from here too, so everything on the dashboard — a monitor's value, a position's
   *  cost to close — comes from one instant. */
  cachedRecords(): { byCode: Record<string, QuoteRecord>; fetched: string | null } {
    if (this.fetchAt === null) return { byCode: {}, fetched: null };
    return {
      byCode: displayRecords(this.lastRecords, this.deps.settings.displayTz, this.fetchAt),
      fetched: displayTime(this.fetchAt, this.deps.settings.displayTz),
    };
  }

  /** Watchlist entries built from the LAST SWEEP's records — no OpenD call.
   *
   *  NO ROUTE CALLS THIS. It was built as the dashboard's path and the dashboard was wired to the
   *  live `/quotes` instead, which is the reading ADR 0010 ratified — so this is the sweep's own
   *  view of its last batch, kept because the sweep's state is observable through nothing else and
   *  because it is the alternative if that decision is ever revisited. Six tests exercised it
   *  while asserting the invariant the shipped dashboard was breaking.
   *
   *  A monitor created since the last sweep has no record here and renders as "—" until the next
   *  one. */
  cachedQuotes(includeCombos = true): { entries: WatchlistEntry[]; fetched: string | null } {
    const { db } = this.deps;
    const monitors = enabledMonitors(db, includeCombos).map(forEntry);
    const { byCode, fetched } = this.cachedRecords();
    const ownedRows = positionsForMonitors(db, monitors.map((m) => m.id));
    const owned = Object.fromEntries(
      Object.entries(ownedRows).map(([id, ps]) => [id, ps.map(toPosition)]),
    );
    return {
      entries: buildEntries({
        monitors, byCode, bad: new Set(this.lastBadCodes), owned, now: this.now(),
        policy: exitPolicy(this.deps.settings),
      }),
      fetched,
    };
  }

  // --- the sweep ---------------------------------------------------------------------------
  /** Send, and say whether it got through.
   *
   *  A failed send must never stop a sweep — its job is the alarm — so this swallows the error.
   *  That makes "did it throw" useless to a caller, and the manage-by notice needs the answer: it
   *  is raised ONCE, so a stamp written after an undelivered notice loses it for ever. Hence a
   *  return value rather than a rethrow. Telegram not being configured counts as delivered: there
   *  is nothing to retry, and retrying every sweep would log the same line for ever.
   */
  private async notify(text: string): Promise<boolean> {
    const { settings } = this.deps;
    if (!settings.telegramBotToken || !settings.telegramChatId) {
      console.info(`telegram not configured; alarm suppressed: ${text}`);
      return true;
    }
    try {
      await this.deps.send(text);
      return true;
    } catch (err) {
      console.error("telegram send failed:", err);
      return false;
    }
  }

  async sweep(): Promise<void> {
    const { db } = this.deps;
    // held as a local as well as on the instance: a sweep takes real time, and every date the
    // sweep reckons — expiry, and the samples' market day — must come from ONE instant or a
    // sweep straddling midnight disagrees with itself
    const at = this.now();
    this.sweepAt = at;
    const today = utcDate(at);

    const active = await this.runExpiryLifecycle(today);
    this.forgetSilenceBut(active);

    // positions join the batch even when nothing alarms on them: the dashboard values them from
    // this same fetch, and a held position must not read as "—" merely because you happen not to be
    // watching it. This widens the batch only — the alarm loop below still runs over `active`.
    // the rows, not only their codes: the same list is what the samples below are written from,
    // so a Position cannot be in the batch and missing from the record
    const positionRows = listPositions(db);
    const positionCodes = positionRows.flatMap((p) => positionLegCodes(toPosition(p)));
    const codes = [...new Set([
      ...active.flatMap((m) => monitorLegCodes(toMonitor(m))),
      ...positionCodes,
    ])].sort();
    if (codes.length === 0) {
      await this.recordSuccess();
      return;
    }

    let records: QuoteRecord[];
    let badCodes: string[];
    try {
      ({ records, bad: badCodes } = await fetchResilient(codes, this.deps.fetchQuotes));
      this.fetchOk = true;
    } catch (err) {
      this.fetchOk = false;
      console.error("monitor sweep snapshot failed:", err);
      await this.recordFailure();
      return;
    }
    await this.recordSuccess();
    this.lastRecords = records;
    this.lastBadCodes = badCodes;
    this.fetchAt = this.now();

    let surviving = active;
    if (badCodes.length > 0) surviving = await this.quarantineUnknown(active, new Set(badCodes));

    const byCode: Record<string, QuoteRecord> = Object.fromEntries(
      records.map((r) => [String(r.code), r]),
    );
    await this.evaluate(surviving, byCode);
    // Both are about POSITIONS, not about alarms. They live here only because this is where the
    // batch is, so they take it as an argument instead (positions.ts).
    recordSamples(db, positionRows, byCode, at);
    await noticeManageBy(
      { db, settings: this.deps.settings, notify: (text) => this.notify(text) },
      positionRows, byCode, at,
    );
  }

  /** Drop the silence counts of rules this sweep is not evaluating.
   *
   *  Left behind, the map grows for ever and a rule unmuted weeks later resumes mid-count. Called
   *  from `sweep` rather than from the alarm loop because a sweep with nothing to fetch returns
   *  before the loop — and that is precisely the sweep after the last rule was deleted.
   */
  private forgetSilenceBut(active: MonitorRow[]): void {
    const sweeping = new Set(active.map((m) => m.id));
    for (const id of [...this.silentSweeps.keys()]) {
      if (!sweeping.has(id)) this.silentSweeps.delete(id);
    }
  }

  /** Mute with a notice on expiry; delete quietly after the grace period.
   *
   *  Nothing else is ever auto-deleted, and an unknown-contract quarantine is kept for inspection
   *  rather than removed (CLAUDE.md). */
  private async runExpiryLifecycle(today: string): Promise<MonitorRow[]> {
    const { db, settings } = this.deps;
    const retention = settings.expiredRetentionDays;
    const cutoff = addDays(today, -retention);
    const active: MonitorRow[] = [];
    const notices: string[] = [];

    await atomic(db, () => {
      for (const monitor of listMonitors(db)) {
        if (monitor.strike_date < cutoff) {
          // retention=0 path: it never got the muted notice, so say something now
          if (monitor.enabled) {
            notices.push(`ℹ️ monitor ${monitor.code} expired (${monitor.strike_date}) — removed`);
          }
          // the links go FIRST. monitor_positions is not managed for us, and deleting a linked
          // monitor raises FOREIGN KEY constraint failed — inside the sweep, every minute, so the
          // alarm engine stops altogether. The Python had this fault until it was found by writing
          // this port (#81). The Position stays: it is a holding.
          clearMonitorLinks(db, monitor.id);
          deleteMonitorRow(db, monitor.id);
        } else if (monitor.strike_date < today) {
          if (monitor.enabled) {
            const reason: DisabledReason = "expired";
            updateMonitorFields(db, monitor.id, {
              enabled: toSqliteBool(false), disabled_reason: reason,
            });
            notices.push(
              `ℹ️ monitor ${monitor.code} expired (${monitor.strike_date}) — muted; `
              + `auto-removes in ${retention} days`,
            );
          }
        } else if (monitor.enabled) {
          active.push(monitor);
        }
      }
    });
    // after the writes have committed, so a failed send cannot roll back a mute
    for (const text of notices) await this.notify(text);
    return active;
  }

  /** Disable — never delete — monitors whose contracts the Provider does not recognise. Its twin
   *  is the silence count in `evaluate`: the same answer to the other half of "cannot evaluate". */
  private async quarantineUnknown(
    active: MonitorRow[], bad: Set<string>,
  ): Promise<MonitorRow[]> {
    const { db } = this.deps;
    const surviving: MonitorRow[] = [];
    const notices: string[] = [];
    await atomic(db, () => {
      for (const monitor of active) {
        const hits = monitorLegCodes(toMonitor(monitor)).filter((c) => bad.has(c)).sort();
        if (hits.length === 0) {
          surviving.push(monitor);
          continue;
        }
        const reason: DisabledReason = "unknown-contract";
        updateMonitorFields(db, monitor.id, {
          enabled: toSqliteBool(false), disabled_reason: reason,
        });
        notices.push(
          `⚠️ monitor ${monitor.code} disabled: unknown contract ${hits.join(", ")} `
          + "(delisted or never existed)",
        );
      }
    });
    for (const text of notices) await this.notify(text);
    return surviving;
  }

  /** The alarm loop — and, for a rule with no figure to evaluate, the count toward quarantine.
   *
   *  The count lives here rather than beside `quarantineUnknown` because this is the only place
   *  that knows a figure did not arrive: the fetch succeeded, the contract was priced, and
   *  `monitorValue` still answered null.
   */
  private async evaluate(
    monitors: MonitorRow[], byCode: Record<string, QuoteRecord>,
  ): Promise<void> {
    const { db, settings } = this.deps;
    const now = this.now();
    const stamp = toSqlDatetime(now);
    const notices: string[] = [];
    const limit = settings.quarantineAfterSilentSweeps;

    await atomic(db, () => {
      for (const row of monitors) {
        const monitor = toMonitor(row);
        const value = monitorValue(monitor, byCode);
        if (value === null) {
          const n = (this.silentSweeps.get(row.id) ?? 0) + 1;
          this.silentSweeps.set(row.id, n);
          const why = silence(monitor, byCode);
          if (limit > 0 && n >= limit) {
            const reason: DisabledReason = "no-figure";
            updateMonitorFields(db, row.id, {
              enabled: toSqliteBool(false), disabled_reason: reason,
            });
            // forgotten, not kept at the limit: unmuting the rule gives it its full count again
            this.silentSweeps.delete(row.id);
            notices.push(
              `⚠️ monitor ${monitor.code} disabled: ${why} for ${n} consecutive sweeps`,
            );
          } else {
            console.warn(`${why} for ${monitor.code} (${n}${limit > 0 ? `/${limit}` : ""})`);
          }
          continue;
        }
        // it arrived: the run of silence is over, and a run is what the limit counts
        this.silentSweeps.delete(row.id);
        // re-read: the fetch was awaited, and a request may have changed the row in the meantime.
        // The Python re-reads for the same reason, across its session boundary.
        const current = findMonitor(db, row.id);
        if (!current) continue;

        const changes: Partial<MonitorRow> = { last_value: value, last_checked_at: stamp };
        const name = (byCode[monitor.code]?.name as string | undefined) || monitor.code;
        const above = monitor.direction !== "below";
        const breached = isBreached(value, monitor.threshold, monitor.direction, monitor.compare);
        const [breachWord, recoverWord] = above
          ? ["crossed ≥", "back below"]
          : ["fell ≤", "back above"];
        const wasTriggered = current.triggered !== 0;
        const figure = value.toFixed(3);

        if (breached && !wasTriggered) {
          changes.triggered = toSqliteBool(true);
          if (this.alarmAllowed(current, now)) {
            changes.last_alarm_at = stamp;
            notices.push(`⚠️ ${name}: ${monitor.field} ${figure} ${breachWord} ${monitor.threshold}`);
          }
        } else if (wasTriggered && !breached) {
          changes.triggered = toSqliteBool(false);
          if (this.alarmAllowed(current, now)) {
            changes.last_alarm_at = stamp;
            notices.push(`✅ ${name}: ${monitor.field} ${figure} ${recoverWord} ${monitor.threshold}`);
          }
        } else if (wasTriggered && breached) {
          // a persisting breach re-alarms on a fixed cadence so it cannot be missed once and
          // forgotten. 0 disables reminders entirely.
          const repeat = settings.alarmRepeatSeconds;
          const sign = breachWord.split(" ").at(-1);
          if (repeat && this.secondsSinceAlarm(current, now) >= repeat) {
            changes.last_alarm_at = stamp;
            notices.push(
              `⚠️ ${name}: ${monitor.field} ${figure} still ${sign} ${monitor.threshold} (reminder)`,
            );
          }
        }
        updateMonitorFields(db, row.id, changes);
      }
    });
    for (const text of notices) await this.notify(text);
  }

  private secondsSinceAlarm(monitor: MonitorRow, now: Date): number {
    if (monitor.last_alarm_at === null) return Number.POSITIVE_INFINITY;
    return (now.getTime() - fromSqlDatetime(monitor.last_alarm_at).getTime()) / 1000;
  }

  private alarmAllowed(monitor: MonitorRow, now: Date): boolean {
    return this.secondsSinceAlarm(monitor, now) >= this.deps.settings.alarmCooldownSeconds;
  }

  /** A sweep the loop gave up waiting for (scheduler.ts's watchdog).
   *
   *  Counted as a failure, because a sweep that never returned told us less than one that failed:
   *  without this the next tick simply starts another and the stall leaves no trace anywhere.
   */
  async recordStall(ageSeconds: number): Promise<void> {
    const age = Math.round(ageSeconds);
    console.error(`monitor sweep abandoned after ${age}s`);
    await this.recordFailure(`a sweep stuck for ${age}s`);
  }

  private async recordFailure(reason = "OpenD unreachable?"): Promise<void> {
    this.sweepOk = false;
    this.consecutiveFailuresCount += 1;
    // edge-triggered: once, at the threshold, not once per failure
    if (this.consecutiveFailuresCount === this.deps.settings.degradedAfterFailures) {
      await this.notify(
        `⚠️ monitoring degraded: ${this.consecutiveFailuresCount} consecutive sweep failures `
        + `(${reason})`,
      );
    }
  }

  private async recordSuccess(): Promise<void> {
    if (this.consecutiveFailuresCount >= this.deps.settings.degradedAfterFailures) {
      await this.notify("✅ monitoring recovered");
    }
    this.consecutiveFailuresCount = 0;
    this.sweepOk = true;
  }
}
