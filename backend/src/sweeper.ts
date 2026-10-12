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

import { daysToExpiry, marketDate } from "./domain/expiry.ts";
import { isBreached, monitorLegCodes, monitorValue } from "./domain/monitor.ts";
import { dteAtOpen, exitPolicy, onPace } from "./domain/exit.ts";
import { costToClose, positionLegCodes } from "./domain/position.ts";
import { atomic } from "./db/open.ts";
import {
  clearMonitorLinks, deleteMonitorRow, enabledMonitors, findMonitor, listMonitors, listPositions,
  findPositionSample, positionsForMonitors, recordPositionSample, stampManageNotified,
  updateMonitorFields,
} from "./db/queries.ts";
import type { MonitorRow, PositionRow } from "./db/rows.ts";
import { fromSqlDatetime, toSqlDatetime } from "./db/time.ts";
import { toSqliteBool, toSqliteJson } from "./db/values.ts";
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
    // held as a local as well as on the instance: a sweep takes real time, and every date the
    // sweep reckons — expiry, and the samples' market day — must come from ONE instant or a
    // sweep straddling midnight disagrees with itself
    const at = this.now();
    this.sweepAt = at;
    const today = utcDate(at);

    const active = await this.runExpiryLifecycle(today);

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
    this.recordSamples(positionRows, byCode, at);
    await this.noticeManageBy(positionRows, byCode, at);
  }

  /** One notice per Position when it reaches the manage-by DTE (ADR 0011).
   *
   *  A notice about a POSITION, not an Alarm about a Monitor: no threshold is involved, the
   *  cooldowns do not apply, and `manage_notified_at` is what makes it once rather than once a
   *  minute. Pace deliberately does not notify — being behind fires on every IV spike.
   *
   *  `opened_at` is the gate, and that is the whole reason it is: three of the five Positions in
   *  the live book were already inside 21 DTE when this shipped, so without it the first sweep
   *  after the deploy would have fired three retroactive notices and looked like a fault.
   */
  private async noticeManageBy(
    rows: PositionRow[], byCode: Record<string, QuoteRecord>, at: Date,
  ): Promise<void> {
    const { settings } = this.deps;
    for (const row of rows) {
      try {
        if (row.opened_at === null || row.manage_notified_at !== null) continue;
        const dte = daysToExpiry(row.strike_date, at);
        if (dte < 0 || dte > settings.exitManageByDte) continue;

        const cost = costToClose(toPosition(row), byCode);
        const pace = onPace(row.entry, dteAtOpen(row.strike_date, row.opened_at), dte);

        let line = `⏰ ${row.name} is at ${dte} DTE — manage by ${settings.exitManageByDte}`;
        if (row.entry !== null) line += `\nentry ${row.entry}`;
        if (cost !== null) line += ` · now ${cost.toFixed(2)}`;
        if (pace !== null) {
          const gap = cost === null ? null : cost - pace;
          line += `\non-pace ${pace.toFixed(2)}`;
          if (gap !== null) {
            line += ` — ${gap > 0 ? "behind" : "ahead"} by ${Math.abs(gap).toFixed(2)}`;
          }
        }
        // stamped BEFORE the send, and only when the send does not throw: the order below means
        // a failed send is retried next sweep rather than swallowed, while a successful one is
        // never repeated
        await this.notify(line);
        stampManageNotified(this.deps.db, row.id, toSqlDatetime(at));
      } catch (err) {
        console.error(`manage-by notice for ${row.name} failed:`, err);
      }
    }
  }

  /** One observation per Position per market day, so the decay shape can be checked against this
   *  book rather than defended on arithmetic (ADR 0011). Nothing reads these yet.
   *
   *  Guarded per Position, like the telegram send is: the sweep exists to raise alarms, and a
   *  sample is a nice-to-have that must never be the reason a breach went unmessaged.
   *
   *  The day is the MARKET day, matching the `dte` stored beside it and the dashboard's column.
   *  Deliberately not `utcDate` above — that is the expiry reckoning, and the two differ for the
   *  hours New York is behind UTC, which would pair a New York Wednesday with Thursday's DTE. */
  private recordSamples(
    rows: PositionRow[], byCode: Record<string, QuoteRecord>, at: Date,
  ): void {
    const observedOn = marketDate(at);
    for (const row of rows) {
      try {
        const dte = daysToExpiry(row.strike_date, at);
        if (dte < 0) continue;
        const position = toPosition(row);
        // unknown, not zero: one unpriced leg and there is no observation to make
        const cost = costToClose(position, byCode);
        if (cost === null) continue;

        // Per LEG, because a structure has no IV — "IV is never summed" (CLAUDE.md), and these
        // legs run 10.5% to 22.1%, so one number for them would be a fiction. Null rather than a
        // partial map: a vol adjustment needs every leg, and half a structure's vol invites an
        // answer computed from half a structure.
        const ivs: Record<string, number> = {};
        let everyLegPriced = true;
        for (const code of positionLegCodes(position)) {
          const iv = byCode[code]?.option_implied_volatility;
          if (iv === null || iv === undefined) { everyLegPriced = false; break; }
          ivs[code] = Number(iv);
        }
        const legsIv = everyLegPriced ? toSqliteJson(ivs) : null;

        // Only when something actually differs. The sweep runs every 15 seconds and the day's row
        // is meant to settle on the close, not to be rewritten 5,760 times — overnight and at
        // weekends nearly every one of those writes stored what was already there, and the IV map
        // triples what each one carries.
        const stored = findPositionSample(this.deps.db, row.id, observedOn);
        if (stored && stored.dte === dte && stored.cost_to_close === cost
          && stored.legs_iv === legsIv) continue;

        recordPositionSample(this.deps.db, {
          position_id: row.id, observed_on: observedOn, dte, cost_to_close: cost,
          legs_iv: legsIv,
        });
      } catch (err) {
        console.error(`recording a sample for ${row.name} failed:`, err);
      }
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
