/** `/spreads` — a spread and its Monitors added in one step, all or nothing (#293, ADR 0023).
 *
 *  Not a resource of its own: what it writes are Positions and Monitors, which their own routes
 *  list, edit and delete. It exists because a condor and the rules that watch it are one decision
 *  for the owner and were four requests for the dashboard, and a refusal half way through left
 *  half a condor behind. What it decides, and in what order, is `create-spread.ts`'s.
 */
import { Hono } from "hono";
import { z } from "zod";

import { createSpreads, isSpreadFault } from "../../../create-spread.ts";
import { SpreadsIn } from "../../../schemas/spread.ts";
import type { Deps } from "../deps.ts";
import { httpError } from "../errors.ts";
import { documented } from "../openapi.ts";
import { valid } from "../validate.ts";

/** What was added, by id and name: the page reads the book afresh rather than an echo of it. */
const AddedOut = z.object({
  positions: z.array(z.object({ id: z.string(), name: z.string() })),
  monitors: z.array(z.object({ id: z.string(), code: z.string(), field: z.string() })),
});

const create = documented(
  "Add spreads, each held or watched, with their Monitors: all of it or none", { 201: AddedOut }, [409],
);

export function spreadRoutes(deps: Deps) {
  const adding = { db: deps.db, fetchQuotes: deps.provider.fetchQuotes, now: deps.now, newId: deps.newId };
  return new Hono().post("/", create, valid("json", SpreadsIn), async (c) => {
    const result = await createSpreads(adding, c.req.valid("json"));
    if (isSpreadFault(result)) throw httpError(result.status, result.message);
    return create.reply(c, 201, result);
  });
}
