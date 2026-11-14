/** What a sweep records of the WATCHLIST: the daily close of every set of contracts an enabled rule
 *  watches (#402).
 *
 *  Only holdings had daily samples, so a spread watched as a candidate had no history: its value
 *  went blank every evening, its payoff with it, and the days it was watched before it was entered
 *  were lost to its burndown. This keeps them, under EXACTLY the holdings' rules (`recordSamples`
 *  in `positions.ts`, ADR 0011): written freely only from 09:30 to 16:15 New York, every calendar
 *  day, filled whatever the hour, completed or replaced as provisional by `takesSample`, an empty
 *  price never replacing a stored one, and every write stamped.
 *
 *  **From the sweep's own batch, never a call of its own** (CLAUDE.md's bounded-call invariant).
 *  Every enabled rule's contracts are already in it, which is why only those are recorded.
 *
 *  **Keyed by the contracts, not by a rule** (migration 0014): each contract's mid is stored rather
 *  than any one structure's value, so a rule edited or replaced, two rules on the same contracts,
 *  and a holding recorded later on them all read one history, each valuing it its own way when it
 *  reads it (`watch-history.ts`). The contracts an open holding holds EXACTLY are left to that
 *  holding's own samples; a candidate that only shares a contract with one is still recorded.
 *
 *  Guarded per set of contracts, as the holdings' sampler is per holding: a sample must never be
 *  the reason a breach went unmessaged.
 */
import type { DatabaseSync } from "node:sqlite";

import { daysToExpiry, marketDate, takesSample } from "optionality/domain/expiry";
import { monitorLegCodes } from "optionality/domain/monitor";
import { contractSize, positionLegCodes } from "optionality/domain/position";
import { derivedSpx } from "optionality/domain/quote";
import type { QuoteRecord } from "optionality/quotes";
import { findWatchSample, recordWatchSample } from "../db/queries/index.ts";
import type { MonitorRow, PositionRow, WatchSampleRow } from "../db/rows.ts";
import { toSqlDatetime } from "../db/time.ts";
import { toSqliteJson } from "../db/values.ts";
import { toMonitor, toPosition } from "../hydrate.ts";
import { contractSetKey } from "../watch-history.ts";

/** Every contract's finite reading of one field, as a code -> value map in the key's order, or null
 *  if any contract lacks one: all or nothing, as a holding's maps are (`legReadings`). For the mid,
 *  "none" is a contract with no two-sided quote (#380), and a price is a sum over every contract. */
function readings(
  codes: string[], byCode: Record<string, QuoteRecord>, field: string,
): Record<string, number> | null {
  const out: Record<string, number> = {};
  for (const code of codes) {
    const value = byCode[code]?.[field];
    if (value === null || value === undefined) return null;
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    out[code] = n;
  }
  return out;
}

/** `takesSample` reads a Cost to close only for whether there is one; a set of contracts has a
 *  price exactly when every contract has a mid. */
const priced = (mids: string | null): number | null => (mids === null ? null : 0);

/** The sets of contracts the enabled rules watch, by key, with the expiry they share: once each,
 *  however many rules watch them, and none an open holding holds exactly. */
function watchedSets(
  monitors: MonitorRow[], holdings: PositionRow[],
): Map<string, { codes: string[]; strikeDate: string }> {
  const held = new Set<string>();
  for (const row of holdings) {
    try {
      held.add(contractSetKey(positionLegCodes(toPosition(row))));
    } catch {
      // a holding that cannot be read holds nothing here; the sweep already said so
    }
  }
  const sets = new Map<string, { codes: string[]; strikeDate: string }>();
  for (const row of monitors) {
    if (!row.enabled) continue;
    try {
      const monitor = toMonitor(row);
      const key = contractSetKey(monitorLegCodes(monitor));
      if (held.has(key) || sets.has(key)) continue;
      sets.set(key, { codes: key.split(","), strikeDate: monitor.strike_date });
    } catch {
      // a rule that cannot be read is quarantined by the sweep, and records nothing
    }
  }
  return sets;
}

/** One row per set of contracts per market day, from this sweep's batch (see the file's comment). */
export function recordWatchSamples(
  db: DatabaseSync, monitors: MonitorRow[], holdings: PositionRow[],
  byCode: Record<string, QuoteRecord>, at: Date,
): void {
  const observedOn = marketDate(at);
  // the batch's SPX and contract size, once for every row, as the holdings' sampler takes them
  const spx = derivedSpx(Object.values(byCode)).price;
  const size = contractSize(byCode);
  for (const [key, { codes, strikeDate }] of watchedSets(monitors, holdings)) {
    try {
      const dte = daysToExpiry(strikeDate, at);
      if (dte < 0) continue;
      const maps = ["mid_price", "option_implied_volatility", "option_vega", "option_delta"]
        .map((field) => readings(codes, byCode, field));
      // nothing observed at all — contracts the Provider did not return — is no row
      if (maps.every((m) => m === null)) continue;
      const [mids, ivs, vegas, deltas] = maps.map((m) => (m === null ? null : toSqliteJson(m))) as
        [string | null, string | null, string | null, string | null];

      const day = findWatchSample(db, key, observedOn);
      const write = takesSample(
        at,
        day === undefined ? null
          : { legs_iv: day.legs_iv, legs_vega: day.legs_vega, cost_to_close: priced(day.legs_mid), observed_at: day.observed_at },
        { legs_iv: ivs, legs_vega: vegas, cost_to_close: priced(mids) },
      );
      if (write === "no") continue;
      const row: WatchSampleRow = {
        contracts: key, observed_on: observedOn, dte, legs_mid: mids, legs_iv: ivs, legs_vega: vegas,
        legs_delta: deltas, observed_at: toSqlDatetime(at), spx, contract_size: size,
      };
      // only when something differs, as the holdings' sampler: `observed_at` stamps a write
      if (write === "if-changed" && day && day.dte === dte && day.legs_mid === mids
        && day.legs_iv === ivs && day.legs_vega === vegas && day.legs_delta === deltas
        && day.spx === spx && day.contract_size === size) continue;
      recordWatchSample(db, row);
    } catch (err) {
      console.error(`recording a watch sample for ${key} failed:`, err);
    }
  }
}
