/** A watched rule's last known figure, out of the session (#380, F8).
 *
 *  Out of hours moomoo quotes every option bid 0 / ask 0, which is no price (`midPrice`), so `/quotes`
 *  serves a price rule no figure and the page draws a dash. A watched spread has no daily sample to
 *  fall back on as a holding has, so the page says instead what the sweep last read for the rule —
 *  `/monitors`' `last_value` — and when (`last_checked_at`), beside the dash and never in its place:
 *  "no figure out of session; last 3.05 at Fri 13 Nov 16:14", on New York's clock as the
 *  market-closed line names the close. The bell and the fill bar are the service's
 *  and are not drawn from it.
 *
 *  **Only a reading taken IN the session is shown.** Before #380's first part the sweep took a 0/0
 *  quote for a mid of 0 and stored it, and three price rules still hold that 0.0 until the first
 *  sweep in the session reads them again (the sweep now holds a price rule with no book, leaving its
 *  last value alone). A 0 read at 01:47 on a Saturday is not a figure, and nothing tells it from
 *  a real 0 but when it was read, so a reading from outside the session — the only hours that 0 can
 *  have come from — is not presented at all. A real figure read out of hours is still on the row:
 *  a rule on a greek has one, since moomoo serves greeks out of hours, and needs nothing from here.
 */
import type { Entry, Monitor } from "./shared/api";
import { inSession, servedInstant } from "./session";

export interface LastKnown {
  value: number;
  /** when the sweep read it, as the service served it (DISPLAY_TZ, with its offset) */
  at: string;
}

/** The rule's last known figure, or null: in the session, where the row has its own figure, where
 *  the sweep never read one, or where it was read out of the session. */
export function lastKnown(entry: Entry, monitor: Monitor | undefined, session: boolean): LastKnown | null {
  if (session || entry.watched !== null || monitor === undefined) return null;
  const value = monitor.last_value;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const at = servedInstant(monitor.last_checked_at);
  if (at === null || !inSession(at)) return null;
  return { value, at: monitor.last_checked_at! };
}

/** The watchlist's rows with each one's last known figure beside it (`lastKnown`). */
export function withLastKnown(quotes: readonly Entry[], monitors: readonly Monitor[], session: boolean): Entry[] {
  const byId = new Map(monitors.map((m) => [m.id, m]));
  return quotes.map((e) => ({ ...e, last_reading: lastKnown(e, byId.get(e.id), session) }));
}
