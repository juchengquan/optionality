/** The reference path: one bounded call of its own, and a degrade the sweep cannot afford (ADR 0018).
 *
 *  A Reference is a Security kept on the page to read the market by. It never alarms, nothing is
 *  derived from it, and no rule reads one — so this module reads the database, makes ONE call, and
 *  answers. It writes nothing: a Reference is never auto-disabled, never notified and never
 *  deleted, because its absence is not an event.
 *
 *  Why it does not share `/quotes`' batch, though that would cost no extra call: moomoo rejects a
 *  whole batch for one bad code, and the containment loop in `opend/client.ts` drops only a code
 *  moomoo NAMES — a class refusal names no culprit and is re-thrown, deliberately, so that an
 *  outage cannot present as a watchlist full of unknown contracts. `US..SPX` is exactly that
 *  refusal and it is the first thing a reasonable person types. In the sweep's batch it would kill
 *  every sweep every fifteen seconds and take the real alarms dark (#175's shape); in `/quotes`'
 *  batch it would blank the whole watchlist. The watchlist is what the owner acts on, and a
 *  backdrop must never be able to blank it.
 *
 *  Which is also why NOTHING here throws. A Provider that is wholly down leaves every Reference a
 *  dash with the Provider's own sentence beside it, and the route answers 200 — the one surface on
 *  this dashboard that cannot fail, because the page it decorates must still draw.
 */
import type { DatabaseSync } from "node:sqlite";

import { listReferences } from "./db/queries/index.ts";
import { referenceFigure } from "optionality/domain/reference";
import type { Quote } from "optionality/domain/quote";
import type { QuoteFetcher } from "optionality/quotes";

/** One Reference, ready to draw: no arithmetic left for the client and no reason left unsaid. */
export interface ReferenceEntry {
  id: string;
  code: string;
  /** what to call it, or null for "the code is its own name" */
  label: string | null;
  /** the vendor that answered, which the strip SHOWS: a figure from outside the Provider is
   *  allowed precisely because it says where it came from (ADR 0019). */
  source: string;
  /** the Security's own name, as the Provider gives it; null where no quote arrived */
  name: string | null;
  figure: number | null;
  /** which field the figure came from, so the page can say which number it is showing */
  field: string | null;
  change: number | null;
  /** why there is no figure, or null. A dash on the page and nothing more: never a notice, never
   *  a quarantine, never a deletion. */
  error: string | null;
  /** Whether the figure came from the vendor's DELAYED tier — a fact about the subscription, not
   *  about today. Null where the vendor said nothing: moomoo reports no grade at all, and false
   *  would read as "it told us this is live" (ADR 0019). */
  delayed: boolean | null;
  /** Whether the vendor is serving the most recent value it holds rather than an updating one.
   *  Null for the same reason. */
  last_known: boolean | null;
  /** How late, in minutes, where the vendor STATES it. Yahoo reports `exchangeDataDelayedBy`;
   *  IBKR reports a tier and no duration, so the strip says "15m late" for one and "delayed" for
   *  the other — each what its vendor actually said. */
  delayed_by_minutes: number | null;
}

/** What one attempt at the whole list came back with, by code. */
interface Fetched {
  quotes: Record<string, Quote>;
  /** code -> why it has no quote. Three different answers, kept apart because they send a reader
   *  to three different places: a code the Provider does not know is a typo, a refusal is the
   *  Provider's own sentence, and a silent omission is neither. */
  faults: Record<string, string>;
}

/** A vendor's own claim about freshness, or null where it made none. Null and false are
 *  different: false means the vendor said the figure is live. */
function flag(quote: Quote | null, key: string): boolean | null {
  const value = quote?.[key];
  return typeof value === "boolean" ? value : null;
}

/** Why a Reference has no figure, in the words of the vendor it actually asked.
 *
 *  These said "the Provider" until 2026-11-08, which ADR 0019 had already made untrue: a
 *  Reference may name a vendor the rest of the service does not use, so a Yahoo symbol Yahoo does
 *  not carry reported a Provider that was never asked. It is the third time this service has
 *  blamed one vendor for another's answer — ADR 0018 corrected `verifyContracts`, and the
 *  sweeper's degraded default was corrected for the same reason — and the fix is the same each
 *  time: the sentence takes the name from whoever was asked.
 */
const unknownCode = (source: string) => `${source} does not know this code`;
const noQuote = (source: string) => `${source} returned no quote for it`;

/** The vendors this build can actually reach, by name.
 *
 *  Not every name `SOURCES` knows: a source is reachable when a client for it exists, and a
 *  Reference naming one that does not gets a dash with that sentence rather than a blank. The
 *  registry is assembled by the caller, which is how a Reference can be served by a vendor that
 *  is NOT the Provider (ADR 0019) without this module knowing what a Provider is.
 */
export type Sources = Readonly<Record<string, QuoteFetcher>>;

/** A source this build cannot reach at all. Exported because `routes/references.ts` refuses a
 *  creation with the same sentence, and two copies of one wording drift. */
export const noClient = (source: string) => `no ${source} client in this build`;
const NO_PRICE = "the quote carries no price";

/** One bounded batch, and on a THROW one call per Reference.
 *
 *  Bounded by the number of References, which is the whole reason the retry lives here rather than
 *  in the shared `batch()`: there a persistently refused code would mean eight calls every fifteen
 *  seconds — worse than failing, and a risk to the sweep watchdog. This path can afford what the
 *  sweep cannot, because nothing waits on it.
 *
 *  A batch that ANSWERED is never retried, however much of it is unknown: an unknown code is an
 *  answer, and asking again would spend a call to be told the same thing.
 */
async function fetchAll(codes: string[], fetch: QuoteFetcher, source: string): Promise<Fetched> {
  const quotes: Record<string, Quote> = {};
  const faults: Record<string, string> = {};
  const take = (records: Quote[], unknown: string[]) => {
    for (const record of records) quotes[String(record.code)] = record;
    // the vendor that was asked, which is what the strip shows beside the dash
    for (const code of unknown) faults[code] = unknownCode(source);
  };
  try {
    const batch = await fetch(codes);
    take(batch.records, batch.unknown);
  } catch {
    for (const code of codes) {
      try {
        const one = await fetch([code]);
        take(one.records, one.unknown);
      } catch (err) {
        // the Provider's own sentence, because it is what distinguishes a gateway that could not be
        // reached from one that answered and declined the security — the same distinction ADR 0018
        // corrected in `verifyContracts`
        faults[code] = err instanceof Error ? err.message : String(err);
      }
    }
  }
  return { quotes, faults };
}

/** Every Reference with its live figure, in the order they were added.
 *
 *  Takes the port rather than `Deps` so that it can be exercised without an app, as
 *  `watchlistQuotes` is.
 */
export async function referenceReadings(
  db: DatabaseSync, sources: Sources,
): Promise<ReferenceEntry[]> {
  const rows = listReferences(db);
  // no call at all for an empty list: the dashboard polls this every 15 seconds per open tab, and
  // a call that can buy nothing is one ADR 0010 says is not free
  if (rows.length === 0) return [];

  // ONE bounded call per source in use, not per Reference — three figures from one vendor are one
  // call (ADR 0019). Grouped and run together rather than in series: the dashboard waits on this,
  // and a logged-out gateway's timeout should not be added to a healthy vendor's latency.
  const bySource = new Map<string, string[]>();
  for (const row of rows) {
    const codes = bySource.get(row.source) ?? [];
    codes.push(row.code);
    bySource.set(row.source, codes);
  }

  const quotes: Record<string, Quote> = {};
  const faults: Record<string, string> = {};
  await Promise.all([...bySource].map(async ([source, codes]) => {
    const fetch = sources[source];
    if (!fetch) {
      // containment between sources: a vendor with no client takes its own rows down and nobody
      // else's. The same argument that gave References a call of their own, one level up.
      for (const code of codes) faults[code] = noClient(source);
      return;
    }
    const got = await fetchAll(codes, fetch, source);
    Object.assign(quotes, got.quotes);
    Object.assign(faults, got.faults);
  }));
  return rows.map((row) => {
    const quote = quotes[row.code] ?? null;
    const reading = referenceFigure(quote);
    const fault = faults[row.code] ?? (quote ? null : noQuote(row.source));
    return {
      id: row.id,
      code: row.code,
      label: row.label,
      source: row.source,
      name: quote && typeof quote.name === "string" ? quote.name : null,
      ...reading,
      // read off the quote rather than decided here: the vendor says which tier it served, and a
      // configured guess would be a label saying what was hoped for (ADR 0019)
      delayed: flag(quote, "delayed"),
      last_known: flag(quote, "last_known"),
      delayed_by_minutes: typeof quote?.delayed_by_minutes === "number"
        ? quote.delayed_by_minutes : null,
      // a quote that arrived with no price is its own answer, and a different one from no quote:
      // 0/0 is an empty book, which is the Security not being quoted yet rather than unknown
      error: fault ?? (reading.figure === null ? NO_PRICE : null),
    };
  });
}
