/** Fetching live quotes, and surviving a contract moomoo has never heard of (ADR 0009, phase 5).
 *
 *  The fetcher is a port. One worker thread owns run execution, and the sweep, `/spx/quote`,
 *  `/quotes` and the creation probes make single bounded OpenD calls outside that queue — those are
 *  documented exceptions, not violations (CLAUDE.md). What goes here is the part that is logic
 *  rather than transport, so it can be tested without an OpenD at all.
 */
import type { Quote } from "./domain/quote.ts";
import { displayTime, marketTimeToDisplay } from "./timefmt.ts";

/** One contract's live figures as moomoo returns them. The same shape the domain reads, so a
 *  record can go straight from a fetch into cost_to_close without being reshaped. */
export type QuoteRecord = Quote;

/** A bounded batch call to OpenD. Phase 6 supplies the real one. */
export type QuoteFetcher = (codes: string[]) => Promise<QuoteRecord[]>;

/** moomoo names the offending contract in the error text, which is what makes containment safe. */
const UNKNOWN_CODE = /Unknown stock\.?\s+([A-Z0-9.]+)/;

export interface ResilientResult {
  records: QuoteRecord[];
  /** codes moomoo rejected as unknown, dropped from the batch */
  bad: string[];
}

/** Batch snapshot that survives unknown contracts.
 *
 *  moomoo rejects the WHOLE batch when any code is unknown, naming the culprit; we drop it and
 *  retry so one bad contract cannot take the watchlist hostage. Any other error — connection,
 *  quota — is re-thrown untouched: containment engages only on the deterministic named-culprit
 *  case, because retrying a connection failure one code at a time would hide an outage as a
 *  watchlist full of unknown contracts.
 */
export async function fetchResilient(
  codes: string[], fetch: QuoteFetcher,
): Promise<ResilientResult> {
  let remaining = [...codes];
  const bad: string[] = [];
  while (remaining.length > 0) {
    try {
      return { records: await fetch(remaining), bad };
    } catch (err) {
      const match = UNKNOWN_CODE.exec(String(err instanceof Error ? err.message : err));
      if (!match) throw err;
      const culprit = match[1]!.replace(/\.+$/, "");
      // moomoo may name the code with or without its market prefix
      const hits = remaining.filter((c) => c === culprit || c.endsWith(culprit));
      if (hits.length === 0) throw err; // cannot map the culprit to our codes: a generic failure
      remaining = remaining.filter((c) => !hits.includes(c));
      bad.push(...hits);
    }
  }
  return { records: [], bad };
}

/** An error message unless every code is a verified, existing contract.
 *
 *  Strict on purpose: creation is gated by a live probe, and it rejects while OpenD is down
 *  (CLAUDE.md). A monitor created against a contract that does not exist would quarantine itself on
 *  the first sweep, which is a worse way to find out.
 */
export async function verifyContracts(
  codes: string[], fetch: QuoteFetcher,
): Promise<string | null> {
  let result: ResilientResult;
  try {
    result = await fetchResilient(codes, fetch);
  } catch (err) {
    return `cannot verify contract: OpenD unreachable (${err instanceof Error ? err.message : String(err)})`;
  }
  if (result.bad.length > 0) {
    return `contract does not exist: ${result.bad.join(", ")} — check strike and expiry`;
  }
  const returned = new Set(result.records.map((r) => r.code));
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
