/** The error shape the dashboard already parses (ADR 0009, phase 5).
 *
 *  FastAPI's HTTPException renders `{"detail": "..."}`, and the frontend reads `detail` on every
 *  failure path. Hono's own HTTPException renders a bare string body, so this is not a style
 *  choice: changing the shape would break every error message the dashboard shows.
 */
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export function httpError(status: ContentfulStatusCode, detail: string): HTTPException {
  return new HTTPException(status, {
    res: Response.json({ detail }, { status }),
  });
}

export const notFound = (what: string) => httpError(404, `${what} not found`);
