/** The service, as a value rather than a process (ADR 0009, phase 5).
 *
 *  Exported separately from main.ts so that tests can mount it without binding a port, and so that
 *  the frontend can take its types from it — `hc<AppType>` is the whole reason the backend is
 *  TypeScript at all. That is also why the app is built as one chained expression: Hono accumulates
 *  the route types along the chain, and a statement that re-assigns `app` loses them.
 */
import { Hono } from "hono";

import type { Deps } from "./deps.ts";
import { configRoutes } from "./routes/configs.ts";
import { healthRoutes } from "./routes/health.ts";
import { monitorRoutes, quoteRoutes } from "./routes/monitors.ts";
import { runRoutes } from "./routes/runs.ts";
import { scheduleRoutes } from "./routes/schedules.ts";

/** Paths reachable without a token. `/health` is open because whatever is checking on the service
 *  may be the thing that has lost its credentials, and because the dashboard reads it to find out
 *  whether it is talking to the API it was built against (ADR 0006). */
const OPEN_PATHS = new Set(["/health"]);

export function createApp(deps: Deps) {
  return new Hono()
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
    .route("/", healthRoutes(deps))
    .route("/", quoteRoutes(deps))
    .route("/configs", configRoutes(deps))
    .route("/schedules", scheduleRoutes(deps))
    .route("/runs", runRoutes(deps))
    .route("/monitors", monitorRoutes(deps));
}

/** What `hc` on the frontend is parameterised by. */
export type AppType = ReturnType<typeof createApp>;
