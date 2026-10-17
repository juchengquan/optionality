/** What a holding is worth and where it stands, computed once for everything that asks.
 *
 *  The dashboard asks through `/positions/values`; the bot asks through `/holdings`. The route used
 *  to do all of this inline, so a second caller meant a second definition of cost, P&L and the exit
 *  schedule — and #129 was a day spent on what happens when two surfaces answer one question their
 *  own way. The figures are decided here; each surface only chooses how to say them.
 */
import type { DatabaseSync } from "node:sqlite";

import { costToClose, positionLegCodes, positionPnl, type Position } from "./domain/position.ts";
import { dteAtOpen, exitLevels, exitPolicy, type ExitLevels } from "./domain/exit.ts";
import { daysToExpiry } from "./domain/expiry.ts";
import { listPositions } from "./db/queries.ts";
import type { PositionRow } from "./db/rows.ts";
import type { Settings } from "./env.ts";
import { toPosition } from "./hydrate.ts";
import { displayRecords, fetchResilient, type QuoteFetcher } from "./quotes.ts";

export interface HoldingValue {
  row: PositionRow;
  position: Position;
  /** what it would cost to buy back right now, or null where a leg cannot be read */
  cost: number | null;
  /** Entry less cost to close, in money. Null where either is unknown. */
  pnl: number | null;
  /** Null for a Position whose Opened nobody declared: nothing is inferred from created_at, so
   *  there is no DTE at entry and therefore no schedule (ADR 0011). */
  schedule: (ExitLevels & { dte_at_open: number }) | null;
  dte: number;
}

/** The exit schedule for one holding, or null where it was never declared Opened. */
export function scheduleOf(
  row: PositionRow, cost: number | null, now: Date, settings: Settings,
): (ExitLevels & { dte_at_open: number }) | null {
  if (row.opened_at === null) return null;
  const openedDte = dteAtOpen(row.strike_date, row.opened_at);
  // exitPolicy, not a fourth hand-built copy of the same three knobs — the sweeper and the bot
  // already read the policy through it
  const levels = exitLevels(
    row.entry, openedDte, daysToExpiry(row.strike_date, now), exitPolicy(settings), cost,
  );
  return levels === null ? null : { dte_at_open: openedDte, ...levels };
}

/** Every holding, valued from ONE batch.
 *
 *  Throws if the batch fails: whether that is a 502 or a sentence in a Telegram reply is the
 *  caller's business, not this module's.
 */
export async function holdingValues(
  db: DatabaseSync, fetchQuotes: QuoteFetcher, now: Date, settings: Settings, tz: string,
): Promise<{ byCode: Record<string, Record<string, unknown>>; values: HoldingValue[] }> {
  const rows = listPositions(db);
  if (rows.length === 0) return { byCode: {}, values: [] };

  const positions = rows.map(toPosition);
  const codes = [...new Set(positions.flatMap((p) => positionLegCodes(p)))].sort();
  const { records } = await fetchResilient(codes, fetchQuotes);
  const byCode = displayRecords(records, tz, now);

  return {
    byCode,
    values: rows.map((row, i) => {
      const position = positions[i]!;
      const cost = costToClose(position, byCode);
      return {
        row,
        position,
        cost,
        pnl: positionPnl(position, byCode),
        schedule: scheduleOf(row, cost, now, settings),
        dte: daysToExpiry(row.strike_date, now),
      };
    }),
  };
}
