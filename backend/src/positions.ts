/** Position operations that are more than a query (ADR 0009, phase 5). */
import type { DatabaseSync } from "node:sqlite";

import { daysToExpiry, marketDate } from "./domain/expiry.ts";
import { dteAtOpen, onPace } from "./domain/exit.ts";
import { monitorLegCodes } from "./domain/monitor.ts";
import { costToClose, legReadings, positionsHolding } from "./domain/position.ts";
import {
  findPositionSample, linkMonitorToPositions, listPositions, orphanMonitors,
  recordPositionSample, setMonitorScope, stampManageNotified,
} from "./db/queries.ts";
import type { PositionRow } from "./db/rows.ts";
import { toSqlDatetime } from "./db/time.ts";
import { toSqliteJson } from "./db/values.ts";
import type { Settings } from "./env.ts";
import type { QuoteRecord } from "./quotes.ts";
import { toMonitor, toPosition } from "./hydrate.ts";

/** Link monitors that watch something now held, and never unlink anything.
 *
 *  The link is worked out when a thing is created, which handled only one order: position first,
 *  then monitor. Set the alarm before recording the holding and the monitor stayed orphaned for
 *  ever. This is the mirror image, so either order works.
 *
 *  It looks ONLY at monitors that have no link. The tempting alternative — recompute every link on a
 *  schedule — is worse than the bug: rolling a spread leaves the old and the new sharing a strike for
 *  a day, a recomputing job would call that contract ambiguous, and a monitor that had worked for
 *  weeks would silently lose its entry and P&L mid-session. What you already have cannot be taken
 *  away by something you subsequently hold.
 */
export function adoptOrphanMonitors(db: DatabaseSync): void {
  const orphans = orphanMonitors(db);
  if (orphans.length === 0) return;
  const positions = listPositions(db).map(toPosition);
  for (const row of orphans) {
    const monitor = toMonitor(row);
    const { found, scope } = positionsHolding(positions, monitorLegCodes(monitor));
    if (found.size === 0) continue;
    setMonitorScope(db, monitor.id, scope);
    linkMonitorToPositions(db, monitor.id, [...found]);
  }
}

/** What the sweep hands these: the database, the policy, and a way to send that reports whether it
 *  got through. `MonitorSweeper.notify` swallows a failed send — it must, since the sweep's job is
 *  the alarm — so a caller that needs to know asks for the answer rather than for a throw.
 */
export interface PositionSweepDeps {
  db: DatabaseSync;
  settings: Settings;
  notify: (text: string) => Promise<boolean>;
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
export async function noticeManageBy(
  deps: PositionSweepDeps,
  rows: PositionRow[], byCode: Record<string, QuoteRecord>, at: Date,
): Promise<void> {
  const { settings } = deps;
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
      // stamped only once the notice has actually been delivered, so an undelivered one is
      // retried next sweep while a delivered one is never repeated. `notify` swallows a failed
      // send and therefore cannot be relied on to throw — it reports instead.
      if (await deps.notify(line)) {
        stampManageNotified(deps.db, row.id, toSqlDatetime(at));
      }
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
export function recordSamples(
  db: DatabaseSync, rows: PositionRow[], byCode: Record<string, QuoteRecord>, at: Date,
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
      // legs run 10.5% to 22.1%, so one number for them would be a fiction. The vegas go with
      // them as the weight those IVs have to be combined with, and are recorded rather than
      // derived later because a vega is only knowable when it was observed.
      //
      // Null rather than a partial map, per map: a vol adjustment needs every leg, and half a
      // structure's vol invites an answer computed from half a structure. Gated SEPARATELY,
      // though — a withheld vega does not make the IV reading untrue, and the IV is the half no
      // later sweep can recover.
      const ivs = legReadings(position, byCode, "option_implied_volatility");
      const vegas = legReadings(position, byCode, "option_vega");
      const legsIv = ivs === null ? null : toSqliteJson(ivs);
      const legsVega = vegas === null ? null : toSqliteJson(vegas);

      // Only when something actually differs. The sweep runs every 15 seconds and the day's row
      // is meant to settle on the close, not to be rewritten 5,760 times — overnight and at
      // weekends nearly every one of those writes stored what was already there, and the IV map
      // triples what each one carries.
      const stored = findPositionSample(db, row.id, observedOn);
      if (stored && stored.dte === dte && stored.cost_to_close === cost
        && stored.legs_iv === legsIv && stored.legs_vega === legsVega) continue;

      recordPositionSample(db, {
        position_id: row.id, observed_on: observedOn, dte, cost_to_close: cost,
        legs_iv: legsIv, legs_vega: legsVega,
      });
    } catch (err) {
      console.error(`recording a sample for ${row.name} failed:`, err);
    }
  }
}
