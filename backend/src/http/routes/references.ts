/** `/references` — the Securities kept on the page to read the market by (ADR 0018, 0019).
 *
 *  Three doors and no more. There is no PATCH: a Reference is a code, a label and a source, and
 *  changing any of them is a different Reference — the figure would be about something else. There
 *  is no "disable": a Reference never alarms, so there is nothing to mute, and it is never
 *  auto-disabled, notified or deleted. Removing one stays the owner's decision, which is what
 *  DELETE is.
 *
 *  GET declares no failure status, which is deliberate and is the point of `references.ts`: this is
 *  the one surface on the dashboard that cannot fail, because the page it decorates must still
 *  draw. A Provider that is wholly down leaves every row a dash with its own sentence beside it.
 */
import { Hono } from "hono";
import { z } from "zod";

import type { Deps } from "../deps.ts";
import {
  deleteReferenceRow, findReference, findReferenceByCode, insertReference,
} from "../../db/queries/index.ts";
import type { ReferenceRow } from "../../db/rows.ts";
import { newId } from "../../db/values.ts";
import { toSqlDatetime } from "../../db/time.ts";
import { httpError, notFound } from "../errors.ts";
import { documented } from "../openapi.ts";
import { noClient, referenceReadings } from "../../references.ts";
import { verifyContracts } from "../../quotes.ts";
import { ReferenceIn } from "../../schemas/reference.ts";
import { valid } from "../validate.ts";

/** One Reference as it is STORED, which is what a write answers with: the live figure belongs to
 *  the list, where it costs one bounded call for all of them at once. */
const ReferenceOut = z.object({
  id: z.string(),
  code: z.string(),
  label: z.string().nullable(),
  /** the vendor that answers for this code, which the strip shows (ADR 0019) */
  source: z.string(),
  created_at: z.string(),
});

/** One Reference with its live figure — everything needed to draw it, and the reason when there is
 *  nothing to draw. */
const ReadingOut = ReferenceOut.omit({ created_at: true }).extend({
  /** the Security's own name as the Provider gives it, null where no quote arrived */
  name: z.string().nullable(),
  figure: z.number().nullable(),
  /** "mid_price" or "last_price": which number this is, so it can be checked against a broker
   *  screen. The mid leads because a last trade can be a session old (domain/reference.ts). */
  field: z.string().nullable(),
  /** the day's move as a FRACTION of the previous close */
  change: z.number().nullable(),
  /** why there is no figure, or null. A dash on the page and nothing more. */
  error: z.string().nullable(),
  /** the vendor's own claim about freshness, or null where it made none — moomoo reports no
   *  grade, and false would read as "it told us this is live" (ADR 0019) */
  delayed: z.boolean().nullable(),
  last_known: z.boolean().nullable(),
  /** minutes, where the vendor states them: Yahoo does, IBKR does not */
  delayed_by_minutes: z.number().nullable(),
});

const list = documented("Live figures for every Reference", { 200: z.array(ReadingOut) });
const create = documented("Keep a Security on the page", { 201: ReferenceOut }, [409]);
const remove = documented("Stop keeping a Security on the page", { 204: null }, [404]);

export function referenceRoutes(deps: Deps) {
  const { db } = deps;

  const out = (row: ReferenceRow) => ({
    id: row.id, code: row.code, label: row.label, source: row.source, created_at: row.created_at,
  });

  /** The vendors this build can reach, by name — assembled once by `vendors.openVendors`, the
   *  Provider among them. A source is reachable when a client for it EXISTS: handing a Reference
   *  a fetcher belonging to another vendor is the mutation that survived until the registry made
   *  the difference observable. */
  const { sources } = deps;

  return new Hono()
    .get("/", list, async (c) => list.reply(c, 200, await referenceReadings(db, sources)))

    .post("/", create, valid("json", ReferenceIn), async (c) => {
      const { code, label, source } = c.req.valid("json");
      // the database before the Provider, as `create-monitor.ts` does and for the same reason:
      // everything free comes before anything that costs a bounded call
      if (findReferenceByCode(db, code)) {
        throw httpError(409, `${code} is already kept on the page`);
      }
      // the same strict live probe that gates monitor creation: a Reference on a code nothing can
      // quote is a permanent dash, and finding that out at creation is better than on the page.
      // Both of its refusals are a 422 — "does not exist" and "the Provider did not confirm it",
      // which since ADR 0018 no longer claims an outage about a Provider that declined the
      // security. That is exactly what `US..SPX` gets, and it is why SPX is kept via SPY.
      // the probe goes to the NAMED vendor, not to the Provider: a code IBKR knows and moomoo
      // refuses is exactly why a Reference may name its own source (ADR 0019)
      const fetch = sources[source];
      // the same sentence `references.ts` puts on the strip for a configured source this build
      // cannot reach, from one definition rather than two that can drift apart
      if (!fetch) throw httpError(422, noClient(source));
      const why = await verifyContracts([code], fetch);
      if (why) throw httpError(422, why);
      const row: ReferenceRow = {
        id: newId(),
        code,
        label: label ?? null,
        source,
        created_at: toSqlDatetime(deps.now()),
      };
      return create.reply(c, 201, out(insertReference(db, row)));
    })

    .delete("/:id", remove, (c) => {
      const id = c.req.param("id");
      if (!findReference(db, id)) throw notFound("reference");
      // nothing links to a Reference — no rule reads one, and nothing is derived from one — so
      // there is no link table to clear first and no transaction to wrap this in
      deleteReferenceRow(db, id);
      return c.body(null, 204);
    });
}
