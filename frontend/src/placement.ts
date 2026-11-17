/** Which rule sits where, and what is bracketed with what: the book as a model, before
 *  either arrangement draws it (ADR 0023). The desk table (#289) and the phone cards (#290) both
 *  draw THIS, so they cannot group one book two ways — and so do the saved picture and Copy as text.
 *
 *  ONE book in two sections (the owner, 2026-11-17): Spreads, then Contracts (`sections`), each by
 *  expiry, holdings and watches together, the held rows first. What sits where inside that:
 *
 *  - a rule about a holding sits under that holding, because it is a risk on something owned;
 *  - a rule on nothing held is the watchlist, an entry signal on a candidate spread;
 *  - EVERY single-contract rule is a row of its own in Contracts, at its expiry (the owner,
 *    2026-11-17): a short leg's delta is not drawn under the spread it is a leg of, watched
 *    (`in_combos`) or held. One on a leg of a held spread (`heldLeg`) comes first, before the watched
 *    contracts. On a holding of ONE contract it stays under that holding, itself in Contracts. So a
 *    watched spread has nothing under it, and its `under` is always empty;
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
 *  - a holding's OWN rule (`ownRule`) is drawn on the holding's row, not under it: the row named
 *    the same twice said one thing twice (2026-11-17);
 *  - every rule is drawn ONCE (2026-11-17): a rule linked to two drawn holdings sits under the
 *    first by the book's order, and the other place says "also in <the first>" (`elsewhere`).
 *
 *  A single-contract rule on a held leg needs no rule to FIND its holding: the service marks it held
 *  and links it (`holdsAnyOf`, `adoptOrphanMonitors`), and `heldLeg` reads that link.
 */
import type { Entry, Holding, Monitor } from "./shared/api";
import { entryName, isEntrySignal, QUARANTINED } from "./needs";

/** A rule drawn under an earlier place in the book, and that place's name: where it is met again
 *  the page draws a short note, "also in 1218_IC", and no second row (the owner, 2026-11-17). */
export interface Elsewhere {
  entry: Entry;
  in: string;
}

/** A holding and the rules about it. */
export interface PlacedHolding {
  holding: Holding;
  /** every rule about it, its own first: what its inspector or sheet lists */
  rules: Entry[];
  /** the single-contract rules on its legs (`heldLeg`), drawn in Contracts and not among `rules`:
   *  read only for its short leg's Δ where the service sent none (`columns.shortLegDelta`) */
  legRules?: Entry[];
  /** those of `rules` drawn under an earlier holding (a condor rule over a condor held as two
   *  spreads): the book draws each rule once, under the first place it sits by the book's order */
  elsewhere?: Elsewhere[];
}

/** One expiry's holdings. Each row is a bracket: one holding, or a condor's call and put spreads. */
interface HoldingGroup {
  expiry: string;
  rows: PlacedHolding[][];
}

/** A watched rule. */
export interface PlacedRule {
  entry: Entry;
  /** the rules drawn under it: none since 2026-11-17, when every single-contract rule became a row
   *  of its own in Contracts. Kept, empty, because every surface still draws what is here */
  under: Entry[];
  /** those of `under` drawn under an earlier watched spread (a leg in two spreads) */
  elsewhere?: Elsewhere[];
  /** for a combo that only partly overlaps a holding, what it shares and with whom
   *  (`overlapOf`): "shares C8100 with 1231_8050"; null for everything else */
  overlap: string | null;
}

interface WatchGroup {
  expiry: string;
  items: PlacedRule[];
}

/** One expiry of one section: its heading, and under it the held rows (each a bracket, as
 *  `HoldingGroup`'s), then the watched rows — `spreads` in Spreads, `contracts` in Contracts, the
 *  other always empty. Each part keeps the order its rows arrived in. */
export interface ExpiryBook {
  expiry: string;
  /** days to the expiry, from whichever row of it came first */
  dte: number;
  held: PlacedHolding[][];
  spreads: PlacedRule[];
  contracts: PlacedRule[];
}

/** One of the book's two sections (the owner, 2026-11-17): Spreads — every holding of more than one
 *  contract and every watched spread, with the leg rules under them — then Contracts — a holding of
 *  one contract and the lone watched contracts. Each by expiry; a section with nothing is left out. */
export interface BookSection {
  kind: "spreads" | "contracts";
  title: string;
  expiries: ExpiryBook[];
}

export interface BookModel {
  /** what every surface draws, in order: Spreads, then Contracts */
  sections: BookSection[];
  /** every expiry block of `sections`, in the order drawn: what finds a row by its id, orders j/k and
   *  draws each rule once */
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
  const drawn = new Set((holdings ?? []).map((h) => h.id));
  const ones = new Set((holdings ?? []).filter((h) => h.legs.length === 1).map((h) => h.id));
  // a single-contract rule linked to a drawn holding of more than one contract, and to none of one
  const heldLeg = (e: Entry) =>
    !e.legs && e.positions.some((p) => drawn.has(p.id) && !ones.has(p.id)) && !e.positions.some((p) => ones.has(p.id));
  const watched = quotes.filter((e) => isEntrySignal(e) || overlap(e) !== null || heldLeg(e));
  const unplaced = quotes.filter((e) => !isEntrySignal(e) && !e.positions.some((p) => drawn.has(p.id)));

  const off = monitors.filter((m) => !m.enabled);
  const quarantine = (m: Monitor) => m.disabled_reason !== null && m.disabled_reason in QUARANTINED;

  const holdingGroups: HoldingGroup[] = byExpiry(holdings ?? []).map(([expiry, group]) => ({
    expiry,
    rows: brackets(group).map((row) => row.map((holding) => {
      const rules = quotes.filter((e) => overlap(e) === null && !heldLeg(e) && e.positions.some((p) => p.id === holding.id));
      // its own rule first: the one its row draws, then every other
      const own = ownRule(holding, rules);
      const legRules = quotes.filter((e) => heldLeg(e) && e.positions.some((p) => p.id === holding.id));
      return { holding, rules: own ? [own, ...rules.filter((r) => r !== own)] : rules, legRules };
    })),
  }));
  // a held leg's rule first among its expiry's contracts: the held rows first (2026-11-17)
  const heldFirst = (rows: Entry[]) => [...rows.filter(heldLeg), ...rows.filter((e) => !heldLeg(e))];
  const watchGroups: WatchGroup[] = byExpiry(watched).map(([expiry, group]) => ({
    expiry, items: heldFirst(group).map((entry) => ({ entry, under: [], overlap: overlap(entry) })),
  }));

  const sections = twoSections(holdingGroups, watchGroups);
  const book = sections.flatMap((s) => s.expiries);
  drawOnce(book);
  return {
    sections,
    book,
    holdings: holdingGroups,
    unplaced,
    watchlist: watchGroups,
    quarantined: byExpiry(off.filter(quarantine)).flatMap(([, g]) => g),
    muted: byExpiry(off.filter((m) => !quarantine(m))).flatMap(([, g]) => g),
  };
}

/** The holdings and the watchlist as the book's two sections: Spreads, then Contracts, each by
 *  expiry, earliest first. A holding goes by its legs — one contract is a contract, held or not —
 *  and a condor's bracket is two spreads, so it is always in Spreads. */
function twoSections(holdings: HoldingGroup[], watchlist: WatchGroup[]): BookSection[] {
  const single = (row: PlacedHolding[]) => row.length === 1 && row[0]!.holding.legs.length === 1;
  const section = (kind: BookSection["kind"], title: string, contract: boolean): BookSection => {
    const held = holdings.map((g) => ({ expiry: g.expiry, rows: g.rows.filter((r) => single(r) === contract) }));
    const watched = watchlist.map((g) => ({ expiry: g.expiry, items: g.items.filter((i) => !i.entry.legs === contract) }));
    const expiries = [...new Set([...held, ...watched].filter((g) => ("rows" in g ? g.rows : g.items).length > 0)
      .map((g) => g.expiry))].sort();
    return {
      kind, title,
      expiries: expiries.map((expiry) => {
        const rows = held.find((g) => g.expiry === expiry)?.rows ?? [];
        const items = watched.find((g) => g.expiry === expiry)?.items ?? [];
        return {
          expiry,
          dte: rows[0]?.[0]?.holding.dte ?? items[0]!.entry.dte,
          held: rows,
          spreads: contract ? [] : items,
          contracts: contract ? items : [],
        };
      }),
    };
  };
  return [section("spreads", "Spreads", false), section("contracts", "Contracts", true)]
    .filter((s) => s.expiries.length > 0);
}

/** Marks, in the book's order, each rule met under a second place as drawn under the first. */
function drawOnce(book: ExpiryBook[]): void {
  const first = new Map<string, string>();
  const place = (rules: readonly Entry[], name: string, skip: Entry | null): Elsewhere[] => {
    const out: Elsewhere[] = [];
    for (const r of rules) {
      if (r === skip) continue;
      const at = first.get(r.id);
      if (at === undefined) first.set(r.id, name);
      else out.push({ entry: r, in: at });
    }
    return out;
  };
  for (const g of book) {
    for (const p of g.held.flat()) p.elsewhere = place(p.rules, p.holding.name, ownRule(p.holding, p.rules));
    for (const i of [...g.spreads, ...g.contracts]) i.elsewhere = place(i.under, entryName(i.entry), null);
  }
}

/** What the book draws under a holding or a watched spread: its rules, less any drawn under an
 *  earlier place (`elsewhere`) and, for a holding, less its own rule, which its row draws. */
export function drawnUnder(rules: readonly Entry[], elsewhere: readonly Elsewhere[] | undefined, own: Entry | null = null): Entry[] {
  const away = new Set((elsewhere ?? []).map((e) => e.entry.id));
  return rules.filter((r) => r !== own && !away.has(r.id));
}

/** The note where a rule is met again: "20261218 P7150 also in 1218_P7150". */
export const alsoWords = (e: Elsewhere) => `${entryName(e.entry)} also in ${e.in}`;

/** A holding's OWN rule (2026-11-17): the one rule the service links to this holding alone over
 *  ALL of it (`scope` "all", `positions` exactly this holding — the fact its `schedule` comes from),
 *  a price rule (`mid_price`) before any other, and among those the one named as the holding: the
 *  value rule the add form makes with it. Its row draws it, where it was a row of its own named the
 *  same; any other rule stays a row under it. A rule renamed is still its own. */
export function ownRule(holding: { id: string; name: string }, rules: readonly Entry[]): Entry | null {
  const mine = rules.filter((r) => r.scope === "all" && r.positions.length === 1 && r.positions[0]!.id === holding.id);
  const rank = (r: Entry) => (r.field === "mid_price" ? 0 : 2) + (entryName(r) === holding.name ? 0 : 1);
  return [...mine].sort((a, b) => rank(a) - rank(b))[0] ?? null;
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
