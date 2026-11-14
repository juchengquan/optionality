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

/** A market-data route whose one bounded call failed: 502, naming the Provider that failed.
 *
 *  502 rather than 500 because the fault is upstream — the service worked and the gateway did
 *  not. The NAME is the point of putting this here: both market-data routes wrote
 *  "OpenD call failed" whatever `OPTIONALITY_PROVIDER` said, and the dashboard prints this
 *  `detail` verbatim. ADR 0018 corrected the same leak in `verifyContracts`, and the sweeper's
 *  degraded default in `recordFailure`; two copies of the sentence is how it survived in a third
 *  place.
 */
export function providerFailed(name: string, err: unknown): HTTPException {
  return httpError(502, providerFailedWords(name, err));
}

/** The sentence alone, for where a failed call is said beside the figures rather than as the
 *  answer: out of the session `/positions/values` serves the closes and gives each holding the
 *  call would have priced this as its `valued_reason` (#387). One sentence, so the two cannot drift. */
export function providerFailedWords(name: string, err: unknown): string {
  return `${name} call failed: ${err instanceof Error ? err.message : String(err)}`;
}
