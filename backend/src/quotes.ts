/** The market-data port, and what the service does with what comes back (ADR 0009, phase 5).
 *
 *  A Provider is anything that answers `QuoteFetcher` (ADR 0015): the sweep, `/quotes`,
 *  `/positions/values` and the creation probes each make one bounded call through it, which are
 *  the documented exceptions the invariant names (CLAUDE.md). What goes here is logic rather than
 *  transport, so it can be tested without a Provider at all.
 *
 *  The port used to answer with records alone and THROW for a contract the Provider could not
 *  price — which left this module reading moomoo's error prose to find out which contract it was.
 *  That belonged to moomoo (`opend/client.ts` has it now): a Provider knows its own failures in
 *  its own terms, and what the service needs is the answer, not the sentence (#168).
 */
import { verifyVerdict, type Batch, type Quote } from "./domain/quote.ts";

export { displayRecords } from "./domain/quote.ts";

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
/** The port's answer. `domain/quote.ts` owns the shape, because the two pure functions that read
 *  it are cased and this module is not (ADR 0017). */
export type QuoteBatch = Batch;

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
  // everything but the fetch and the catch is `domain/quote.verifyVerdict`, which is cased
  return verifyVerdict(codes, batch);
}
