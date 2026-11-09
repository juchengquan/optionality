/** Yahoo as a Reference source (ADR 0019, track D).
 *
 *  The weakest link in this service, named as such in the ADR and worth repeating where someone
 *  will read it: every other data path has a vendor contract behind it, and this one is a client
 *  library working around a block. It is pinned to an exact version, it lives behind this one
 *  file, and it is EXPECTED to break. When it does, a Reference shows a dash with its reason and
 *  nothing else in the service notices — which is the whole reason this is only allowed for a
 *  figure nothing derives from.
 *
 *  ## Why the library rather than `fetch`
 *
 *  Measured on 2026-11-08: a plain Node `fetch` is refused with `429 Too Many Requests` from both
 *  hosts and every endpoint, and so is the cookie-then-crumb exchange that `curl` can manage. The
 *  library succeeds from the same Node process at the same minute. Two wrong conclusions were
 *  reached before that one — that Yahoo required authentication, and that it blocks on TLS
 *  fingerprinting because `yfinance` impersonates Chrome — and both are recorded in the ADR so
 *  nobody repeats them. What the library does that a hand-rolled flow does not is not understood,
 *  which is precisely why hand-rolling it would produce code that works until Yahoo changes
 *  something unannounced.
 *
 *  ## It needs no configuration
 *
 *  No host, no key, no login. So it is always available as a source and costs nothing until a
 *  Reference names it — one bounded call per source IN USE. Deleting the row is the off switch;
 *  there is no setting, because a setting would be a second thing to remember.
 */
import { type YahooQuote, toRecord } from "./fields.ts";
import type { Quote } from "../../domain/quote.ts";
import type { QuoteBatch } from "../../quotes.ts";

/** The library's one call this client makes, injectable so the suite never reaches Yahoo.
 *
 *  A test that reached the real endpoint would be a test that fails when a company it does not
 *  control changes something — the same rule that keeps the moomoo SDK out of every suite. */
export type YahooFetch = (symbols: string[]) => Promise<YahooQuote[]>;

let shared: YahooFetch | null = null;

/** The library, loaded once and lazily.
 *
 *  Lazily because importing it costs real time and pulls a dependency tree into the process, and
 *  a deployment with no Yahoo Reference should pay neither. Once, because its client holds a
 *  cookie jar and a crumb, and throwing those away per call would ask Yahoo for them per call.
 */
async function library(): Promise<YahooFetch> {
  if (shared) return shared;
  const { default: YahooFinance } = await import("yahoo-finance2");
  // the survey notice is a console banner aimed at a human running a script; this is a service
  const client = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
  shared = (symbols) => client.quote(symbols) as Promise<YahooQuote[]>;
  return shared;
}

/** One bounded call: figures for these codes, and which of them Yahoo does not carry.
 *
 *  An unknown symbol is OMITTED from the answer rather than refused — measured: asking for
 *  `NOTATICKER` returns `[]` with no error. So unknown is computed by difference, which is also
 *  how a code that was asked for and silently dropped is reported rather than lost.
 */
export function yahooFetcher(fetch?: YahooFetch) {
  return async (codes: string[]): Promise<QuoteBatch> => {
    if (codes.length === 0) return { records: [], unknown: [] };
    const ask = fetch ?? await library();
    const rows = await ask(codes);

    const byCode = new Map<string, Quote>();
    for (const row of rows) {
      // Yahoo echoes the symbol it understood, which is how a row is matched to the code that
      // asked for it — `^GSPC` comes back as `^GSPC`
      const symbol = typeof row.symbol === "string" ? row.symbol : "";
      if (symbol) byCode.set(symbol.toUpperCase(), toRecord(symbol, row));
    }

    const records: Quote[] = [];
    const unknown: string[] = [];
    for (const code of codes) {
      const record = byCode.get(code.toUpperCase());
      if (record) records.push({ ...record, code });
      else unknown.push(code);
    }
    return { records, unknown };
  };
}
