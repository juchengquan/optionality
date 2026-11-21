/** The desk table's columns, what each row says in them, and how many fit (ADR 0008, ADR 0023).
 *
 *  Pure: no React, no DOM. The table draws these, the inspector lists every one of them whether the
 *  table had room or not, and the fitting counts their characters — three readers of one text, as
 *  the old page's `columns.ts` arranged it, so the three cannot drift.
 *
 *  ONE table for the holdings and the watchlist, so one set of columns: a cell a row has nothing
 *  for is blank, not a dash, because a dash reads as "the figure has not arrived".
 *
 *  Every figure is one the service served. Nothing here models a price: a pace is the schedule's
 *  `on_pace` and `pace_gap` — the gap signed beside the cost in the table's value column, and in
 *  words everywhere else (#379, 2026-11-16) —
 *  never a curve drawn on screen (ADR 0023: "never draw what the system does not know"). The two pieces of arithmetic are a subtraction of two served day counts (days
 *  left before the Manage-by) and a share as a percentage.
 */
import type { Entry, Holding, Monitor } from "../shared/api";
import { DASH, heldLeg, legText, shortFirst, signedLeg, type WrittenLeg } from "../shared/format";
import { delta, money, percent, points } from "../shared/numbers";
import { drawnUnder, ownRule, type BookModel, type ExpiryBook, type PlacedHolding } from "../placement";
import {
  entryName, isEntrySignal, monitorName, QUARANTINED, sentence, shapeOf, shortDistance, shortRule, shortSentence, storedRuleWords,
} from "../needs";
import { servedDelta } from "../legs";
import { costAndPace, manageBy, paceSigned, paceWords } from "../pace";
import { LEVEL_WORDS, levelWords } from "../levels";
import { outOfHoursValue, priceOf } from "../lastknown";
import { cellWords, stripOfEntry, stripOfHolding, type Strip } from "../strip";

export type DeskRow =
  /** `legRules`: the single-contract rules on its legs, drawn in Contracts, read for its Δ alone */
  | { kind: "holding"; holding: Holding; rules: Entry[]; legRules?: Entry[] }
  /** a rule as `/quotes` serves it; `nested` when it sits under a spread or a holding; `overlap`,
   *  the note of a combo drawn in the watchlist because it only partly overlaps a holding (#346) */
  | { kind: "rule"; entry: Entry; nested: boolean; overlap?: string | null }
  /** a rule the service switched off because it cannot evaluate it: only `/monitors` has it */
  | { kind: "quarantined"; monitor: Monitor };

export interface DeskColumn {
  /** Where a key is one the old page's combo table also had, it IS that column, so the column
   *  choice made there (the `ui_cols_combo` cookie) carried over the swap (#301). */
  key: string;
  label: string;
  align?: "left";
  /** what the cell says, for the drawing, the inspector and the measuring alike; empty where the
   *  row has nothing to say in this column */
  text: (row: DeskRow, privacy: boolean) => string;
  /** what the cell MEANS, where `text` is a compact form of it: said to a reader and a pointer
   *  beside the drawn text, and in the inspector instead of it */
  words?: (row: DeskRow, privacy: boolean) => string;
}

// ---- figures, with fixed decimals per field (ADR 0023), all of them `shared/numbers.ts`'s

/** As `Money` in Book.tsx draws it: the same characters, so the measuring counts what is drawn. */
export function moneyText(value: number | null, privacy: boolean): string {
  if (value === null) return DASH;
  return privacy ? "$•••" : money(value);
}

/** The legs a row writes in its legs column: a holding's, or a rule's on a spread; none for a
 *  rule on one contract. `Cell` draws them, each type in its colour (#391). */
export function rowLegs(row: DeskRow): WrittenLeg[] {
  if (row.kind === "holding") return shortFirst(row.holding.legs.map(heldLeg));
  return row.kind === "rule" && row.entry.legs ? shortFirst(row.entry.legs.map(signedLeg)) : [];
}

/** moomoo's `US.SPXW261218P7150000` as the type and strike it names, or null for anything else. */
function contractOf(code: string): { type: "C" | "P"; strike: number } | null {
  const m = /([CP])(\d{4,})$/.exec(code);
  return m ? { type: m[1] as "C" | "P", strike: Number(m[2]) / 1000 } : null;
}

/** The short leg's delta. `/positions/values` serves each leg's own (`legs_delta`, #318); where it
 *  sent none, a rule watching that leg — the owner's other way to see it (ADR 0023) — and then
 *  null, never a figure derived on screen: the holding's `greeks` are a signed sum over its legs
 *  and are not the short leg's delta. Where two legs are short (a 4-leg condor) it is the larger
 *  in size: the wing closer to the money. */
function shortLegDelta(holding: Holding, rules: Entry[]): number | null {
  let found: number | null = null;
  for (const leg of holding.legs.filter((l) => l.side === "short")) {
    const served = servedDelta(holding, leg);
    if (served !== null) {
      if (found === null || Math.abs(served) > Math.abs(found)) found = served;
      continue;
    }
    const rule = rules.find((r) => {
      if (r.legs || r.strike_date !== holding.strike_date) return false;
      const c = contractOf(r.code);
      return c !== null && c.type === leg.option_type[0] && c.strike === leg.strike;
    });
    const q = rule?.quote as Record<string, unknown> | null | undefined;
    const d = typeof q?.option_delta === "number" ? q.option_delta
      : rule?.field === "option_delta" ? rule.watched : null;
    if (d !== null && d !== undefined && (found === null || Math.abs(d) > Math.abs(found))) found = d;
  }
  return found;
}

/** A rule's figure from its own quote, for a single contract. */
function quoted(entry: Entry, name: string): number | null {
  const q = entry.quote as Record<string, unknown> | null;
  const v = q?.[name];
  return typeof v === "number" ? v : null;
}

/** Why nothing watches a quarantined rule now. */
const quarantineWhy = (m: Monitor) =>
  (m.disabled_reason && QUARANTINED[m.disabled_reason]) ?? "switched off by the service";

/** What a quarantined rule watches and why nothing watches it now, in words: its title and what a
 *  reader hears. */
function quarantineSentence(m: Monitor): string {
  return `${storedRuleWords(m.field, Boolean(m.legs), m.compare, m.direction, m.threshold)} — ${quarantineWhy(m)}`;
}

/** The same in the short form the column draws (#388): "|Δ| ≥ 0.20 — its figure never arrives". */
const quarantineShort = (m: Monitor) => `${shortRule(shapeOf(m))} — ${quarantineWhy(m)}`;

/** Every row the table can draw, in the order it draws them: the one book by expiry (2026-11-17) —
 *  its held spreads, each with the rules under it but its own (`ownRule`, drawn on its row), then
 *  its watched spreads with their leg rules, then its lone contracts — and after the expiries the
 *  rules on held contracts no drawn holding owns, and the quarantined. The fitting measures exactly
 *  these, j and k walk them, the palette finds them, and the inspector finds its row among them. */
export function tableRows(placed: BookModel): DeskRow[] {
  const out: DeskRow[] = placed.book.flatMap(groupRows);
  for (const entry of placed.unplaced) out.push({ kind: "rule", entry, nested: false });
  for (const monitor of placed.quarantined) out.push({ kind: "quarantined", monitor });
  return out;
}

/** One expiry group's rows, as the table draws them: each held spread, the rules under it, then the
 *  watched spreads or contracts. What a folded group's heading counts (`folds.ts`). */
export function groupRows(g: ExpiryBook): DeskRow[] {
  const out: DeskRow[] = [];
  for (const p of g.held.flat()) {
    out.push({ kind: "holding", holding: p.holding, rules: p.rules, legRules: p.legRules });
    for (const entry of subRules(p)) out.push({ kind: "rule", entry, nested: true });
  }
  for (const i of [...g.spreads, ...g.contracts]) {
    out.push({ kind: "rule", entry: i.entry, nested: false, overlap: i.overlap });
  }
  return out;
}

/** The rules drawn as rows under a holding: every rule about it but its own, which its row draws,
 *  and any drawn under an earlier holding (`elsewhere`). */
export function subRules(p: PlacedHolding): Entry[] {
  return drawnUnder(p.rules, p.elsewhere, ownRule(p.holding, p.rules));
}

/** The rule a row draws in its rule column: a rule row's own, a holding's OWN rule (2026-11-17). */
export function ruleOfRow(row: DeskRow): Entry | null {
  return row.kind === "rule" ? row.entry : row.kind === "holding" ? ownRule(row.holding, row.rules) : null;
}

export function rowId(row: DeskRow): string {
  return row.kind === "holding" ? row.holding.id : row.kind === "rule" ? row.entry.id : row.monitor.id;
}

export function rowName(row: DeskRow): string {
  return row.kind === "holding" ? row.holding.name
    : row.kind === "rule" ? entryName(row.entry) : monitorName(row.monitor);
}

/** The attention a row asks for, drawn as a chip in the name cell, which never drops: a breach
 *  can never be hidden by the room running out (ADR 0008's fallback chain, kept). */
type Attention = "fault" | "entry" | "alarm" | "stop" | "target" | "manage";

export function attentionOf(row: DeskRow): Attention | null {
  if (row.kind === "quarantined") return "fault";
  if (row.kind === "holding") {
    const s = row.holding.schedule;
    return s?.reached ?? (s?.manage_by_due ? "manage" : null);
  }
  const e = row.entry;
  if (e.error) return "fault";
  if (!e.triggered) return null;
  return isEntrySignal(e) ? "entry" : "alarm";
}

/** The attention a holding's OWN rule asks for, drawn on the holding's row beside its Level's chip
 *  (2026-11-17): the rule's row is gone, and a breach is never hidden. Null for every other row. */
export function ownAttentionOf(row: DeskRow): "fault" | "entry" | "alarm" | null {
  if (row.kind !== "holding") return null;
  const own = ownRule(row.holding, row.rules);
  return own ? attentionOf({ kind: "rule", entry: own, nested: false }) as "fault" | "entry" | "alarm" | null : null;
}

/** How serious each state a row can be in is (the owner, 2026-11-17): a holding's row is drawn in
 *  the most serious of its Level's and its own rule's — a fault, then ringing or at stop, then
 *  manage-by, then at target. On a tie the Level's name is kept (stop and ringing draw alike). */
const SEVERITY: Record<string, number> = { fault: 4, alarm: 3, stop: 3, entry: 2, manage: 2, target: 1 };

/** The state a row is drawn in — its tint, a fault's strike-through — and the phone's card too. */
export function rowState(row: DeskRow): string {
  const level = attentionOf(row);
  const own = ownAttentionOf(row);
  if (level === null) return own ?? "calm";
  if (own === null) return level;
  return SEVERITY[own]! > SEVERITY[level]! ? own : level;
}

/** The more serious of two states by the same order; on a tie, the first. "calm" is the least. */
export function moreSerious(a: string, b: string): string {
  return (SEVERITY[b] ?? 0) > (SEVERITY[a] ?? 0) ? b : a;
}

/** The chip's words, which are also what the measuring counts. */
export const ATTENTION_WORDS: Record<Attention, string> = {
  fault: "fault", entry: "entry signal", alarm: "ringing", ...LEVEL_WORDS,
};

/** The words a row's chip draws, or null for no chip: a holding's Level says, outside the session,
 *  which valuation it is from (`levelWords`, #354, #371). */
export function chipWords(row: DeskRow, session: boolean): string | null {
  const a = attentionOf(row);
  if (a === null) return null;
  if (row.kind === "holding" && (a === "stop" || a === "target" || a === "manage")) {
    return levelWords(a, row.holding, session);
  }
  return ATTENTION_WORDS[a];
}

// ---- the columns

const holdingOnly = (f: (h: Holding, rules: Entry[], privacy: boolean) => string) =>
  (row: DeskRow, privacy: boolean) => (row.kind === "holding" ? f(row.holding, row.rules, privacy) : "");

const NAME: DeskColumn = { key: "name", label: "name", align: "left", text: (r) => rowName(r) };

const LEGS: DeskColumn = {
  key: "legs", label: "legs", align: "left",
  // `-C7300 +C7350`: a holding's legs as the watchlist writes a combo's, short as minus
  text: (r) => rowLegs(r).map((l) => legText(l, "signs")).join(" "),
};

const VALUE: DeskColumn = {
  // a holding's Cost to close; a rule on held contracts, the cost to close of the contracts it
  // names; a watched spread's value — one drawn in the watchlist because it names a contract its
  // holding does not hold included (#346). The service serves that one no cost to close
  // (`costToCloseOf` is null unless every contract it names is held), except a ratio, whose repeated
  // contract it counts once: drawn as a watched spread, it shows its value. A single contract's mid
  // — always a PRICE (#400): a delta rule's figure is the Δ column's and its sentence's, never this
  // one's. Out of the session a watchlist row says its last in-session price and when, or a dash
  key: "value", label: "value",
  text: (r) => r.kind === "holding" ? points(r.holding.cost_to_close)
    : r.kind === "rule"
      ? (onWatchlist(r) ? outOfHoursValue(r.entry) : undefined)
        ?? points(heldSpread(r) ? r.entry.cost_to_close : priceOf(r.entry))
      : "",
};

/** A rule's value and Δ as its desk row writes them (`VALUE`, `DELTA`): the phone's watch card says
 *  the same two, the same way (part K). */
export function ruleCells(entry: Entry, overlap: string | null = null): { value: string; delta: string } {
  const r: DeskRow = { kind: "rule", entry, nested: false, overlap };
  return { value: VALUE.text(r, false), delta: DELTA.text(r, false) };
}

/** A spread rule drawn as something held — under its holding, or on held contracts no holding
 *  owns — whose value cell says its COST TO CLOSE, positive, as the holding's own does (the owner,
 *  2026-11-16), and a dash where the service could not price it: never its signed value in its
 *  place. A spread on the watchlist keeps its signed value, a partial overlap (#346) included. */
export const heldSpread = (r: Extract<DeskRow, { kind: "rule" }>): boolean =>
  Boolean(r.entry.legs) && r.entry.held && !r.overlap;

/** The desk's value column (the owner, 2026-11-16): a holding's Cost to close with its pace gap
 *  beside it, "3.05 −1.57", in one field, where the two had a column each. The gap keeps its sign
 *  rule and its colour (#379) and is said in words beside the figure, to a pointer and a reader;
 *  no gap, the cost alone; no cost, a dash. Every other row is `VALUE`'s. The saved picture and Copy
 *  as text keep the two apart (`PLAIN_COLUMNS`), and the inspector lists both in its exit schedule
 *  (`DetailSections.tsx`): they are for reading later, where a field each is what a reader compares. */
const VALUE_AND_PACE: DeskColumn = {
  key: "value", label: "value",
  text: (r, privacy) => r.kind === "holding" ? costAndPace(r.holding).text : VALUE.text(r, privacy),
  words: (r, privacy) => r.kind === "holding" ? costAndPace(r.holding).words : VALUE.text(r, privacy),
};


/** A row the watchlist draws: an entry signal, or a combo drawn apart from the holding it partly
 *  overlaps (#346) — not a rule about something held, whose value is its cost to close. */
export const onWatchlist = (r: Extract<DeskRow, { kind: "rule" }>) => isEntrySignal(r.entry) || Boolean(r.overlap);

const PNL: DeskColumn = {
  key: "pnl", label: "P&L", text: holdingOnly((h, _, privacy) => moneyText(h.pnl, privacy)),
};

const CAPTURED: DeskColumn = {
  key: "captured", label: "captured", text: holdingOnly((h) => percent(h.captured)),
};

const DELTA: DeskColumn = {
  // a holding's SHORT LEG's delta; a spread's own (a signed sum of its legs, served); a contract's
  key: "delta", label: "Δ",
  text: (r) => r.kind === "holding" ? delta(shortLegDelta(r.holding, [...r.rules, ...(r.legRules ?? [])]))
    : r.kind === "rule"
      ? delta(r.entry.legs ? r.entry.combo_greeks?.option_delta : quoted(r.entry, "option_delta"))
      : "",
};

/** The strike strip a row draws (#297): a holding's, and a watched spread's on its own row. A
 *  combo under a holding is the holding's own strip again, so it draws none; a single contract is
 *  no spread. */
export function rowStrip(row: DeskRow): Strip | null {
  if (row.kind === "holding") return stripOfHolding(row.holding);
  if (row.kind === "rule" && !row.nested) return stripOfEntry(row.entry);
  return null;
}

const STRIP: DeskColumn = {
  // the scale is drawn beside these words, which are the nearest short strike's distance
  key: "strip", label: "SPX → short",
  text: (r) => { const s = rowStrip(r); return s ? cellWords(s) : ""; },
};

/** The compact strip's width, in characters: what `charsOf` adds for the drawing beside the words. */
const STRIP_CH = 10;

const DTE: DeskColumn = {
  key: "dte", label: "DTE",
  text: (r) => r.kind === "holding" ? String(r.holding.dte) : r.kind === "rule" ? String(r.entry.dte) : "",
};

const MANAGE: DeskColumn = {
  key: "manage", label: "manage-by",
  // days left, the threshold as detail (part F): one reader, `pace.manageBy`, for every surface
  text: holdingOnly((h) => manageBy(h).text),
};

const PACE_GAP: DeskColumn = {
  // Cost to close less on-pace (CONTEXT.md: Pace gap): BEHIND is costing more than the plan. Not
  // a column of the table since 2026-11-16 — the table draws the gap signed inside the value column
  // (`VALUE_AND_PACE`) — but the saved picture's column, which says it in words (`words`), as ADR
  // 0011 has a gap said wherever it is shown
  key: "pace_gap", label: "pace gap",
  text: holdingOnly((h) => h.schedule ? paceSigned(h.schedule.pace_gap) : DASH),
  words: holdingOnly((h) => h.schedule ? paceWords(h.schedule.pace_gap) : DASH),
};

const ALARM: DeskColumn = {
  // the old page called its rule column "alarm", and so does the cookie. It draws the rule's SHORT
  // form (#388) — "|value| ≥ 4.51   2.10  ↑2.41" — and says the sentence to a pointer and a reader,
  // as the pace gap does (#379), so nothing is lost to a hover or a screen reader
  key: "alarm", label: "rule", align: "left",
  // a holding's row draws its OWN rule here (2026-11-17), where it had a row of its own under it
  text: (r) => { const e = ruleOfRow(r); return e ? shortSentence(e) : r.kind === "quarantined" ? quarantineShort(r.monitor) : ""; },
  words: (r) => { const e = ruleOfRow(r); return e ? sentence(e) : r.kind === "quarantined" ? quarantineSentence(r.monitor) : ""; },
};

/** The columns, in the order they are DRAWN: one set at every hour (ADR 0023, amended 2026-11-13:
 *  one page, by the session; #372). The pace gap is drawn inside the value column since 2026-11-16
 *  (`VALUE_AND_PACE`), where it had a column of its own beside P&L and captured. */
export const COLUMNS: readonly DeskColumn[] = [
  NAME, LEGS, VALUE_AND_PACE, PNL, CAPTURED, DELTA, STRIP, DTE, MANAGE, ALARM,
];

/** The columns of the saved picture and of Copy as text (#394): the table's, with the value and the
 *  pace gap apart, as a reader comparing them later wants them (the owner, 2026-11-16). The pace gap
 *  goes with the value: hiding the value hides both, as it does on the screen. */
export const PLAIN_COLUMNS: readonly DeskColumn[] = [
  NAME, LEGS, VALUE, PNL, CAPTURED, PACE_GAP, DELTA, STRIP, DTE, MANAGE, ALARM,
];

/** Keys the desk once drew and no longer does: "on pace" and "DTE → manage-by" outside the session
 *  (#372), and "pace gap", in the value column since 2026-11-16. A viewer who hid one keeps it in
 *  the column cookie, where it hides nothing; the picker's reset clears them with the desk's own. */
export const RETIRED_KEYS: readonly string[] = ["on_pace", "to_manage", "pace_gap"];

export const PINNED = "name";

/** The tag after a holding's name (2026-11-17): the one book draws holdings and watches together, and
 *  this is what tells them apart — to a reader too, in the row's name. Watched rows carry none. */
export const HELD = "held";

/** The name column's width where the rule's column has dropped: its cell then also draws the rule's
 *  arrowed distance (the owner, 2026-11-17), so it needs that much more room. */
export const NAME_WITH_DISTANCE = "name+distance";

/** A rule row's arrowed distance in the short form its line draws — "↑3.60", "▲ past 0.05",
 *  "▲ at" — or "" where there is no figure or no distance: drawn in the name cell when the rule's
 *  column has dropped, where the fill bar fell back before (2026-11-17). */
export function distanceShort(row: DeskRow): string {
  const e = ruleOfRow(row);
  if (e === null || e.watched === null || e.distance === null) return "";
  return shortDistance(shapeOf(e), e.distance);
}

/** The order columns SURVIVE in, which is not the order they are drawn in. The widest goes last
 *  (ADR 0008): fitting stops at the first column that does not fit, so a wide column early on
 *  would starve every column behind it. The rule's sentence is the widest, and when it drops the
 *  inspector still says it whole. The pace gap survives
 *  as long as the value does, being drawn in it (2026-11-16). */
export const PRIORITY: readonly string[] = [
  "value", "pnl", "delta", "dte", "manage", "strip", "captured", "legs", "alarm",
];

/** Cell padding, in characters: half a character each side, plus the gap the grid leaves. */
const PAD_CH = 1.5;

/** How many characters a column needs, from the longest thing it will draw, its header included.
 *  The name cell also carries its chip and, nested, an indent. */
export function charsOf(column: DeskColumn, rows: readonly DeskRow[], privacy: boolean, session: boolean,
  withDistance = false): number {
  let longest = column.label.length;
  for (const r of rows) {
    let n = column.text(r, privacy).length;
    if (column.key === "name") {
      // the rule's arrowed distance beside the name, where the rule's column has dropped
      if (withDistance && distanceShort(r)) n += distanceShort(r).length + 1;
      const words = chipWords(r, session);
      // a chip is smaller type than the cell, but carries a glyph and its own padding
      if (words !== null) n += words.length + 4;
      // a holding's own rule's chip beside its Level's, and the "held" tag after its name
      const own = ownAttentionOf(r);
      if (own !== null) n += ATTENTION_WORDS[own].length + 4;
      if (r.kind === "holding") n += HELD.length + 2;
      if (r.kind === "rule" && r.nested) n += 2;
    }
    if (column.key === "strip" && n > 0) n += STRIP_CH + 1; // the scale beside the words
    longest = Math.max(longest, n);
  }
  return longest + PAD_CH;
}

/** Which columns to draw: the pinned name, then by priority while there is room, STOPPING at the
 *  first that does not fit — skipping it for a narrower one made widening a window lose a column
 *  (ADR 0008). Unlike the old page's tables this one has no sideways budget: the desk is wide, and the
 *  inspector beside it is where every figure is said whole. The hidden ones are the viewer's
 *  choice and are never drawn. Returned in the drawing order. */
export function fitColumns(
  available: number, hidden: ReadonlySet<string>, widthOf: (key: string) => number,
): DeskColumn[] {
  const kept = new Set([PINNED]);
  let used = widthOf(PINNED);
  const order: string[] = [];
  for (const key of PRIORITY) {
    if (hidden.has(key)) continue;
    const w = widthOf(key);
    if (used + w > available) break;
    kept.add(key);
    order.push(key);
    used += w;
  }
  // the rule's column gone, the name's cell draws each rule's distance too: room for it, made by
  // dropping the last columns kept until it fits
  const extra = kept.has("alarm") ? 0 : Math.max(0, widthOf(NAME_WITH_DISTANCE) - widthOf(PINNED));
  while (extra > 0 && used + extra > available && order.length > 0) {
    const last = order.pop()!;
    kept.delete(last);
    used -= widthOf(last);
  }
  return COLUMNS.filter((c) => kept.has(c.key));
}

/** What a column picker should offer: exactly the columns ticking would draw at this width. */
export function offerable(
  available: number, hidden: ReadonlySet<string>, widthOf: (key: string) => number,
): Set<string> {
  const out = new Set<string>();
  for (const key of PRIORITY) {
    const without = new Set(hidden);
    without.delete(key);
    if (fitColumns(available, without, widthOf).some((c) => c.key === key)) out.add(key);
  }
  return out;
}
