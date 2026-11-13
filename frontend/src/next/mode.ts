import { inSession } from "./session";

/** LIVE and REVIEW, the two on-screen modes (ADR 0023), until #375 removes the switch.
 *
 *  Since #371 they decide neither what the page fetches nor what the needs-you line says: both
 *  follow New York's session (`session.ts`). What is left here is the switch's default — the
 *  clock's mode — and the type the two column sets are keyed by.
 */
export type Mode = "live" | "review";

export function clockMode(now: Date): Mode {
  return inSession(now) ? "live" : "review";
}
