/** `watch_samples`: one observation of a watched set of contracts per market day (#402).
 *
 *  Keyed by the contracts, not by a rule (migration 0014), and never deleted: a history outlives
 *  the rule that watched it, as a holding's samples outlive nothing but the holding itself. Nothing
 *  here deletes a row, and nothing should — the owner's decision of 2026-11-15, and CLAUDE.md's
 *  "nothing else is ever auto-deleted".
 */
import type { DatabaseSync } from "node:sqlite";

import type { WatchSampleRow } from "../rows.ts";
import { row, rows } from "./sql.ts";

/** Every day stored for one set of contracts (`contractSetKey`), oldest first. */
export function listWatchSamples(db: DatabaseSync, contracts: string): WatchSampleRow[] {
  return rows<WatchSampleRow>(
    db, "select * from watch_samples where contracts = ? order by observed_on", contracts,
  );
}

/** The day already stored for this set of contracts, if any: what `takesSample` decides against. */
export function findWatchSample(
  db: DatabaseSync, contracts: string, observedOn: string,
): WatchSampleRow | undefined {
  return row<WatchSampleRow>(
    db, "select * from watch_samples where contracts = ? and observed_on = ?", contracts, observedOn,
  );
}

/** One day of a set of contracts, keyed on the market day: REPLACE, so the last write of a day is
 *  the one that stays, as `recordPositionSample`'s. Columns named for its reason. */
export function recordWatchSample(db: DatabaseSync, value: WatchSampleRow): void {
  db.prepare(
    `insert or replace into watch_samples
       (contracts, observed_on, dte, legs_mid, legs_iv, legs_vega, legs_delta, observed_at, spx,
        contract_size)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    value.contracts, value.observed_on, value.dte, value.legs_mid, value.legs_iv, value.legs_vega,
    value.legs_delta, value.observed_at, value.spx, value.contract_size,
  );
}
