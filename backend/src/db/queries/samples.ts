/** `position_samples`: one observation of a holding per market day (ADR 0011).
 *
 *  The one thing in this database that cannot be re-entered (CLAUDE.md), which is why nothing
 *  here deletes a sample except the delete that follows the holding it belongs to — the foreign
 *  key says they are its, and a series of what-this-was-worth means nothing once the holding is
 *  gone.
 */
import type { DatabaseSync } from "node:sqlite";

import type { PositionSampleRow } from "../rows.ts";
import { row, rows } from "./sql.ts";

/** Every sample for one Position, oldest first — the order a day-by-day measurement needs — and
 *  none from after the day it CLOSED.
 *
 *  A close can be backdated: the sweep sampled the holding on the 7th and 8th, and the owner then
 *  recorded that it was sold on the 6th. What it was worth after it was sold is not its history,
 *  so every reader is spared those rows here, in the one query that reads history — and they are
 *  ignored, never deleted: the close day may yet be corrected (ADR 0022). */
export function listPositionSamples(db: DatabaseSync, id: string): PositionSampleRow[] {
  return rows<PositionSampleRow>(
    db,
    `select s.* from position_samples s
     join positions p on p.id = s.position_id
     where s.position_id = ? and (p.closed_on is null or s.observed_on <= p.closed_on)
     order by s.observed_on`,
    id,
  );
}

export function clearPositionSamples(db: DatabaseSync, id: string): void {
  db.prepare("delete from position_samples where position_id = ?").run(id);
}

/** One observation of a Position's Cost to close, keyed on the market day (ADR 0011).
 *
 *  REPLACE, not IGNORE: the sweep runs every few seconds and the row should converge on the
 *  settled mark, so the last write of a market day is the one that stays.
 *
 *  Columns listed rather than taken from `COLUMNS`: this table's key is (position_id,
 *  observed_on) and it has no `id`, so the generic insert's shape does not fit it — and naming
 *  them is what makes `insert or replace` readable as the decision it is.
 */
export function recordPositionSample(db: DatabaseSync, value: PositionSampleRow): void {
  db.prepare(
    `insert or replace into position_samples
       (position_id, observed_on, dte, cost_to_close, legs_iv, legs_vega)
     values (?, ?, ?, ?, ?, ?)`,
  ).run(
    value.position_id, value.observed_on, value.dte, value.cost_to_close,
    value.legs_iv, value.legs_vega,
  );
}

/** The sample already stored for this Position on this market day, if any.
 *
 *  Read so the sampler can decline to write the same row again. It wrote on every sweep — 5,760
 *  times a day at a 15-second interval, to persist one row — and overnight almost all of those
 *  stored a value identical to the one already there. */
export function findPositionSample(
  db: DatabaseSync, positionId: string, observedOn: string,
): PositionSampleRow | undefined {
  return row<PositionSampleRow>(
    db, "select * from position_samples where position_id = ? and observed_on = ?",
    positionId, observedOn,
  );
}
