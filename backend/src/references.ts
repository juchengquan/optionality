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

import { listReferences } from "./db/queries.ts";
import { referenceFigure } from "./domain/reference.ts";
import type { Quote } from "./domain/quote.ts";
import type { QuoteFetcher } from "./quotes.ts";

/** One Reference, ready to draw: no arithmetic left for the client and no reason left unsaid. */
export interface ReferenceEntry {
  id: string;
  code: string;
  /** what to call it, or null for "the code is its own name" */
  label: string | null;
  /** what its figure is multiplied by, or null for ×1. Published, because the strip shows the
   *  ARITHMETIC — `SPX (via SPY ×10) → 7587` — and never claims to be the index. */
  scale: number | null;
  /** the Security's own name, as the Provider gives it; null where no quote arrived */
  name: string | null;
  figure: number | null;
  /** which field the figure came from, so the page can say which number it is showing */
  field: string | null;
  change: number | null;
  /** why there is no figure, or null. A dash on the page and nothing more: never a notice, never
   *  a quarantine, never a deletion. */
  error: string | null;
}

/** What one attempt at the whole list came back with, by code. */
interface Fetched {
  quotes: Record<string, Quote>;
  /** code -> why it has no quote. Three different answers, kept apart because they send a reader
   *  to three different places: a code the Provider does not know is a typo, a refusal is the
   *  Provider's own sentence, and a silent omission is neither. */
  faults: Record<string, string>;
}

const UNKNOWN = "the Provider does not know this code";
const SILENT = "the Provider returned no quote for it";
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
async function fetchAll(codes: string[], fetch: QuoteFetcher): Promise<Fetched> {
  const quotes: Record<string, Quote> = {};
  const faults: Record<string, string> = {};
  const take = (records: Quote[], unknown: string[]) => {
    for (const record of records) quotes[String(record.code)] = record;
    for (const code of unknown) faults[code] = UNKNOWN;
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
  db: DatabaseSync, fetch: QuoteFetcher,
): Promise<ReferenceEntry[]> {
  const rows = listReferences(db);
  // no call at all for an empty list: the dashboard polls this every 15 seconds per open tab, and
  // a Provider call that can buy nothing is one ADR 0010 says is not free
  if (rows.length === 0) return [];

  const { quotes, faults } = await fetchAll(rows.map((r) => r.code), fetch);
  return rows.map((row) => {
    const quote = quotes[row.code] ?? null;
    const reading = referenceFigure(quote, row.scale);
    const fault = faults[row.code] ?? (quote ? null : SILENT);
    return {
      id: row.id,
      code: row.code,
      label: row.label,
      scale: row.scale,
      name: quote && typeof quote.name === "string" ? quote.name : null,
      ...reading,
      // a quote that arrived with no price is its own answer, and a different one from no quote:
      // 0/0 is an empty book, which is the Security not being quoted yet rather than unknown
      error: fault ?? (reading.figure === null ? NO_PRICE : null),
    };
  });
}
