/** `/spx/quote` — one live quote for one contract (ADR 0009, phase 5).
 *
 *  Makes one bounded OpenD call directly, outside the worker queue: a single snapshot does not
 *  meaningfully compete with a run's QPS budget, and queueing it behind a minutes-long strategy scan
 *  would defeat its purpose. A documented exception, not a violation (CLAUDE.md).
 */
import { Hono } from "hono";
import { z } from "zod";

import { buildSpxCode } from "../domain/contract.ts";
import type { Deps } from "../deps.ts";
import { httpError } from "../errors.ts";
import { displayTime, marketTimeToDisplay } from "../domain/timefmt.ts";
import { documented } from "../openapi.ts";
import { valid } from "../validate.ts";

/** A query string carries strings, so the schema validates strings and the numbers are made in the
 *  handler. Coercing in the schema would change the INPUT type a typed client sees, which is why
 *  this service does it by hand. (The longer note lived in runs.ts, deleted with the run pipeline's
 *  endpoints in #118.) */
const QuoteQuery = z.object({
  strike_date: z.string(),
  option_type: z.enum(["CALL", "PUT"]),
  strike: z.string(),
});

const QuoteOut = z.object({
  code: z.string(),
  quote: z.record(z.string(), z.unknown()),
});

const quote = documented("One live quote for one SPX contract", { 200: QuoteOut }, [404, 502]);

export function spxRoutes(deps: Deps) {
  return new Hono().get("/quote", quote, valid("query", QuoteQuery), async (c) => {
    const { strike_date, option_type, strike } = c.req.valid("query");
    const asNumber = Number(strike);
    if (!Number.isFinite(asNumber)) throw httpError(422, `invalid strike: ${strike}`);

    let code: string;
    try {
      code = buildSpxCode(strike_date, option_type, asNumber);
    } catch (err) {
      throw httpError(422, `invalid strike_date: ${err instanceof Error ? err.message : String(err)}`);
    }

    let records: Record<string, unknown>[];
    try {
      records = await deps.fetchQuotes([code]);
    } catch (err) {
      throw httpError(502, `OpenD call failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (records.length === 0) throw httpError(404, `no data for ${code}`);

    // `record` rather than `snapshot`: this is moomoo's wire shape on the way in, and a Quote on
    // the way out. `quote` is the route descriptor, so the local cannot take that name.
    const record = { ...records[0]! };
    if (record.update_time) {
      record.update_time = marketTimeToDisplay(String(record.update_time), deps.settings.displayTz);
    }
    record.fetched_at = displayTime(deps.now(), deps.settings.displayTz);
    return quote.reply(c, 200, { code, quote: record });
  });
}
