/** Which rule sits where, and what is bracketed with what: the redesign's book as a model, before
 *  either arrangement draws it (ADR 0023). The desk table (#289) and the phone cards (#290) both
 *  draw THIS, so they cannot group one book two ways.
 *
 *  - a rule about a holding sits under that holding, because it is a risk on something owned;
 *  - a rule on nothing held is the watchlist, an entry signal on a candidate spread;
 *  - a single-contract rule whose contract is a leg of a watched spread (`in_combos`, a link the
 *    service discovers) sits under that spread, which is how a short leg's delta joins its spread;
 *  - a rule on something held whose holding is not drawn — the valuation failed or has not arrived,
 *    or two holdings share its contract, as on a roll day — is still shown, unplaced;
 *  - a condor held as two spreads on one expiry is BRACKETED: one call vertical and one put
 *    vertical, the calls first. A 4-leg holding is already one row and is never split.
 */
import type { Entry, Holding, Monitor } from "../shared/api";
import { isEntrySignal, QUARANTINED } from "./needs";

/** A holding and the rules about it. */
export interface PlacedHolding {
  holding: Holding;
  rules: Entry[];
}

/** One expiry's holdings. Each row is a bracket: one holding, or a condor's call and put spreads. */
export interface HoldingGroup {
  expiry: string;
  rows: PlacedHolding[][];
}

/** A watched rule and the single-contract rules that sit under it (empty for most). */
export interface PlacedRule {
  entry: Entry;
  under: Entry[];
}

export interface WatchGroup {
  expiry: string;
  items: PlacedRule[];
}

export interface BookModel {
  /** empty while the holdings are not valued: their rules are then `unplaced` */
  holdings: HoldingGroup[];
  unplaced: Entry[];
  watchlist: WatchGroup[];
  /** switched off by the service because it cannot evaluate them (CONTEXT.md: Quarantine) */
  quarantined: Monitor[];
  /** switched off by hand, by the calendar, or because their holding closed: not news */
  muted: Monitor[];
}

export function placeBook(quotes: Entry[], holdings: Holding[] | null, monitors: Monitor[]): BookModel {
  const watched = quotes.filter(isEntrySignal);
  const drawn = new Set((holdings ?? []).map((h) => h.id));
  const unplaced = quotes.filter((e) => !isEntrySignal(e) && !e.positions.some((p) => drawn.has(p.id)));

  const ids = new Set(watched.map((e) => e.id));
  // a leg rule with a spread on the watchlist to sit under; one whose spreads are all held or gone
  // stands alone rather than disappearing
  const nested = (e: Entry) => !e.legs && e.in_combos.some((id) => ids.has(id));
  const under = (combo: Entry) =>
    combo.legs ? watched.filter((e) => !e.legs && e.in_combos.includes(combo.id)) : [];

  const off = monitors.filter((m) => !m.enabled);
  const quarantine = (m: Monitor) => m.disabled_reason !== null && m.disabled_reason in QUARANTINED;

  return {
    holdings: byExpiry(holdings ?? []).map(([expiry, group]) => ({
      expiry,
      rows: brackets(group).map((row) => row.map((holding) => ({
        holding, rules: quotes.filter((e) => e.positions.some((p) => p.id === holding.id)),
      }))),
    })),
    unplaced,
    watchlist: byExpiry(watched.filter((e) => !nested(e))).map(([expiry, group]) => ({
      expiry, items: group.map((entry) => ({ entry, under: under(entry) })),
    })),
    quarantined: byExpiry(off.filter(quarantine)).flatMap(([, g]) => g),
    muted: byExpiry(off.filter((m) => !quarantine(m))).flatMap(([, g]) => g),
  };
}

/** Rows grouped by expiry, the earliest first; each group keeps the order its rows arrived in. */
export function byExpiry<T extends { strike_date: string }>(rows: T[]): [string, T[]][] {
  const groups = new Map<string, T[]>();
  for (const r of [...rows].sort((a, b) => a.strike_date.localeCompare(b.strike_date))) {
    groups.set(r.strike_date, [...(groups.get(r.strike_date) ?? []), r]);
  }
  return [...groups];
}

/** A two-leg vertical on one side: one short and one long, both calls or both puts. */
function verticalSide(h: Holding): "CALL" | "PUT" | null {
  if (h.legs.length !== 2) return null;
  const [a, b] = h.legs;
  if (a!.option_type !== b!.option_type || a!.side === b!.side) return null;
  return a!.option_type === "CALL" ? "CALL" : a!.option_type === "PUT" ? "PUT" : null;
}

/** One expiry's holdings as rows: each call vertical paired with a put vertical while both last,
 *  in the order they arrived, the calls first in a pair; everything else a row of its own. */
function brackets(group: Holding[]): Holding[][] {
  const puts = group.filter((h) => verticalSide(h) === "PUT");
  const paired = new Set<string>();
  const rows: Holding[][] = [];
  for (const h of group) {
    if (paired.has(h.id)) continue;
    if (verticalSide(h) === "CALL") {
      const partner = puts.find((p) => !paired.has(p.id));
      if (partner) {
        paired.add(h.id);
        paired.add(partner.id);
        rows.push([h, partner]);
        continue;
      }
    }
    if (verticalSide(h) === "PUT" && !paired.has(h.id)) {
      // a put vertical waits for a call vertical later in the group before standing alone
      const call = group.find((c) => verticalSide(c) === "CALL" && !paired.has(c.id));
      if (call) {
        paired.add(h.id);
        paired.add(call.id);
        rows.push([call, h]);
        continue;
      }
    }
    paired.add(h.id);
    rows.push([h]);
  }
  return rows;
}
