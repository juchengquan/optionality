/** The HTTP layer's one door: the app as a value, and the bag of things its routes need.
 *
 *  Behind it: `app.ts` (the routes mounted, the auth, `/docs`), `routes/` (one module per
 *  resource), `deps.ts`, `errors.ts` (the failure shape the dashboard already parses),
 *  `validate.ts` (validation that answers the way FastAPI did) and `openapi.ts`. `main.ts` and the
 *  test harness are the only things outside that want any of it, and both want exactly these two
 *  names.
 *
 *  This seam is the weakest of the three `check-seams` holds, and that is worth writing down
 *  rather than dressing up. `vendors/` has an incident behind it — IB Gateway allows one
 *  connection per client id and a second displaces the first in silence — and `engine/` closes a
 *  mutation that survived a sweep. For this one I could not name a failure it prevents: the bot
 *  speaks no HTTP, nothing outside mounts a route, and `errors.ts` and `validate.ts` were already
 *  imported by `routes/` and nothing else. It is here because the HTTP layer was eleven files
 *  across two levels and is now one directory, and because the rule costs a line in `SEAMS` once
 *  the directory exists. If it ever starts costing more than that, it has less to defend itself
 *  with than its two siblings.
 *
 *  `ports.ts` is deliberately NOT in here, and the reason is a measurement rather than a
 *  preference: `bot/bot.ts`, `engine/health.ts` and `vendors/index.ts` all import it. It is the
 *  service's interface vocabulary, not the HTTP layer's, and moving it in would have made three
 *  non-HTTP callers reach through this door for a type.
 *
 *  `hc.types.ts` sits inside because it is about the API's shape, and it is imported by nothing at
 *  all — `tsc` reads it and that is the point of it (see `hc.types.test.ts`, which holds it to
 *  every endpoint).
 */
export { createApp, type AppType } from "./app.ts";
export type { Deps } from "./deps.ts";
