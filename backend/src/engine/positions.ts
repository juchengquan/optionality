/** What a sweep does to HOLDINGS: the daily sample, and the manage-by notice (ADR 0020).
 *
 *  Inside the engine's door because `engine/sweeper.ts` is the only caller — measured, and the
 *  reason it matters is the sample. `recordSamples` writes one observation per Position per market
 *  DAY, stamped with the sweep's single instant, which is what makes the √T decay shape checkable
 *  against this book rather than defended on arithmetic (ADR 0011). While it sat at `src/` root any
 *  route could have written a second observation for the same day, mid-request, outside that
 *  guarantee; `check-seams` now refuses the import.
 *
 *  Neither of these is an alarm. They live here because the batch they read is the sweep's batch
 *  and the instant they stamp is the sweep's instant — the figures come from one fetch, so a
 *  Position cannot be in the batch and missing from the record.
 */
import type { DatabaseSync } from "node:sqlite";

import { daysToExpiry, marketDate, sampleTiming, takesSample } from "optionality/domain/expiry";
import { dteAtOpen, onPace } from "optionality/domain/exit";
import { contractSize, costToClose, legReadings } from "optionality/domain/position";
import { derivedSpx } from "optionality/domain/quote";
import {
  findPositionSample, recordPositionSample, stampManageNotified,
} from "../db/queries/index.ts";
import type { PositionRow } from "../db/rows.ts";
import { toSqlDatetime } from "../db/time.ts";
import { toSqliteJson } from "../db/values.ts";
import type { Settings } from "../env.ts";
import type { Notifier } from "../notify.ts";
import type { QuoteRecord } from "optionality/quotes";
import { toPosition } from "../hydrate.ts";
import { closeOf } from "../holdings.ts";

/** What the sweep hands these: the database, the policy, and a way to send that reports whether it
 *  got through. `notify.ts`'s notifier swallows a failed send — it must, since the sweep's job is
 *  the alarm — so a caller that needs to know asks for the answer rather than for a throw.
 */
export interface PositionSweepDeps {
  db: DatabaseSync;
  settings: Settings;
  notify: Notifier;
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
 *
 *  **Held until there is a Cost to close to say** (#380). The notice goes once, so one sent without
 *  its "now" line is without it for good — and the manage-by DTE is first crossed just after New
 *  York's midnight, when moomoo quotes every option bid 0 / ask 0 and the batch prices nothing. So
 *  it is valued from the sweep's own batch where that prices it, and otherwise, outside the
 *  session, from the holding's latest close as `/holdings` would value it (`closeOf`), with that
 *  close's day said beside the figure and its pace at that close's own DTE. Where neither gives a
 *  cost the notice is not sent and not stamped, and the next sweep asks again — in the session at
 *  the latest, where the batch prices it.
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

      // the batch's own cost when it has one; else, out of the session, the latest close's
      const live = costToClose(toPosition(row), byCode);
      const close = live === null ? closeOf(deps.db, row, at) : null;
      const cost = close === null ? live : close.cost_to_close;
      // no cost yet: HELD, unsent and unstamped, until a sweep has one to say
      if (cost === null) continue;
      const pace = onPace(row.entry, dteAtOpen(row.strike_date, row.opened_at), close?.dte ?? dte);

      let line = `⏰ ${row.name} is at ${dte} DTE — manage by ${settings.exitManageByDte}`;
      if (row.entry !== null) line += `\nentry ${row.entry}`;
      line += close === null ? ` · now ${cost.toFixed(2)}` : ` · ${cost.toFixed(2)} ${closeWords(close)}`;
      if (pace !== null) {
        const gap = cost - pace;
        line += `\non-pace ${pace.toFixed(2)}`;
        line += ` — ${gap > 0 ? "behind" : "ahead"} by ${Math.abs(gap).toFixed(2)}`;
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

/** Which stored row a figure is from, after the figure: "at the 2026-11-13 close", or the reading's
 *  own timing where no close had a cost (`closeSample`'s fallback) — never passed off as a close. */
function closeWords(close: { observed_on: string; observed_at: string | null }): string {
  switch (sampleTiming(close.observed_at)) {
    case "close": return `at the ${close.observed_on} close`;
    case "after-close": return `on ${close.observed_on}, after the close`;
    case "before-open": return `on ${close.observed_on}, before the open`;
    default: return `on ${close.observed_on}`;
  }
}

  /** One observation per Position per market day, so the decay shape can be checked against this
 *  book rather than defended on arithmetic (ADR 0011).
 *
 *  Written freely only in the sample hours, 09:30 to 16:15 in New York, so the day's row is the last
 *  sweep at or before the options' close. Until then it was rewritten up to New York's midnight,
 *  and SPXW trades again from about 20:15 — so the row that survived could be an overnight mark
 *  under a chart that calls it the close. Outside the hours a row is only ever FILLED (a day with
 *  none: a trade recorded in the evening, a session missed whole) or COMPLETED (a row the feed left
 *  without its IV or vega), never changed — `takesSample` decides, and every write carries the
 *  sweep's instant in `observed_at`, so a filled point is never mistaken for a close. Every calendar
 *  day, weekends included, because the vol chain needs a row for each (vol.ts).
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
  // SPX's price as this sweep's batch implies it, once for every row: each was valued against the
  // same index. Never a Reference's figure (ADR 0018, 0024); null where the batch cannot give it,
  // which costs the sample nothing else.
  const spx = derivedSpx(Object.values(byCode)).price;
  // ...and the batch's contract size, so a holding valued from this row outside the session has a
  // P&L without asking the Provider (#380, migration 0013). Never assumed to be 100.
  const size = contractSize(byCode);
  for (const row of rows) {
    try {
      const dte = daysToExpiry(row.strike_date, at);
      if (dte < 0) continue;
      const position = toPosition(row);
      // unknown, not zero: one leg without a mid and there is no cost to record. The vol may still
      // be there to read — moomoo quotes every option 0/0 out of hours and serves the greeks — and
      // the chain needs the day, so the row is written with the cost left empty (#380, below).
      const cost = costToClose(position, byCode);

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
      // The delta the same way and for the same reason as the vega: the risk the owner manages
      // by, only knowable when observed, all or nothing, and gated on its own so a withheld delta
      // never costs the IV or the vega reading beside it.
      const deltas = legReadings(position, byCode, "option_delta");
      const legsDelta = deltas === null ? null : toSqliteJson(deltas);
      // nothing observed at all — a leg the Provider did not return — is no row: there is neither a
      // price nor a reading to keep, and skipping it is quiet, as it always was
      if (cost === null && ivs === null && vegas === null && deltas === null) continue;

      // The day's row as it stands decides what this sweep may do with it: fill it, write it if
      // its figures moved, restamp or replace a provisional one, complete one without its vol
      // readings — or nothing, which is how a settled close stays the close (takesSample).
      const stored = findPositionSample(db, row.id, observedOn);
      // ...and an EMPTY cost never replaces a stored one, whatever the hour (#380)
      const write = takesSample(
        at, stored ?? null, { legs_iv: legsIv, legs_vega: legsVega, cost_to_close: cost },
      );
      if (write === "no") continue;

      // Only when something actually differs. The sweep runs every 15 seconds and the day's row
      // is meant to settle on the close, not to be rewritten 5,760 times — overnight and at
      // weekends nearly every one of those writes stored what was already there, and the IV map
      // triples what each one carries. `observed_at` is NOT compared: it stamps a write, so it
      // says when the figures were last seen to change, which is when they were observed.
      if (write === "if-changed" && stored && stored.dte === dte && stored.cost_to_close === cost
        && stored.legs_iv === legsIv && stored.legs_vega === legsVega
        && stored.legs_delta === legsDelta && stored.spx === spx
        && stored.contract_size === size) continue;

      recordPositionSample(db, {
        position_id: row.id, observed_on: observedOn, dte, cost_to_close: cost,
        legs_iv: legsIv, legs_vega: legsVega, legs_delta: legsDelta, observed_at: toSqlDatetime(at),
        spx, contract_size: size,
      });
    } catch (err) {
      console.error(`recording a sample for ${row.name} failed:`, err);
    }
  }
}
