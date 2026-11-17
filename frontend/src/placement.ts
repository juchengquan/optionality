/** Which rule sits where, and what is bracketed with what: the book as a model, before
 *  either arrangement draws it (ADR 0023). The desk table (#289) and the phone cards (#290) both
 *  draw THIS, so they cannot group one book two ways — and so do the saved picture and Copy as text.
 *
 *  ONE book (the owner, 2026-11-17): holdings and watches together, each expiry once (`book`),
 *  and under it the held spreads, then the watched spreads, then the lone watched contracts. What
 *  sits where inside that:
 *
 *  - a rule about a holding sits under that holding, because it is a risk on something owned;
 *  - a rule on nothing held is the watchlist, an entry signal on a candidate spread;
 *  - a single-contract rule whose contract is a leg of a watched spread (`in_combos`, a link the
 *    service discovers) sits under that spread, which is how a short leg's delta joins its spread;
 *  - a rule on something held whose holding is not drawn — the valuation failed or has not arrived,
 *    or two holdings share its contract, as on a roll day — is still shown, unplaced;
 *  - a condor held as two spreads on one expiry is BRACKETED: one call vertical and one put
 *    vertical, the calls first. A 4-leg holding is already one row and is never split;
 *  - a COMBO that names a contract its linked holdings do not hold (`namesUnheldContract`) is only
 *    PARTLY held — the holding holds part of it (scope `leg`), or the whole holding and more (scope
 *    `all`) — and is drawn in the watchlist, as the watched spread it mostly is, with a note naming
 *    the contracts it shares and with whom (#346, the owner's decision in #338). The service's link
 *    is untouched: only where the rule is DRAWN changes. A single-contract rule, and a combo on
 *    nothing but held contracts — the holding's own value rule, or a wing of a held condor, which
 *    watches risk on something held — stay under it;
 *  - a holding's OWN rule — the combo named as the holding is (`ownRule`) — is drawn on the
 *    holding's row, not under it: the row named the same twice said one thing twice (2026-11-17);
 *  - a watched single contract that is a leg of a HOLDING, and of no watched spread, sits under
 *    the holding, as a leg's rule sits under its watched spread (2026-11-17).
 */
import type { Entry, Holding, Monitor } from "./shared/api";
import { entryName, isEntrySignal, QUARANTINED } from "./needs";

/** A holding and the rules about it. */
export interface PlacedHolding {
  holding: Holding;
  rules: Entry[];
}

/** One expiry's holdings. Each row is a bracket: one holding, or a condor's call and put spreads. */
interface HoldingGroup {
  expiry: string;
  rows: PlacedHolding[][];
}

/** A watched rule and the single-contract rules that sit under it (empty for most). */
export interface PlacedRule {
  entry: Entry;
  under: Entry[];
  /** for a combo that only partly overlaps a holding, what it shares and with whom
   *  (`overlapOf`): "shares C8100 with 1231_8050"; null for everything else */
  overlap: string | null;
}

interface WatchGroup {
  expiry: string;
  items: PlacedRule[];
}

/** One expiry of the one book: its heading once, and under it the three parts in this order —
 *  the held spreads (each row a bracket, as `HoldingGroup`'s), the watched spreads with the leg
 *  rules under them, and the lone watched contracts, which the page draws under a quiet
 *  "contracts" label (2026-11-17). Each part keeps the order its rows arrived in. */
export interface ExpiryBook {
  expiry: string;
  /** days to the expiry, from whichever row of it came first */
  dte: number;
  held: PlacedHolding[][];
  spreads: PlacedRule[];
  contracts: PlacedRule[];
}

export interface BookModel {
  /** the one book every surface draws: `holdings` and `watchlist` merged by expiry */
  book: ExpiryBook[];
  /** empty while the holdings are not valued: their rules are then `unplaced` */
  holdings: HoldingGroup[];
  unplaced: Entry[];
  watchlist: WatchGroup[];
  /** switched off by the service because it cannot evaluate them (CONTEXT.md: Quarantine) */
  quarantined: Monitor[];
  /** switched off by hand, by the calendar, or because their holding closed: not news */
  muted: Monitor[];
}

/** What an empty book says, once, on every surface: nothing held and nothing watched (2026-11-17).
 *  A book with only one of the two says nothing — the other is simply drawn. */
export const NOTHING = "nothing held or watched";

export function placeBook(quotes: Entry[], holdings: Holding[] | null, monitors: Monitor[]): BookModel {
  const overlaps = new Map(quotes.map((e) => [e.id, overlapOf(e, holdings ?? [])]));
  const overlap = (e: Entry) => overlaps.get(e.id) ?? null;
  const watched = quotes.filter((e) => isEntrySignal(e) || overlap(e) !== null);
  const drawn = new Set((holdings ?? []).map((h) => h.id));
  const unplaced = quotes.filter((e) => !isEntrySignal(e) && !e.positions.some((p) => drawn.has(p.id)));

  const ids = new Set(watched.map((e) => e.id));
  // a leg rule with a spread on the watchlist to sit under; one whose spreads are all held or gone
  // stands alone rather than disappearing
  const nested = (e: Entry) => !e.legs && e.in_combos.some((id) => ids.has(id));
  const under = (combo: Entry) =>
    combo.legs ? watched.filter((e) => !e.legs && e.in_combos.includes(combo.id)) : [];
  // a lone watched contract on a drawn holding's leg sits under that holding (2026-11-17)
  const onLeg = (e: Entry) => (e.legs || !isEntrySignal(e) || nested(e) ? null
    : (holdings ?? []).find((h) => h.strike_date === e.strike_date && holdsContract(h, e.code)) ?? null);

  const off = monitors.filter((m) => !m.enabled);
  const quarantine = (m: Monitor) => m.disabled_reason !== null && m.disabled_reason in QUARANTINED;

  const holdingGroups: HoldingGroup[] = byExpiry(holdings ?? []).map(([expiry, group]) => ({
    expiry,
    rows: brackets(group).map((row) => row.map((holding) => {
      const rules = quotes.filter((e) =>
        (overlap(e) === null && e.positions.some((p) => p.id === holding.id)) || onLeg(e)?.id === holding.id);
      // its own rule first: the one its row draws, then every other
      const own = ownRule(holding, rules);
      return { holding, rules: own ? [own, ...rules.filter((r) => r !== own)] : rules };
    })),
  }));
  const watchGroups: WatchGroup[] = byExpiry(watched.filter((e) => !nested(e) && onLeg(e) === null)).map(([expiry, group]) => ({
    expiry, items: group.map((entry) => ({ entry, under: under(entry), overlap: overlap(entry) })),
  }));

  return {
    book: oneBook(holdingGroups, watchGroups),
    holdings: holdingGroups,
    unplaced,
    watchlist: watchGroups,
    quarantined: byExpiry(off.filter(quarantine)).flatMap(([, g]) => g),
    muted: byExpiry(off.filter((m) => !quarantine(m))).flatMap(([, g]) => g),
  };
}

/** The holdings and the watchlist as ONE book: each expiry once, earliest first, its held spreads,
 *  then its watched spreads, then its lone watched contracts. */
function oneBook(holdings: HoldingGroup[], watchlist: WatchGroup[]): ExpiryBook[] {
  const expiries = [...new Set([...holdings.map((g) => g.expiry), ...watchlist.map((g) => g.expiry)])].sort();
  return expiries.map((expiry) => {
    const held = holdings.find((g) => g.expiry === expiry)?.rows ?? [];
    const items = watchlist.find((g) => g.expiry === expiry)?.items ?? [];
    return {
      expiry,
      dte: held[0]?.[0]?.holding.dte ?? items[0]!.entry.dte,
      held,
      spreads: items.filter((i) => Boolean(i.entry.legs)),
      contracts: items.filter((i) => !i.entry.legs),
    };
  });
}

/** A holding's OWN rule: the combo among the rules about it that is named as the holding is — the
 *  value rule the add form makes with it, "1231_8050" on 1231_8050. Its row draws it (2026-11-17),
 *  where it was a row of its own under the holding named the same; any other rule stays a row
 *  under it. The first such, where (oddly) there are two. */
export function ownRule(holding: { name: string }, rules: readonly Entry[]): Entry | null {
  return rules.find((r) => Boolean(r.legs) && entryName(r) === holding.name) ?? null;
}

/** Whether a holding holds the contract a moomoo code names (`US.SPXW261218P7150000`). */
function holdsContract(h: Holding, code: string): boolean {
  const m = /([CP])(\d{4,})$/.exec(code);
  if (!m) return false;
  const strike = Number(m[2]) / 1000;
  return h.legs.some((l) => l.option_type[0] === m[1] && l.strike === strike);
}

/** What a rule's or a holding's contracts are, enough to compare them: an expiry and its legs. */
interface Contracts {
  strike_date: string;
  /** `qty` is how many of the contract the leg holds, 1 when absent (#351) */
  legs: readonly { option_type: string; strike: number; qty?: number }[];
}

/** A contract as a key and as the page writes it: `C8100`. */
type Leg = { option_type: string; strike: number };
const keyOf = (date: string, l: Leg) => `${date} ${l.option_type} ${l.strike}`;
const label = (l: Leg) => `${l.option_type[0]}${l.strike}`;

/** Whether a combo names a contract the holdings it is linked to do not hold, taken together —
 *  counted as MULTISETS, so a 1×2 ratio over a 1×1 holding names one contract more than is held —
 *  each leg as many times as its quantity (#351), whether it is said with one or by a repeated leg.
 *  Signs play no part (leg conventions differ, #97). The one predicate every surface asks about a
 *  linked combo (#346): false, every contract it names is held and it sits under its holding — the
 *  holding's own value rule, a wing of a held condor, a condor rule over a condor held as two
 *  spreads; true, it is only partly held and is drawn in the watchlist. */
export function namesUnheldContract(rule: Contracts, holdings: readonly Contracts[]): boolean {
  const held = new Map<string, number>();
  for (const h of holdings) {
    for (const l of h.legs) held.set(keyOf(h.strike_date, l), (held.get(keyOf(h.strike_date, l)) ?? 0) + (l.qty ?? 1));
  }
  for (const l of rule.legs) {
    const left = (held.get(keyOf(rule.strike_date, l)) ?? 0) - (l.qty ?? 1);
    if (left < 0) return true;
    held.set(keyOf(rule.strike_date, l), left);
  }
  return false;
}

/** A rule as `/quotes` or `/monitors` serves it: its legs where it is a combo, and its links. */
interface Linked {
  strike_date: string;
  legs?: readonly { option_type: string; strike: number }[] | null;
  positions: readonly { id: string; name: string }[];
}

/** For a COMBO naming a contract its linked holdings do not hold, the note it is drawn with in the
 *  watchlist — which contracts it shares, and with which holding, never a figure, so
 *  privacy has nothing to hide in it: "shares C8100 with 1231_8050" where the holding holds part of
 *  it, "contains 1231_7700's C7700" where it holds the whole holding and more, "linked to X" where
 *  it shares nothing with X, one clause per holding joined by "; ". Null for a single contract, a
 *  rule linked to nothing, a combo on nothing but held contracts, and one linked to ANY holding the
 *  page has not valued: what that one holds is unknown, so it is drawn as before rather than moved
 *  on half the evidence. */
export function overlapOf(
  rule: Linked, holdings: readonly (Contracts & { id: string; name: string })[],
): string | null {
  if (!rule.legs || rule.legs.length === 0 || rule.positions.length === 0) return null;
  const linked = rule.positions.map((p) => holdings.find((h) => h.id === p.id));
  if (linked.some((h) => h === undefined)) return null;
  const mine = { strike_date: rule.strike_date, legs: rule.legs };
  const ofHoldings = linked as (Contracts & { name: string })[];
  if (!namesUnheldContract(mine, ofHoldings)) return null;
  const own = new Set(rule.legs.map((l) => keyOf(rule.strike_date, l)));
  return ofHoldings.map((h) => {
    const shared = h.legs.filter((l) => own.has(keyOf(h.strike_date, l))).map(label);
    if (shared.length === 0) return `linked to ${h.name}`;
    const whole = shared.length === h.legs.length;
    return whole ? `contains ${h.name}'s ${words(shared)}` : `shares ${words(shared)} with ${h.name}`;
  }).join("; ");
}

/** "C8050", "C8050 and C8100", "C7400, C7450 and P6300". */
function words(items: string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** Rows grouped by expiry, the earliest first; each group keeps the order its rows arrived in. */
function byExpiry<T extends { strike_date: string }>(rows: T[]): [string, T[]][] {
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
