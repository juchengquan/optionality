/** The service, as a value rather than a process.
 *
 *  Exported separately from main.ts so that tests can mount it without binding a port, and so
 *  that the frontend can take its types from it — `hc<AppType>` is the whole reason the backend
 *  is TypeScript at all (ADR 0009). Nothing is routed yet; phase 5 fills this in.
 */

export type AppType = {
  /** replaced in phase 5 by Hono's inferred route type */
  readonly placeholder: true;
};

export function createApp() {
  return { placeholder: true as const };
}
