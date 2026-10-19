/** The service, as a value rather than a process (ADR 0009, phase 5).
 *
 *  Exported separately from main.ts so that tests can mount it without binding a port, and so that
 *  the frontend can take its types from it — `hc<AppType>` is the whole reason the backend is
 *  TypeScript at all. That is also why the app is built as one chained expression: Hono accumulates
 *  the route types along the chain, and a statement that re-assigns `app` loses them.
 */
import { Hono } from "hono";

import type { Deps } from "./deps.ts";
import { mountDocs } from "./openapi.ts";
import { healthRoutes } from "./routes/health.ts";
import { monitorRoutes, quoteRoutes } from "./routes/monitors.ts";
import { positionRoutes } from "./routes/positions.ts";
import { spxRoutes } from "./routes/spx.ts";

/** Paths reachable without a token. `/health` is open because whatever is checking on the service
 *  may be the thing that has lost its credentials, and because the dashboard reads it to find out
 *  whether it is talking to the API it was built against (ADR 0006). The docs are open because the
 *  page cannot hand a token to the fetch of its own spec, and the spec holds no data. */
const OPEN_PATHS = new Set(["/health", "/openapi.json", "/docs"]);

/** A refusal says so, once, with enough to find it.
 *
 *  2026-10-19: a holding would not record, and nothing on this side could tell whether the request
 *  had arrived at all — the {detail} body went back to the browser and the service said nothing.
 *  Splitting "the browser never sent it" from "the service refused it" took a hand-made probe
 *  against the live API.
 *
 *  Every refusal, and every WRITE whatever its status. The second half was added the same evening,
 *  after refusal logging alone proved too little: a press to record that spread still left no line
 *  and no row, and "the service refused nothing" read exactly like "the service was never asked".
 *  Only a line for the write itself splits those two, and it is the split that says whether the
 *  fault is in the browser or here.
 *
 *  Reads that succeed stay silent, and they are the flood: the dashboard polls every 15 seconds per
 *  open tab, so a line per GET would bury the one line that matters under thousands that do not.
 *  Writes are owner-initiated and rare — a handful a day — so each one costs nothing to keep. This
 *  log is read by eye during an incident.
 */
function sayRequest(method: string, path: string, status: number, detail: string): void {
  const line = `${method} ${path} → ${status}${detail ? ` ${detail}` : ""}`;
  // a refused request is the one being hunted; a write that worked is context around it
  if (status >= 400) console.error(line); else console.log(line);
}

export function createApp(deps: Deps) {
  const app = new Hono()
    .use("*", async (c, next) => {
      await next();
      // ONE place for both kinds. A handler that RETURNS a refusal — `valid()`'s 422, the 401
      // below — never reaches onError at all; a handler that THROWS one does, and onError's
      // response then comes back out through this same await. Logging in both logged the thrown
      // ones twice, which a test caught after a mutation sweep showed the thrown path was, until
      // then, exercised by nothing.
      const refused = c.res.status >= 400;
      if (!refused && c.req.method === "GET") return;
      let detail = "";
      // only when something went wrong: a created Position's body is its whole shape, and the
      // reason to log a write at all is that it happened, not what it returned
      if (refused) {
        try {
          detail = (await c.res.clone().text()).slice(0, 200);
        } catch {
          /* a body that cannot be read twice is not worth failing a request over */
        }
      }
      sayRequest(c.req.method, c.req.path, c.res.status, detail);
    })
    .onError((err, c) => {
      // an HTTPException already carries the {"detail": ...} body the dashboard reads; anything
      // else is a bug, and must still answer in the shape the dashboard can show
      if ("getResponse" in err && typeof err.getResponse === "function") return err.getResponse();
      // the stack, which the one-line refusal above cannot carry and a bug needs
      console.error("unhandled error:", err);
      return c.json({ detail: "internal error" }, 500);
    })
    .use("*", async (c, next) => {
      const token = deps.settings.apiToken;
      if (token && !OPEN_PATHS.has(c.req.path)
        && c.req.header("Authorization") !== `Bearer ${token}`) {
        return c.json({ detail: "unauthorized" }, 401);
      }
      return next();
    })
    // The run pipeline's routes — /runs, /configs, /schedules, fifteen endpoints — were mounted
    // here until #118, and its machinery (the worker, the cron schedules, the four tables,
    // /health's queue and last run) until phase 10 (ADR 0014). Two runs in the service's life,
    // both by hand on 2026-08-10, zero schedules ever. Do not put any of it back without asking.
    .route("/", healthRoutes(deps))
    .route("/", quoteRoutes(deps))
    .route("/monitors", monitorRoutes(deps))
    .route("/positions", positionRoutes(deps))
    .route("/spx", spxRoutes(deps));
  // after every other route, because the spec is generated from the routes already registered;
  // and not part of the chain, so `AppType` stays the API's alone
  mountDocs(app, deps.settings.rootPath, OPEN_PATHS);
  return app;
}

/** What `hc` on the frontend is parameterised by. */
export type AppType = ReturnType<typeof createApp>;
