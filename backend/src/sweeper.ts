/** The alarm engine. Ported from monitor.py's MonitorSweeper (ADR 0009, phase 6).
 *
 *  One batched call per sweep for the WHOLE watchlist, and the dashboard makes no call of its own:
 *  it renders the records this kept, so a row's value and its 🔔 always come from the same instant
 *  (CLAUDE.md). The alarm flips truthfully AT the threshold — no value hysteresis; flapping is
 *  throttled by the per-monitor cooldown, and a persisting breach re-reminds on a fixed cadence.
 *
 *  Nothing here is auto-deleted except an expired monitor past its retention window. An unknown
 *  contract is quarantined — disabled with a notice, kept for inspection — and never removed.
 */
import type { DatabaseSync } from "node:sqlite";

import { isBreached, monitorLegCodes, monitorValue } from "./domain/monitor.ts";
import { positionLegCodes } from "./domain/position.ts";
import { atomic } from "./db/open.ts";
import {
  clearMonitorLinks, deleteMonitorRow, enabledMonitors, findMonitor, listMonitors, listPositions,
  positionsForMonitors, updateMonitorFields,
} from "./db/queries.ts";
import type { MonitorRow } from "./db/rows.ts";
import { fromSqlDatetime, toSqlDatetime } from "./db/time.ts";
import { toSqliteBool } from "./db/values.ts";
import type { Settings } from "./env.ts";
import { toMonitor, toPosition } from "./hydrate.ts";
import { displayRecords, fetchResilient, type QuoteFetcher, type QuoteRecord } from "./quotes.ts";
import { displayTime } from "./timefmt.ts";
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

export class MonitorSweeper {
  consecutiveFailuresCount = 0;
  sweepAt: Date | null = null;
  /** null until the first sweep: "starting" is a different thing from "working" */
  sweepOk: boolean | null = null;
  /** the last successful batch, kept so the dashboard renders the same instant the alarm engine
   *  evaluated rather than fetching a second, slightly different one */
  lastRecords: QuoteRecord[] = [];
  lastBadCodes: string[] = [];
  fetchAt: Date | null = null;

  constructor(private readonly deps: SweeperDeps) {}

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

  lastSweepOk(): boolean {
    return this.sweepOk ?? true;
  }

  consecutiveFailures(): number {
    return this.consecutiveFailuresCount;
  }

  /** The human label the status strip shows. Derived here so the engine gives its own account of
   *  its health rather than the client inferring one. */
  alarmState(): { label: string; bad: boolean } {
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
   *  `triggered` is written by the sweep, and showing a fresher quote beside it makes the alarm
   *  engine look wrong when it is not. A monitor created since the last sweep has no record yet and
   *  renders as "—" until the next one. */
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
      }),
      fetched,
    };
  }

  // --- the sweep ---------------------------------------------------------------------------
  private async notify(text: string): Promise<void> {
    const { settings } = this.deps;
    if (!settings.telegramBotToken || !settings.telegramChatId) {
      console.info(`telegram not configured; alarm suppressed: ${text}`);
      return;
    }
    try {
      await this.deps.send(text);
    } catch (err) {
      console.error("telegram send failed:", err);
    }
  }

  async sweep(): Promise<void> {
    const { db } = this.deps;
    this.sweepAt = this.now();
    const today = utcDate(this.sweepAt);

    const active = await this.runExpiryLifecycle(today);

    // positions join the batch even when nothing alarms on them: the dashboard values them from
    // this same fetch, and a held position must not read as "—" merely because you happen not to be
    // watching it. This widens the batch only — the alarm loop below still runs over `active`.
    const positionCodes = listPositions(db).flatMap((p) => positionLegCodes(toPosition(p)));
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
    } catch (err) {
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
            updateMonitorFields(db, monitor.id, {
              enabled: toSqliteBool(false), disabled_reason: "expired",
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

  /** Disable — never delete — monitors whose contracts moomoo does not recognise. */
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
        updateMonitorFields(db, monitor.id, {
          enabled: toSqliteBool(false), disabled_reason: "unknown-contract",
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

  /** The alarm loop. */
  private async evaluate(
    monitors: MonitorRow[], byCode: Record<string, QuoteRecord>,
  ): Promise<void> {
    const { db, settings } = this.deps;
    const now = this.now();
    const stamp = toSqlDatetime(now);
    const notices: string[] = [];

    await atomic(db, () => {
      for (const row of monitors) {
        const monitor = toMonitor(row);
        const value = monitorValue(monitor, byCode);
        if (value === null) {
          console.warn(`no complete ${monitor.field} for ${monitor.code} in snapshot`);
          continue;
        }
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

  private async recordFailure(): Promise<void> {
    this.sweepOk = false;
    this.consecutiveFailuresCount += 1;
    // edge-triggered: once, at the threshold, not once per failure
    if (this.consecutiveFailuresCount === this.deps.settings.degradedAfterFailures) {
      await this.notify(
        `⚠️ monitoring degraded: ${this.consecutiveFailuresCount} consecutive sweep failures `
        + "(OpenD unreachable?)",
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
