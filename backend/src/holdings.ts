/** What a holding is worth and where it stands, computed once for everything that asks.
 *
 *  The dashboard asks through `/positions/values`; the bot asks through `/holdings`. The route used
 *  to do all of this inline, so a second caller meant a second definition of cost, P&L and the exit
 *  schedule — and #129 was a day spent on what happens when two surfaces answer one question their
 *  own way. The figures are decided here; each surface only chooses how to say them.
 *
 *  **Outside New York's session a holding is valued from its latest close** (#380), not from the
 *  Provider: moomoo quotes every option bid 0 / ask 0 out of hours, which is no price, and the day's
 *  close is what the owner reviews a trade against. `valuesFromClose` decides, per holding: in the
 *  session always live; outside it the latest stored row with a cost taken in the hours, else the
 *  latest with a cost of any timing (stated by the caller); and live where no row has a cost, which
 *  out of hours is a dash, never a 0. Only the holdings valued live are asked for, so a book wholly
 *  valued from its closes asks the Provider nothing.
 *
 *  **Out of the session a failed Provider call costs only the holdings that needed it** (#387): they
 *  are dashes with the reason (`unpriced`), and the rest are served from their closes. Out of hours
 *  a holding valued live would be a dash anyway, so a 502 for the whole book would withhold every
 *  close for a figure nobody could have had. In the session the batch is the price, and a failure
 *  is still the caller's to report.
 */
import type { DatabaseSync } from "node:sqlite";

import {
  contractSize, costToClose, pnlAt, positionLegCodes, type ByCode, type Position,
} from "optionality/domain/position";
import {
  captured, dteAtOpen, exitLevels, exitPolicy, type ExitLevels,
} from "optionality/domain/exit";
import { daysToExpiry, inSession, valuesFromClose } from "optionality/domain/expiry";
import { derivedSpx, type DerivedSpx } from "optionality/domain/quote";
import { listPositionSamples, openPositions } from "./db/queries/index.ts";
import type { PositionRow, PositionSampleRow } from "./db/rows.ts";
import type { Settings } from "./env.ts";
import { toPosition } from "./hydrate.ts";
import { beforeCorrection } from "./correct-legs.ts";
import { displayRecords, type QuoteFetcher, type QuoteRecord } from "optionality/quotes";

export interface HoldingValue {
  row: PositionRow;
  position: Position;
  /** what it would cost to buy back — now, or at the close it is valued from — or null where a
   *  leg cannot be read */
  cost: number | null;
  /** Entry less cost to close, in money. Null where either is unknown, or the size is. */
  pnl: number | null;
  /** the share of a credit's Entry kept so far, from this same cost (`captured`): null for a debit,
   *  which has no credit to keep, and wherever either side is unknown (ADR 0023) */
  captured: number | null;
  /** Null for a Position whose Opened nobody declared: nothing is inferred from created_at, so
   *  there is no DTE at entry and therefore no schedule (ADR 0011). */
  schedule: (ExitLevels & { dte_at_open: number }) | null;
  /** today's DTE, whatever the figures are from: what the holding's DTE column and its manage-by
   *  say (#380, F5) */
  dte: number;
  /** "live" from the Provider's batch, or "close" from the stored row `close` (#380) */
  valuedFrom: "live" | "close";
  /** why a holding valued live has no figures: out of the session, the failed Provider call's own
   *  message (#387); null wherever the call was made and answered, or not needed */
  unpriced: string | null;
  /** the stored row a close valuation is from; null for a live one */
  close: PositionSampleRow | null;
  /** the records the greeks, the legs' deltas and the strike distances are read from: the batch's
   *  for a live valuation, the close row's own per-leg delta, IV and vega for a close — which stores
   *  no gamma and no theta, so those are dashes (#380) */
  records: ByCode;
  /** SPX's price at the instant of the figures: the batch's (`derivedSpx`), or the close row's */
  spx: DerivedSpx;
  /** the points-to-money multiplier: the batch's, or the close row's (migration 0013) */
  contractSize: number | null;
  /** the DTE the figures were taken at: today's when live, the close row's own when not — what
   *  Levels, the pace and a σ are measured at, so a Friday close is paced as Friday (#380, F5) */
  figuresDte: number;
}

/** Why a close valuation has no SPX: the row was written by a batch with no premium to derive it
 *  from, or before migration 0010. */
export const NO_CLOSE_SPX = "no SPX price was recorded with the close it is valued from";

/** The stored row a holding is valued from at `now`, or null to value it live (`valuesFromClose`).
 *
 *  A row observed before a leg's quantity was last corrected is no candidate: its Cost to close was
 *  summed under the old quantities (#359), a figure for another structure — the reason `/vol`
 *  withholds a gap read off one. Such a holding falls back to an earlier-corrected row, or to live.
 */
export function closeOf(db: DatabaseSync, row: PositionRow, now: Date): PositionSampleRow | null {
  const samples = listPositionSamples(db, row.id)
    .filter((s) => !beforeCorrection(s.observed_at, row.qty_corrected_at));
  return valuesFromClose(now, samples);
}

/** A stored per-leg map, or null where it is absent or will not parse: a corrupt map costs its own
 *  figures, never the valuation. */
function storedMap(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A close row's per-leg readings as records keyed by contract, in the fields a batch names them by,
 *  so the greeks, the legs' deltas and the strike distances are read by the same functions a live
 *  valuation's are, signed the same way. Only what the row stores: no mid, no gamma, no theta. */
function closeRecords(position: Position, close: PositionSampleRow): ByCode {
  const maps = [
    ["option_delta", storedMap(close.legs_delta)],
    ["option_implied_volatility", storedMap(close.legs_iv)],
    ["option_vega", storedMap(close.legs_vega)],
  ] as const;
  const records: ByCode = {};
  for (const code of positionLegCodes(position)) {
    const record: Record<string, unknown> = { code };
    for (const [field, map] of maps) {
      const v = map?.[code];
      if (typeof v === "number" && Number.isFinite(v)) record[field] = v;
    }
    records[code] = record;
  }
  return records;
}

/** The exit schedule for one holding, or null where it was never declared Opened.
 *
 *  Measured at the DTE the figures were taken at (`figuresDte`): a Friday close is paced as Friday,
 *  where today's DTE would charge it a day of decay it has not had. Whether manage-by is due is a
 *  deadline about TODAY, so it is today's whatever the figures are from (#380, F5). */
function scheduleOf(
  row: PositionRow, cost: number | null, figuresDte: number, dte: number, settings: Settings,
): (ExitLevels & { dte_at_open: number }) | null {
  if (row.opened_at === null) return null;
  const openedDte = dteAtOpen(row.strike_date, row.opened_at);
  // exitPolicy, not a fourth hand-built copy of the same three knobs — the sweeper and the bot
  // already read the policy through it
  const policy = exitPolicy(settings);
  const levels = exitLevels(row.entry, openedDte, figuresDte, policy, cost);
  return levels === null ? null
    : { dte_at_open: openedDte, ...levels, manage_by_due: dte <= policy.manageByDte };
}

/** Every holding still held, each valued live from ONE batch or from its latest close.
 *
 *  Throws if the batch fails IN THE SESSION: whether that is a 502 or a sentence in a Telegram reply
 *  is the caller's business, not this module's. Out of it a failed batch dashes the holdings valued
 *  live, each with the failure's message, and serves the rest from their closes (#387). No batch is
 *  asked for where nothing is valued live.
 */
export async function holdingValues(
  db: DatabaseSync, fetchQuotes: QuoteFetcher, now: Date, settings: Settings, tz: string,
): Promise<{ values: HoldingValue[] }> {
  // what is HELD: a closed holding is kept with its history but valued no longer, and must not
  // widen the batch for contracts nobody holds (ADR 0022)
  const rows = openPositions(db);
  if (rows.length === 0) return { values: [] };

  const positions = rows.map(toPosition);
  const closes = rows.map((row) => closeOf(db, row, now));
  const live = positions.filter((_, i) => closes[i] === null);
  let byCode: ByCode = {};
  let unpriced: string | null = null;
  if (live.length > 0) {
    const codes = [...new Set(live.flatMap((p) => positionLegCodes(p)))].sort();
    // only the CALL is caught: a fault of this service's own past it is no Provider's, and must not
    // be said as "moomoo call failed" (#387 review)
    let records: QuoteRecord[] | null = null;
    try {
      ({ records } = await fetchQuotes(codes));
    } catch (err) {
      // in the session the batch is the price, and its failure is the whole answer's; out of it the
      // holdings it would have priced are dashes with the reason, and the closes still stand (#387)
      if (inSession(now)) throw err;
      unpriced = err instanceof Error ? err.message : String(err);
    }
    if (records !== null) byCode = displayRecords(records, tz, now);
  }
  const batchSpx = derivedSpx(Object.values(byCode));
  const batchSize = contractSize(byCode);

  return {
    values: rows.map((row, i): HoldingValue => {
      const position = positions[i]!;
      const close = closes[i]!;
      const dte = daysToExpiry(row.strike_date, now);
      if (close === null) {
        const cost = costToClose(position, byCode);
        return {
          row, position, cost, pnl: pnlAt(position, cost, batchSize),
          captured: captured(position.entry, cost),
          schedule: scheduleOf(row, cost, dte, dte, settings), dte,
          valuedFrom: "live", unpriced, close: null, records: byCode, spx: batchSpx,
          contractSize: batchSize, figuresDte: dte,
        };
      }
      const cost = close.cost_to_close;
      return {
        row, position, cost, pnl: pnlAt(position, cost, close.contract_size),
        captured: captured(position.entry, cost),
        schedule: scheduleOf(row, cost, close.dte, dte, settings), dte,
        valuedFrom: "close", unpriced: null, close, records: closeRecords(position, close),
        spx: { price: close.spx, reason: close.spx === null ? NO_CLOSE_SPX : null },
        contractSize: close.contract_size, figuresDte: close.dte,
      };
    }),
  };
}
