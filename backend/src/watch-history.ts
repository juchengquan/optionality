/** A watched set of contracts' history, read (#402): what the sweep stored for the contracts a rule
 *  watches, priced the way its reader prices them.
 *
 *  The rows (`watch_samples`, migration 0014) are keyed by the CONTRACTS — sorted codes, no signs, no
 *  quantities — and carry each contract's mid rather than any one structure's value. So every value
 *  here is worked out when it is read, by the domain's own functions:
 *
 *  - **a rule's** under its own signs and quantities, as the sweep values it (`monitorValue` on the
 *    price): what its history charts and what `/quotes`' `last_close` says;
 *  - **a holding's** by SIDE, as `costToClose` values a holding — never from a combo's signs, which
 *    are a convention (`costToCloseOf`'s reason): the "before entry" days of its burndown.
 *
 *  None of it asks a Provider anything: stored history, read when asked.
 */
import type { DatabaseSync } from "node:sqlite";

import {
  closeSample, inSession, marketDate, sampleTiming, valuedTiming, type SampleTiming, type ValuedTiming,
} from "optionality/domain/expiry";
import { buildSpxCode } from "optionality/domain/contract";
import { monitorLegCodes, monitorValue, type Monitor } from "optionality/domain/monitor";
import { costToClose, positionLegCodes, type ByCode, type Position } from "optionality/domain/position";
import { strikeDistances, type StrikeDistance } from "optionality/domain/quote";
import { findWatchSample, listWatchSamples, recentPricedWatchSamples } from "./db/queries/index.ts";
import type { PositionRow, WatchSampleRow } from "./db/rows.ts";
import { displayStored, fromSqlDatetime } from "./db/time.ts";

/** The key a set of contracts is stored under: the codes, each once, sorted and joined by commas.
 *  No sign and no quantity, so a rule edited, a rule replaced by its holding's, or a holding
 *  recorded later on the same contracts all find the same history (owner's decision, 2026-11-15). */
export function contractSetKey(codes: Iterable<string>): string {
  return [...new Set(codes)].sort().join(",");
}

/** A stored per-contract map whose every reading is a finite number, or null: absent, unreadable,
 *  or holding something that is not a number. A corrupt map costs its own figures, never the
 *  request. */
export function storedLegMap(text: string | null): Record<string, number> | null {
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const map = parsed as Record<string, unknown>;
  return Object.values(map).every((v) => typeof v === "number" && Number.isFinite(v))
    ? (map as Record<string, number>) : null;
}

/** A stored day as a batch: each contract's record under the field names a batch uses, so it is
 *  valued, and its strikes placed, by exactly the functions a live batch is. Only what the row
 *  stores. */
function dayRecords(day: WatchSampleRow): ByCode {
  const records: ByCode = {};
  const maps: [string, Record<string, number> | null][] = [
    ["mid_price", storedLegMap(day.legs_mid)],
    ["option_implied_volatility", storedLegMap(day.legs_iv)],
    ["option_vega", storedLegMap(day.legs_vega)],
    ["option_delta", storedLegMap(day.legs_delta)],
  ];
  for (const [field, map] of maps) {
    for (const [code, value] of Object.entries(map ?? {})) (records[code] ??= {})[field] = value;
  }
  return records;
}

/** One stored day as a chart reads it: its figures, the value its reader gives it, and the shorts
 *  placed against that day's SPX. */
export interface WatchDay {
  observed_on: string;
  /** in DISPLAY_TZ; null only where the stored stamp cannot be read (`timing` is then unrecorded) */
  observed_at: string | null;
  timing: SampleTiming;
  dte: number;
  /** the reader's price for the day: a rule's signed value, a holding's Cost to close. Null where a
   *  contract had no two-sided quote (#380) */
  value: number | null;
  legs_iv: Record<string, number> | null;
  legs_vega: Record<string, number> | null;
  legs_delta: Record<string, number> | null;
  spx: number | null;
  short_strikes: StrikeDistance[];
}

function days(
  rows: WatchSampleRow[], value: (records: ByCode) => number | null, shorts: string[], tz: string,
): WatchDay[] {
  return rows.map((s) => {
    const timing = sampleTiming(s.observed_at);
    const records = dayRecords(s);
    return {
      observed_on: s.observed_on,
      observed_at: timing === "unrecorded" ? null : displayStored(s.observed_at, tz),
      timing,
      dte: s.dte,
      value: value(records),
      legs_iv: storedLegMap(s.legs_iv),
      legs_vega: storedLegMap(s.legs_vega),
      legs_delta: storedLegMap(s.legs_delta),
      spx: s.spx,
      short_strikes: strikeDistances(shorts, records, s.spx, s.dte),
    };
  });
}

/** A rule's price under its own signs and quantities, whatever field it watches: a delta rule's
 *  spread still has a price, which is what its payoff is drawn at (#402). */
const rulePrice = (monitor: Monitor) => (records: ByCode) =>
  monitorValue({ ...monitor, field: "mid_price" }, records);

/** The strikes a rule's history places against SPX: a combo's short legs (minus is short, as the
 *  watchlist's own `short_strikes`), and a single contract's own strike. */
function ruleShorts(monitor: Monitor): string[] {
  if (!monitor.legs || monitor.legs.length === 0) return [monitor.code];
  const codes = monitorLegCodes(monitor);
  return monitor.legs.flatMap((l, i) => (l.sign < 0 ? [codes[i]!] : []));
}

/** Every day stored for the contracts a rule watches, oldest first, valued under its signs. */
export function ruleHistory(db: DatabaseSync, monitor: Monitor, tz: string): WatchDay[] {
  const rows = listWatchSamples(db, contractSetKey(monitorLegCodes(monitor)));
  return days(rows, rulePrice(monitor), ruleShorts(monitor), tz);
}

/** The day a rule's price is drawn at with no live one: its latest close (`closeSample` — the latest
 *  row with a price taken in a session, else the latest with a price at all), said with when it was
 *  observed and what it is (`valuedTiming`), so an evening's reading is never called a close. */
export interface LastClose {
  price: number;
  observed_on: string;
  observed_at: string | null;
  timing: ValuedTiming;
}

/** How many priced days back a last close is looked for: two weeks of them, which no weekend, holiday
 *  or missed session outlasts, so `closeSample` over these chooses what it would over all of them. */
export const LAST_CLOSE_DAYS = 14;

/** A rule as `lastCloses` reads it: its id and, where its row could be read, the rule itself. */
export interface ReadRule {
  id: string;
  monitor: Monitor | null;
}

/** Each rule's last close, by id (#402), for `/quotes`: one bounded query per set of contracts, not
 *  per rule, of the latest priced days only (`LAST_CLOSE_DAYS`).
 *
 *  - **Not today's, in the session.** While New York's session runs, today's row is the session so
 *    far, written freely until 16:15, not a close: it is left out, so "drawn at its close" is never
 *    said of 11:02 this morning.
 *  - **None for contracts an open holding holds exactly.** The sweep stops recording a set of
 *    contracts once a holding holds exactly them (the holding's own samples take over), so such a
 *    rule's last watch day goes stale with every session: it is the holding's, valued from its own
 *    close (`/positions/values`).
 *  - **None for a rule that cannot be read**, which has no contracts to look up. */
export function lastCloses(
  db: DatabaseSync, rules: ReadRule[], holdings: Position[], tz: string, now: Date,
): Map<string, LastClose | null> {
  const held = new Set(holdings.map((p) => contractSetKey(positionLegCodes(p))));
  const today = inSession(now) ? marketDate(now) : null;
  const byKey = new Map<string, WatchSampleRow[]>();
  const out = new Map<string, LastClose | null>();
  for (const { id, monitor } of rules) {
    if (monitor === null) { out.set(id, null); continue; }
    const key = contractSetKey(monitorLegCodes(monitor));
    if (held.has(key)) { out.set(id, null); continue; }
    let stored = byKey.get(key);
    if (stored === undefined) {
      stored = recentPricedWatchSamples(db, key, LAST_CLOSE_DAYS).filter((s) => s.observed_on !== today);
      byKey.set(key, stored);
    }
    const price = rulePrice(monitor);
    const close = closeSample(stored.map((s) => ({ ...s, cost_to_close: price(dayRecords(s)) })));
    if (close === null || close.cost_to_close === null) { out.set(id, null); continue; }
    const timing = valuedTiming(close.observed_at);
    out.set(id, {
      price: close.cost_to_close,
      observed_on: close.observed_on,
      observed_at: timing === "unrecorded" ? null : displayStored(close.observed_at, tz),
      timing,
    });
  }
  return out;
}

/** The key the page matches two rules on the same spread by (`contractsKey` in the dashboard's
 *  `lastknown.ts`): a contract by its code, a spread by its expiry and its legs, each with its sign
 *  and quantity. What a watched rule's price rule is found by: a rule on the same contracts the same
 *  way round, whatever it is named. */
export function structureKey(monitor: Monitor): string {
  if (!monitor.legs || monitor.legs.length === 0) return monitor.code;
  const legs = monitor.legs.map((l) => `${l.sign}${l.option_type}${l.strike}x${l.qty ?? 1}`).sort();
  return `${monitor.strike_date} ${legs.join(" ")}`;
}

/** The first day a holding is its own: Opened, or where nobody said, the New York day it was
 *  recorded. Its own samples run from there, and a watch history only up to the day before. */
function enteredOn(row: PositionRow): string {
  return row.opened_at ?? marketDate(fromSqlDatetime(row.created_at));
}

/** The days a holding's contracts were WATCHED before it was entered (#402): the history of the
 *  same set of contracts, before Opened, each valued as the holding values itself — Cost to close,
 *  by side. Read-time, so `position_samples` and everything that reads it (the vol chain, `/vol`, the
 *  close a holding is valued from) never see a watch day. */
export function beforeEntry(
  db: DatabaseSync, row: PositionRow, position: Position, tz: string,
): WatchDay[] {
  const before = enteredOn(row);
  const rows = listWatchSamples(db, contractSetKey(positionLegCodes(position)))
    .filter((s) => s.observed_on < before);
  const shorts = position.legs.filter((l) => l.side === "short")
    .map((l) => buildSpxCode(position.strike_date, l.option_type, l.strike));
  return days(rows, (records) => costToClose(position, records), shorts, tz);
}

/** The entry day's close as it was WATCHED (#402, owner's decision of 2026-11-15): where the
 *  holding's own row for the day it was entered has no Cost to close — recorded in New York's
 *  evening, when moomoo quotes 0/0, so the sweep kept that day for its vol alone (#380) — the watch
 *  history's row for the same contracts that day, valued as the holding's Cost to close, by side.
 *  Null wherever the holding's own row has a cost, has no row that day, or the watch history has no
 *  priced row for it. Served apart (`entry_close`), so `position_samples` and its readers are
 *  untouched and the page can say which close it is. */
export function entryClose(
  db: DatabaseSync, row: PositionRow, position: Position, own: readonly { observed_on: string; cost_to_close: number | null }[],
  tz: string,
): WatchDay | null {
  const on = enteredOn(row);
  const mine = own.find((s) => s.observed_on === on);
  if (mine === undefined || mine.cost_to_close !== null) return null;
  const watched = findWatchSample(db, contractSetKey(positionLegCodes(position)), on);
  if (watched === undefined) return null;
  const shorts = position.legs.filter((l) => l.side === "short")
    .map((l) => buildSpxCode(position.strike_date, l.option_type, l.strike));
  const [day] = days([watched], (records) => costToClose(position, records), shorts, tz);
  return day!.value === null ? null : day!;
}
