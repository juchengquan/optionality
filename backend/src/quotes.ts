/** The market-data port, and what the service does with what comes back (ADR 0009, phase 5).
 *
 *  A Provider is anything that answers `QuoteFetcher` (ADR 0015): the sweep, `/spx/quote`,
 *  `/quotes` and the creation probes each make one bounded call through it, which are the
 *  documented exceptions the invariant names (CLAUDE.md). What goes here is logic rather than
 *  transport, so it can be tested without a Provider at all.
 *
 *  The port used to answer with records alone and THROW for a contract the Provider could not
 *  price — which left this module reading moomoo's error prose to find out which contract it was.
 *  That belonged to moomoo (`opend/client.ts` has it now): a Provider knows its own failures in
 *  its own terms, and what the service needs is the answer, not the sentence (#168).
 */
import type { Quote } from "./domain/quote.ts";
import { displayTime, marketTimeToDisplay } from "./domain/timefmt.ts";

/** One contract's live figures as a Provider returns them. The same shape the domain reads, so a
 *  record can go straight from a fetch into cost_to_close without being reshaped. */
export type QuoteRecord = Quote;

/** What one bounded batch came back with: the quotes, and the codes that got none.
 *
 *  Both, because they are different answers and the caller treats them differently — a code with
 *  no quote may be an illiquid contract this minute, while a code the Provider does not recognise
 *  is a rule that will never fire again and is quarantined for it. A Provider that cannot price a
 *  contract reports it HERE rather than throwing: a throw is for a Provider that could not answer
 *  at all, which is an outage and must never read as a watchlist full of unknown contracts.
 */
export interface QuoteBatch {
  records: QuoteRecord[];
  /** codes the Provider answered about by saying it does not know them */
  unknown: string[];
}

/** One bounded batch call to a Provider. `opend/client.ts` has moomoo's. */
export type QuoteFetcher = (codes: string[]) => Promise<QuoteBatch>;

/** An error message unless every code is a verified, existing contract.
 *
 *  Strict on purpose: creation is gated by a live probe, and it rejects while OpenD is down
 *  (CLAUDE.md). A monitor created against a contract that does not exist would quarantine itself on
 *  the first sweep, which is a worse way to find out.
 */
export async function verifyContracts(
  codes: string[], fetch: QuoteFetcher,
): Promise<string | null> {
  let batch: QuoteBatch;
  try {
    batch = await fetch(codes);
  } catch (err) {
    return `cannot verify contract: OpenD unreachable (${err instanceof Error ? err.message : String(err)})`;
  }
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

/** Index records by code, with display-tz timestamps stamped on.
 *
 *  Copies rather than mutates: the sweeper's cached records get rendered on every dashboard poll,
 *  and marketTimeToDisplay is not idempotent — feeding its own output back in would read the
 *  offset as part of a new naive time.
 */
export function displayRecords(
  records: QuoteRecord[], displayTz: string, fetchedAt: Date,
): Record<string, QuoteRecord> {
  const stamped = displayTime(fetchedAt, displayTz);
  const byCode: Record<string, QuoteRecord> = {};
  for (const raw of records) {
    const record = { ...raw };
    if (record.update_time) {
      record.update_time = marketTimeToDisplay(String(record.update_time), displayTz);
    }
    // the honest "data as-of"; update_time is only the last trade (CLAUDE.md)
    record.fetched_at = stamped;
    byCode[String(record.code)] = record;
  }
  return byCode;
}
