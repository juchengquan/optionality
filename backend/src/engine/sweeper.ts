/** The alarm engine. Ported from monitor.py's MonitorSweeper (ADR 0009, phase 6).
 *
 *  One batched call per sweep for the WHOLE watchlist. The dashboard does NOT render those records:
 *  it polls `/quotes` for a live batch of its own, one per poll per open tab (ADR 0010). A row's
 *  value and its 🔔 still come from the same instant — `buildEntries` reads the watched figure once
 *  and derives both the fill bar and the bell from it with `isBreached`, this engine's own
 *  predicate — but that instant is the poll's, not the sweep's, so the dashboard's bell may lead or
 *  lag what has been sent. This engine therefore keeps NO cached view of its last batch: a
 *  `cachedRecords`/`cachedQuotes` pair was built as the dashboard's path, the dashboard was wired
 *  to the live `/quotes` instead, and after three weeks of no route calling either they were
 *  deleted — which is what dropped `watchlist.ts`, `monitors.ts`, `domain/exit.ts` and
 *  `domain/timefmt.ts` out of the alarm engine's imports altogether.
 *
 *  WHETHER a reading alarms is `alarm.ts` and not this file: the threshold rule, the cooldown that
 *  throttles flapping and the cadence a persisting breach re-reminds on are one decision, and it
 *  takes a reading and two knobs rather than a database. What is left here is the engine — getting
 *  the quotes, deciding which rules are evaluable at all, writing the rows and sending the words.
 *  Two more things left with it: how healthy the engine says it is, which is `health.ts` and the
 *  whole of the `SweeperPort` the HTTP layer reads, and the Telegram send itself, which is
 *  `notify.ts` because the sweep, the health account and `positions.ts` all need the same answer
 *  about a message that did not get through.
 *
 *  Nothing here is auto-deleted except an expired monitor past its retention window. A rule the
 *  engine cannot evaluate is quarantined — disabled with a notice, kept for inspection — and never
 *  removed. There are THREE such faults, and the decision in each is `domain/lifecycle.ts`'s so a
 *  notebook can ask what the next sweep would do without a sweep running (ADR 0017): a contract
 *  the Provider does not recognise (`unknownContractVerdict`), a figure that never arrives for one
 *  it does (`silenceVerdict`), and a row this service cannot hydrate at all (`unreadableNotice`).
 *  The first two are symmetrical in their answer and differ only in how long it takes to be sure.
 *  The second used to be a log line and a `continue`, which is the quietest failure this service
 *  had: an alarm that cannot fire reads exactly like one that is not breached (#167).
 */
import type { DatabaseSync } from "node:sqlite";

import { SweepHealth } from "./health.ts";
import { type NotifySender, type Notifier, notifier } from "../notify.ts";
import { noticeManageBy, recordSamples } from "./positions.ts";
import { alarmPolicy, alarmTransition } from "optionality/domain/alarm";
import {
  expiryVerdict, silenceVerdict, unknownContractVerdict, unreadableNotice,
} from "optionality/domain/lifecycle";
import { monitorLegCodes, monitorValue } from "optionality/domain/monitor";
import { positionLegCodes } from "optionality/domain/position";
import { atomic } from "../db/open.ts";
import {
  clearMonitorLinks, deleteMonitorRow, findMonitor, listMonitors, openPositions,
  updateMonitorFields,
} from "../db/queries/index.ts";
import type { MonitorRow, PositionRow } from "../db/rows.ts";
import { fromSqlDatetime, toSqlDatetime } from "../db/time.ts";
import { toSqliteBool, } from "../db/values.ts";
import type { Settings } from "../env.ts";
import type { DisabledReason } from "../schemas/monitor.ts";
import { toMonitor, toPosition } from "../hydrate.ts";
import type { QuoteFetcher, QuoteRecord } from "optionality/quotes";

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

function lastAlarmAt(monitor: MonitorRow): Date | null {
  return monitor.last_alarm_at === null ? null : fromSqlDatetime(monitor.last_alarm_at);
}

export class MonitorSweeper {
  /** Consecutive sweeps a monitor's figure has failed to arrive for, by monitor id.
   *
   *  In memory, like everything `health.ts` remembers and for its reason: the claim is about a RUN
   *  of sweeps, and a restart genuinely breaks the run — nothing was being swept while the service
   *  was down, so a count carried across it would be about a stretch of time the engine did not
   *  observe. The cost is that a deploy gives a silent rule its N sweeps again, which is the
   *  conservative direction.
   */
  readonly silentSweeps = new Map<string, number>();
  /** The engine's account of itself, and the `SweeperPort` the HTTP layer reads (health.ts). It
   *  is the sweep's own, rather than a dependency, because nothing else may write to it: a sweep
   *  is the only thing that knows whether a sweep succeeded. */
  readonly health: SweepHealth;

  /** Written out rather than a `constructor(private readonly deps: ...)` parameter property.
   *  Node runs this file by ERASING types, and a parameter property is syntax that has to EMIT code —
   *  so it is rejected outright at load time (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX). tsc accepts it and
   *  vitest transforms it, which is how two of these reached main unable to run (see check-api). */
  private readonly deps: SweeperDeps;
  /** Telling the owner, shared with `health.ts` and `positions.ts` so one answer about a failed
   *  send serves all three (notify.ts). */
  private readonly notify: Notifier;

  constructor(deps: SweeperDeps) {
    this.deps = deps;
    this.notify = notifier(deps.settings, deps.send);
    this.health = new SweepHealth({
      settings: deps.settings, notify: this.notify, now: () => this.now(),
    });
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  // --- the sweep ---------------------------------------------------------------------------
  /** One sweep, and an honest account of whether it happened.
   *
   *  The account is the whole point of the wrapper. `runSweep` below records success on its LAST
   *  line, because everything between the batch and that line — quarantine, the alarm loop, the
   *  samples, the manage-by notices — is work the sweep exists to do, and a sweep that did not do
   *  it has not succeeded however cleanly the quotes arrived. Success used to be recorded the
   *  moment the batch came back, which put all of that outside any failure path: a throw reached
   *  `scheduler`, which logs and returns, and `/health` went on saying `last_sweep_ok: true` and
   *  `alarms: "active"` with nothing being evaluated. `staleFor()` cannot see it either, since
   *  `sweepAt` is stamped at the START of a sweep — one that begins every 15 seconds and throws
   *  every time is never stale. The watchdog covers a sweep that HANGS, not one that throws.
   *
   *  It still resolves rather than rejecting: a broken sweep must not kill the loop, which is
   *  `scheduler`'s rule and the reason its own catch stays where it is.
   */
  async sweep(): Promise<void> {
    try {
      await this.runSweep();
    } catch (err) {
      console.error("monitor sweep failed:", err);
      await this.health.failure(`the sweep threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async runSweep(): Promise<void> {
    const { db } = this.deps;
    // held as a local as well as on the instance: a sweep takes real time, and every date the
    // sweep reckons — expiry, and the samples' market day — must come from ONE instant or a
    // sweep straddling midnight disagrees with itself
    const at = this.now();
    this.health.startedSweep(at);
    const today = utcDate(at);

    let active = await this.runExpiryLifecycle(today);
    this.forgetSilenceBut(active);

    // positions join the batch even when nothing alarms on them: the dashboard values them from
    // this same fetch, and a held position must not read as "—" merely because you happen not to be
    // watching it. This widens the batch only — the alarm loop below still runs over `active`.
    // the rows, not only their codes: the same list is what the samples below are written from,
    // so a Position cannot be in the batch and missing from the record
    //
    // HYDRATED PER ROW, inside a try. This ran as two bare flatMaps, so `toMonitor`'s JSON.parse
    // or `buildSpxCode`'s refusal took the whole sweep down — every minute, with the healthy rules
    // never evaluated and no alarm ever sent, which is #81's failure mode through a different door
    // (review 2026-11-01). The per-row guard in `evaluate` below, whose comment claims it covers
    // "corrupt legs, an unparseable date", never got the chance: this runs before the fetch.
    //
    // Filtering here also protects `quarantineUnknown`, which hydrates again inside a transaction.
    const legible: MonitorRow[] = [];
    const unreadable: MonitorRow[] = [];
    const monitorCodes: string[] = [];
    for (const monitor of active) {
      try {
        monitorCodes.push(...monitorLegCodes(toMonitor(monitor)));
        legible.push(monitor);
      } catch (err) {
        console.warn(`cannot read monitor ${monitor.code}:`, err);
        unreadable.push(monitor);
      }
    }
    if (unreadable.length > 0) await this.quarantineUnreadable(unreadable);
    active = legible;

    // positions join the batch for the dashboard's sake, so an unreadable one costs its own figures
    // and nothing else. A holding is not a rule and cannot be quarantined; the panel shows the gap.
    //
    // Only those still HELD. A closed holding is kept with its history (ADR 0022), but it is not
    // valued, sampled or told it is due a manage-by: its last sample is the record of how it ended,
    // and a sweep writing one more would rewrite that record with a market it was no longer in.
    const positionRows: PositionRow[] = [];
    const positionCodes: string[] = [];
    for (const position of openPositions(db)) {
      try {
        positionCodes.push(...positionLegCodes(toPosition(position)));
        positionRows.push(position);
      } catch (err) {
        console.warn(`cannot read position ${position.name}:`, err);
      }
    }
    const codes = [...new Set([...monitorCodes, ...positionCodes])].sort();
    if (codes.length === 0) {
      await this.health.success();
      return;
    }

    let records: QuoteRecord[];
    let badCodes: string[];
    try {
      ({ records, unknown: badCodes } = await this.deps.fetchQuotes(codes));
    } catch (err) {
      this.health.fetched(false);
      console.error("monitor sweep snapshot failed:", err);
      await this.health.failure();
      return;
    }
    this.health.fetched(true, this.now());

    let surviving = active;
    if (badCodes.length > 0) surviving = await this.quarantineUnknown(active, new Set(badCodes));

    const byCode: Record<string, QuoteRecord> = Object.fromEntries(
      records.map((r) => [String(r.code), r]),
    );
    const refused = await this.evaluate(surviving, byCode);
    // Both are about POSITIONS, not about alarms. They live here only because this is where the
    // batch is, so they take it as an argument instead (positions.ts).
    //
    // The holdings were read BEFORE the call, and a close can land while it is in flight. The
    // rules are checked again by now (a rule muted mid-fetch is not alarmed on); the holdings are
    // too, so a holding closed during the fetch gets no sample dated after it ended and no
    // manage-by notice about a trade that is over (ADR 0022).
    const stillOpen = new Set(openPositions(db).map((p) => p.id));
    const heldRows = positionRows.filter((p) => stillOpen.has(p.id));
    recordSamples(db, heldRows, byCode, at);
    await noticeManageBy(
      { db, settings: this.deps.settings, notify: (text) => this.notify(text) },
      heldRows, byCode, at,
    );
    // A watchlist evaluated in part is not a swept watchlist. The rules that COULD be evaluated
    // have been, which is what the containment in `evaluate` buys; saying so here is what stops
    // the rest from going quiet without a word.
    if (refused.length > 0) {
      await this.health.failure(`could not evaluate ${refused.join(", ")}`);
      return;
    }
    await this.health.success();
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
    const active: MonitorRow[] = [];
    const notices: string[] = [];

    await atomic(db, () => {
      for (const monitor of listMonitors(db)) {
        // the decision is `domain/lifecycle.expiryVerdict` (ADR 0017); this applies it
        const verdict = expiryVerdict(
          { code: monitor.code, strike_date: monitor.strike_date, enabled: Boolean(monitor.enabled) },
          today, retention,
        );
        if (verdict.notice !== null) notices.push(verdict.notice);
        if (verdict.action === "remove") {
          // the links go FIRST. monitor_positions is not managed for us, and deleting a linked
          // monitor raises FOREIGN KEY constraint failed — inside the sweep, every minute, so the
          // alarm engine stops altogether. The Python had this fault until it was found by writing
          // this port (#81). The Position stays: it is a holding.
          clearMonitorLinks(db, monitor.id);
          deleteMonitorRow(db, monitor.id);
        } else if (verdict.action === "mute") {
          const reason: DisabledReason = "expired";
          updateMonitorFields(db, monitor.id, {
            enabled: toSqliteBool(false), disabled_reason: reason,
          });
        } else if (monitor.enabled) {
          active.push(monitor);
        }
      }
    });
    // after the writes have committed, so a failed send cannot roll back a mute
    for (const text of notices) await this.notify(text);
    return active;
  }

  /** A row the engine cannot hydrate: disabled with a notice, kept for inspection.
   *
   *  The same treatment an unknown contract gets, and for the same reason — a rule the engine
   *  cannot evaluate is quarantined, never deleted (CLAUDE.md).
   */
  private async quarantineUnreadable(rows: MonitorRow[]): Promise<void> {
    const { db } = this.deps;
    const notices: string[] = [];
    await atomic(db, () => {
      for (const monitor of rows) {
        const reason: DisabledReason = "unreadable";
        updateMonitorFields(db, monitor.id, {
          enabled: toSqliteBool(false), disabled_reason: reason,
        });
        // the words are `domain/lifecycle.unreadableNotice`'s (ADR 0017); this applies it
        notices.push(unreadableNotice(monitor.code));
      }
    });
    for (const text of notices) await this.notify(text);
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
        // the decision is `domain/lifecycle.unknownContractVerdict` (ADR 0017); this applies it
        const verdict = unknownContractVerdict(toMonitor(monitor), bad);
        if (!verdict.quarantine) {
          surviving.push(monitor);
          continue;
        }
        const reason: DisabledReason = "unknown-contract";
        updateMonitorFields(db, monitor.id, {
          enabled: toSqliteBool(false), disabled_reason: reason,
        });
        if (verdict.notice !== null) notices.push(verdict.notice);
      }
    });
    for (const text of notices) await this.notify(text);
    return surviving;
  }

  /** The alarm loop: a figure per rule, `alarm.ts`'s verdict on it, the write — and, for a rule
   *  with no figure to evaluate at all, the count toward quarantine.
   *
   *  The count lives here rather than beside `quarantineUnknown` because this is the only place
   *  that knows a figure did not arrive: the fetch succeeded, the contract was priced, and
   *  `monitorValue` still answered null.
   */
  private async evaluate(
    monitors: MonitorRow[], byCode: Record<string, QuoteRecord>,
  ): Promise<string[]> {
    const { db, settings } = this.deps;
    const now = this.now();
    const stamp = toSqlDatetime(now);
    const notices: string[] = [];
    const limit = settings.quarantineAfterSilentSweeps;
    /** the rules this sweep could not evaluate at all, named for the record the caller leaves */
    const refused: string[] = [];

    await atomic(db, () => {
      for (const row of monitors) {
        // Per ROW, inside the transaction, which is the only place it contains anything: one
        // unreadable row — corrupt `legs`, an unparseable date, a write SQLite refuses — used to
        // abort the whole batch and take every other rule's alarm with it. The rules that can be
        // evaluated are, and `runSweep` reports the sweep as failed rather than clean.
        //
        // NOT a quarantine. That is reserved for the two faults the engine can diagnose — an
        // unknown contract and a figure that never arrives — and disabling a rule over a fault
        // nobody has read yet would silence it for a reason that might be a bug in here.
        // where this row's messages start, so a row that fails takes its own back: it queued a
        // "crossed" the instant before its write was refused, and sending that would announce a
        // breach the database has no record of — which re-announces on every sweep after, since
        // `triggered` never got written.
        const mark = notices.length;
        try {
          const monitor = toMonitor(row);
          const value = monitorValue(monitor, byCode);
          if (value === null) {
            // the decision is `domain/lifecycle.silenceVerdict` (ADR 0017); this applies it
            const verdict = silenceVerdict(
              monitor, new Set(Object.keys(byCode)), this.silentSweeps.get(row.id) ?? 0, limit,
            );
            if (verdict.count === null) this.silentSweeps.delete(row.id);
            else this.silentSweeps.set(row.id, verdict.count);
            if (verdict.quarantine) {
              const reason: DisabledReason = "no-figure";
              updateMonitorFields(db, row.id, {
                enabled: toSqliteBool(false), disabled_reason: reason,
              });
            }
            if (verdict.notice !== null) notices.push(verdict.notice);
            else console.warn(`silent: ${monitor.code} (${verdict.count}${limit > 0 ? `/${limit}` : ""})`);
            continue;
          }
          // it arrived: the run of silence is over, and a run is what the limit counts
          this.silentSweeps.delete(row.id);
          // re-read: the fetch was awaited, and a request may have changed the row in the meantime.
          // The Python re-reads for the same reason, across its session boundary.
          const current = findMonitor(db, row.id);
          if (!current) continue;
          // INCLUDING whether it is still on. This harvested `triggered` and `last_alarm_at` and
          // never looked at `enabled`, so muting a flapping rule from the dashboard or the bot
          // while a sweep was out got you the message anyway — and left the flag on, so the
          // eventual unmute re-fired it (review 2026-11-01). Deleted and muted are the same answer
          // here: this reading is about a rule that is no longer being watched.
          if (!current.enabled) continue;

          const changes: Partial<MonitorRow> = { last_value: value, last_checked_at: stamp };
          // the Provider's name for the contract where it has one: a combo's code IS its name,
          // and a single's code is machine-readable rather than something to read on a phone
          const name = (byCode[monitor.code]?.name as string | undefined) || monitor.code;
          // the decision is alarm.ts's; what is left here is turning it into a row and a message
          const decision = alarmTransition(
            monitor, value, name,
            { triggered: current.triggered !== 0, lastAlarmAt: lastAlarmAt(current) },
            alarmPolicy(settings), now,
          );
          if (decision.triggered !== null) changes.triggered = toSqliteBool(decision.triggered);
          if (decision.notice !== null) {
            // one condition, not two: the stamp is the record of having SPOKEN, and moving it for
            // a message that was never queued is what would mute the next reminder
            changes.last_alarm_at = stamp;
            notices.push(decision.notice);
          }
          updateMonitorFields(db, row.id, changes);
        } catch (err) {
          notices.length = mark;
          refused.push(row.code);
          console.error(`monitor ${row.code} could not be evaluated:`, err);
        }
      }
    });
    for (const text of notices) await this.notify(text);
    return refused;
  }
}
