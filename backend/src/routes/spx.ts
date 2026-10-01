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
import { displayTime, marketTimeToDisplay } from "../timefmt.ts";
import { valid } from "../validate.ts";

/** A query string carries strings, so the numbers are made here — see runs.ts for why the schema
 *  cannot do the coercion without making every parameter required of a typed client. */
const QuoteQuery = z.object({
  strike_date: z.string(),
  option_type: z.enum(["CALL", "PUT"]),
  strike: z.string(),
});

const QuoteOut = z.object({
  code: z.string(),
  snapshot: z.record(z.string(), z.unknown()),
});

export function spxRoutes(deps: Deps) {
  return new Hono().get("/quote", valid("query", QuoteQuery), async (c) => {
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

    const snapshot = { ...records[0]! };
    if (snapshot.update_time) {
      snapshot.update_time = marketTimeToDisplay(String(snapshot.update_time), deps.settings.displayTz);
    }
    snapshot.fetched_at = displayTime(deps.now(), deps.settings.displayTz);
    return c.json(QuoteOut.parse({ code, snapshot }), 200);
  });
}
