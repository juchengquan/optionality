/** One contract's live figures, as the sweep caches them (ADR 0009).
 *
 *  Values are `unknown` rather than `string | number | null` because moomoo sends booleans too
 *  (`suspension`) and has no published schema — it is a wire format, not a type. Everything that
 *  reads a field coerces it explicitly, which is also what the Python does: `total += sign * value`
 *  on a bool gives 1 there as `Number(true)` does here.
 */
import { displayTime, marketTimeToDisplay } from "./timefmt.ts";

export type Quote = Record<string, unknown>;
export type ByCode = Record<string, Quote>;

/** What one bounded batch came back with: the quotes, and the codes the Provider does not know.
 *
 *  Here rather than in `quotes.ts` since ADR 0017, because the two pure functions below answer in
 *  terms of it and the port that produces it is not pure. The Provider reports an unknown contract
 *  this way instead of throwing: a throw is for a Provider that could not answer at all, which is
 *  an outage and must never read as a watchlist full of unknown contracts (ADR 0015).
 */
export interface Batch {
  records: Quote[];
  unknown: string[];
}

/** A points figure derived from quotes, rounded for a human.
 *
 *  4dp: a credit is quoted in points to two or three places, and rounding is only to keep float
 *  noise (7.4999999999999964) out of a figure the owner reads back or that is stored as an entry.
 */
export function round4(value: number): number {
  return Number(value.toFixed(4));
}

/** Index a batch's records by code, with display-tz timestamps stamped on.
 *
 *  Copies rather than mutates: the sweeper's cached records get rendered on every dashboard poll,
 *  and `marketTimeToDisplay` is not idempotent — feeding its own output back in would read the
 *  offset as part of a new naive time.
 *
 *  Moved in from `quotes.ts` by ADR 0017: it is pure, four service paths use it, and the Python had
 *  never had it at all. `fetched_at` is the honest "data as-of"; `update_time` is only the last
 *  trade (CLAUDE.md).
 */
export function displayRecords(
  records: Quote[], displayTz: string, fetchedAt: Date | null,
): ByCode {
  const stamped = displayTime(fetchedAt, displayTz);
  const byCode: ByCode = {};
  for (const raw of records) {
    const record = { ...raw };
    if (record.update_time) {
      record.update_time = marketTimeToDisplay(String(record.update_time), displayTz);
    }
    record.fetched_at = stamped;
    byCode[String(record.code)] = record;
  }
  return byCode;
}

/** Why these contracts cannot be trusted to exist, or null.
 *
 *  The decision half of `quotes.verifyContracts`, which is otherwise a fetch and a catch. Strict on
 *  purpose: creation is gated by a live probe and rejects while the Provider is down (CLAUDE.md),
 *  because a monitor created against a contract that does not exist would quarantine itself on the
 *  first sweep — a worse way to find out.
 *
 *  BOTH checks, though a code named unknown usually has no record either: a Provider that does both
 *  at once is contradicting itself, and a gate this strict takes the pessimistic reading.
 */
export function verifyVerdict(codes: string[], batch: Batch): string | null {
  if (batch.unknown.length > 0) {
    return `contract does not exist: ${batch.unknown.join(", ")} — check strike and expiry`;
  }
  const returned = new Set(batch.records.map((r) => r.code));
  const missing = codes.filter((c) => !returned.has(c));
  if (missing.length > 0) {
    return `contract does not exist: ${missing.join(", ")} — check strike and expiry`;
  }
  return null;
}
