import { inSession } from "./session";

/** LIVE and REVIEW, the two on-screen modes (ADR 0023), until #375 removes the switch.
 *
 *  Since #371 they decide neither what the page fetches nor what the needs-you line says: both
 *  follow New York's session (`session.ts`). What is left here is the switch's default — the
 *  clock's mode — and which views are drawn (the phone's pages, REVIEW's closed trades). Since
 *  #372 the desk's columns are one set at every hour, keyed by nothing.
 */
export type Mode = "live" | "review";

export function clockMode(now: Date): Mode {
  return inSession(now) ? "live" : "review";
}
