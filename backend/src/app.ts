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

export function createApp(deps: Deps) {
  const app = new Hono()
    .onError((err, c) => {
      // an HTTPException already carries the {"detail": ...} body the dashboard reads; anything
      // else is a bug, and must still answer in the shape the dashboard can show
      if ("getResponse" in err && typeof err.getResponse === "function") return err.getResponse();
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
