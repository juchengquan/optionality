/** A watched rule's last known figure, out of the session (#380, F8).
 *
 *  While nothing trades moomoo quotes every option bid 0 / ask 0, which is no price (`midPrice`), so
 *  `/quotes` serves a price rule no figure and the page draws a dash. In the Curb and overnight (GTH)
 *  SPX options trade and are quoted live, so a row with a quote says it, and only one without says
 *  its last close (#416, `ValueCell`). The value cell says the row's last close
 *  where the service stored one (`last_close`, #402); for the rest, and for the sentence, the page
 *  says what the sweep last read for the rule —
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
import type { Entry, LastClose, Monitor } from "./shared/api";
import { DASH } from "./shared/format";
import { inSession, newYorkWeekdayWhen, servedInstant } from "./session";

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

/** The watchlist's rows with each one's last close joined (`/monitors/closes`, #402): null for a rule
 *  the closes do not name, which has none. */
export function withCloses(quotes: readonly Entry[], closes: readonly { id: string; last_close: LastClose | null }[]): Entry[] {
  const byId = new Map(closes.map((c) => [c.id, c.last_close]));
  return quotes.map((e) => ({ ...e, last_close: byId.get(e.id) ?? null }));
}

/** What a watchlist row's value cell says (#400, #416): the live price in the regular session; in
 *  the Curb and GTH the live price where the poll quotes one, and the last close where it does not;
 *  and while nothing trades — or while `/quotes` is failing — the last close. */
export type ValueCell = "live" | "live-or-close" | "close";

/** The watchlist's rows with each one's last known figure beside it (`lastKnown`), and the price
 *  its value cell says (#400): `price`, at every hour, and `last_price` wherever the cell says the
 *  last close instead — always out of the session, and in the Curb and GTH only for a row the poll
 *  has no price for (#416). */
export function withLastKnown(quotes: readonly Entry[], monitors: readonly Monitor[], cell: ValueCell): Entry[] {
  const byId = new Map(monitors.map((m) => [m.id, m]));
  const read = quotes.map((e) => ({ ...e, last_reading: lastKnown(e, byId.get(e.id), cell === "live") }));
  return read.map((e) => {
    const price = priceIn(e, read);
    const closed = cell === "close" || (cell === "live-or-close" && price === null);
    return { ...e, price, ...(closed ? { last_price: lastPriceIn(e, read) } : {}) };
  });
}

// ---- the value cell: always the price (#400)

/** The contracts a rule names, as a key two rules on one contract or one spread share: a contract
 *  by its code, a spread by its expiry and its legs, each with its sign and quantity — a price rule
 *  entered under the other leg convention would be the same spread's price negated. */
export function contractsKey(e: Pick<Entry, "code" | "strike_date" | "legs">): string {
  if (!e.legs || e.legs.length === 0) return e.code;
  const legs = e.legs.map((l) => `${l.sign}${l.option_type}${l.strike}x${(l as { qty?: number }).qty ?? 1}`).sort();
  return `${e.strike_date} ${legs.join(" ")}`;
}

/** A row's own price, from nothing but itself: a contract's mid; a spread's served value where its
 *  rule watches the value (`combo_value` is the rule's OWN field summed, so a delta rule's is its
 *  delta, which is never a price); and null otherwise. */
export function ownPrice(e: Entry): number | null {
  if (!e.legs || e.legs.length === 0) {
    const v = (e.quote as Record<string, unknown> | null)?.mid_price;
    return typeof v === "number" ? v : null;
  }
  return e.field === "mid_price" ? e.combo_value ?? null : null;
}

/** A row's price in this poll: its own (`ownPrice`), or, for a rule on something else — a delta
 *  rule on a spread — that of a price rule on the very same contracts in the same poll. Null where
 *  nothing served one: never a sum taken here. */
function priceIn(e: Entry, rows: readonly Entry[]): number | null {
  const own = ownPrice(e);
  if (own !== null || !e.legs || e.legs.length === 0) return own;
  const key = contractsKey(e);
  const twin = rows.find((r) => r.field === "mid_price" && contractsKey(r) === key && ownPrice(r) !== null);
  return twin ? ownPrice(twin) : null;
}

/** Out of the session, the row's last close where the service has one (#402): the stored history of
 *  the contracts it watches, its price under the rule's own signs (`last_close`) — the same close a
 *  watched spread's payoff is drawn at, and a figure a delta rule's spread has as well as its price
 *  rule's. Where none is stored, the last price read IN the session (#400): the price rule's on these
 *  contracts — the row's own, or another rule's on the same contracts — as `lastKnown` keeps it, so a
 *  reading taken out of the session is never one. Null where neither has one. */
function lastPriceIn(e: Entry, rows: readonly Entry[]): LastKnown | null {
  const close = e.last_close ?? null;
  if (close !== null) return { value: close.price, at: close.observed_at ?? "" };
  const key = contractsKey(e);
  const own = e.field === "mid_price" ? e.last_reading ?? null : null;
  if (own) return own;
  return rows.find((r) => r.field === "mid_price" && contractsKey(r) === key && r.last_reading)?.last_reading ?? null;
}

/** "4.12 (Fri 16:14)": a last in-session price with its time on New York's clock, as the page states
 *  times; a dash where there is none. */
export function lastPriceWords(last: LastKnown | null): string {
  if (last === null) return DASH;
  const when = newYorkWeekdayWhen(last.at);
  return `${last.value.toFixed(2)}${when ? ` (${when})` : ""}`;
}

/** The price a row's value cell says (#400), whatever the rule watches: the page's own `price`, or,
 *  where the page has not looked (a row built in a test), the row's own. */
export const priceOf = (e: Entry): number | null => e.price !== undefined ? e.price : ownPrice(e);

/** What a WATCHLIST row's value cell says out of the session: its last in-session price and when,
 *  or a dash; undefined in the session, where the cell says the live price as before. */
export function outOfHoursValue(e: Entry): string | undefined {
  return e.last_price === undefined ? undefined : lastPriceWords(e.last_price);
}
