import type { Entry } from "./api";
import { greekText, heldText, quoteText } from "./cells";
import {
  alarmText, DASH, FIELD_COLUMN, fmt, legSummary, shortContract, shortDate, shortStamp,
} from "./format";

/** What the columns ARE, and how many of them fit (ADR 0008).
 *
 *  Not where the viewer's answers are kept: which columns a table hides, which reading earns the
 *  colour and the band it must clear were all read and written here, because two of the six
 *  preferences happen to be about columns. They live in `prefs.ts` now, which imports this module
 *  for `isPinned` and `DEFAULT_BAND` — one way, so the arithmetic below never reaches for a
 *  cookie.
 */

/** ONE column, stated once.
 *
 *  A column key used to appear in five places across two files — a label here, a line in the
 *  priority order, a pixel width in a `WIDTH` record, a membership in a `LEFT` set, and an arm of
 *  a `switch` in `cells.ts` — and only the priority order said anything when it was missed. A
 *  forgotten width silently became a 64px default nobody chose; a forgotten `LEFT` silently
 *  right-aligned a name; a forgotten switch arm silently drew a dash, FOR EVER, because the detail
 *  sheet lists every column whether the table has room for it or not. Adding `rho` to the list and
 *  nothing else failed exactly one test, by printing two unequal lists of column keys.
 *
 *  So a column is a descriptor, the way a market-data vendor is one (`backend/src/vendors.ts`):
 *  everything about it in one object, and leaving any of it out is a type error. The priority order
 *  stays a list of its own — see PRIORITY, it is a genuinely different fact — but it is typed to
 *  these keys and held to them by `Fitting.test.ts`.
 */
export interface Column {
  key: string;
  label: string;
  /** left for text, nothing for a figure. Figures are right-aligned so their digits line up, and
   *  that is the default because most of these are figures. */
  align?: "left";
  /** Roughly how wide this column needs to be, in CSS pixels at the default text size.
   *
   *  A starting estimate only, and the fitting prefers measured widths wherever it has them
   *  (`widthsFromContent`): a pixel guess cannot survive the reader changing their text size, since
   *  the viewport stays the same while what fits does not. What it is still for is letting the rule
   *  be written and tested without a browser, and deciding the priority order's own shape — the
   *  widest column has to go last. */
  estimate: number;
  /** What a row says in this column, as text. Pure, and asked by all three callers: the table
   *  draws it, the detail sheet lists it whether or not the table had room, and the fitting counts
   *  its characters. `isCombo` is not cosmetic — a combo's greeks are signed sums of its legs and
   *  never a quote's figures. */
  text: (entry: Entry, isCombo: boolean) => string;
}

/** The lists the key TYPES are read from. Exported below as `readonly Column[]`, so a caller can
 *  ask any column for its `align` without the union of a dozen literal object types. */
const SINGLE = [
  {
    key: "contract", label: "contract", align: "left",
    // "261016 8050C", not "SPXW 261016 8050.00C" — see shortContract, which is also why this
    // estimate is 120 rather than the 165 the served name would need
    estimate: 120,
    // DRAWN by WatchlistTable, badge and bell and all. It still answers here, because the fitting
    // measurement asks every column how wide it has to be and this is the widest on the page.
    text: (e) => shortContract(e.quote?.name ?? e.code),
  },
  {
    key: "alarm", label: "alarm", align: "left", estimate: 110,
    text: (e) => alarmText(e.field, e.direction, e.threshold, e.compare),
  },
  { key: "dte", label: "dte", estimate: 46, text: (e) => String(e.dte) },
  {
    key: "delta", label: "delta", estimate: 62,
    text: (e, isCombo) => greekText(e, isCombo, "option_delta", "delta"),
  },
  {
    key: "gamma", label: "gamma", estimate: 74,
    text: (e, isCombo) => greekText(e, isCombo, "option_gamma", "gamma"),
  },
  {
    key: "theta", label: "theta", estimate: 62,
    text: (e, isCombo) => greekText(e, isCombo, "option_theta", "theta"),
  },
  {
    key: "vega", label: "vega", estimate: 58,
    text: (e, isCombo) => greekText(e, isCombo, "option_vega", "vega"),
  },
  {
    key: "iv", label: "IV", estimate: 58,
    text: (e) => quoteText(e, "option_implied_volatility", "iv"),
  },
  { key: "mid", label: "mid", estimate: 62, text: (e) => quoteText(e, "mid_price", "mid") },
  { key: "bid", label: "bid", estimate: 62, text: (e) => quoteText(e, "bid_price", "bid") },
  { key: "ask", label: "ask", estimate: 62, text: (e) => quoteText(e, "ask_price", "ask") },
  {
    key: "last_trade", label: "last trade", estimate: 140,
    // without the zone it repeats on every row (format.shortStamp). The DATE stays: a far strike
    // can go days without a print, and a bare clock would read as this morning.
    text: (e) => (e.quote?.update_time ? shortStamp(e.quote.update_time) : DASH),
  },
] as const satisfies readonly Column[];

const COMBO = [
  { key: "combo", label: "combo", align: "left", estimate: 110, text: (e) => e.code },
  {
    key: "alarm", label: "alarm", align: "left", estimate: 110,
    text: (e) => alarmText(e.field, e.direction, e.threshold, e.compare),
  },
  { key: "dte", label: "dte", estimate: 46, text: (e) => String(e.dte) },
  {
    key: "value", label: "value", estimate: 66,
    text: (e) => fmt(e.cost_to_close ?? e.combo_value ?? null, "mid"),
  },
  {
    // the on-pace LEVEL, next to the value it is read against. A level rather than the gap, so
    // there is no convention about which way a signed number points (ADR 0011).
    key: "on_pace", label: "on pace", estimate: 72,
    // blank rather than a dash-or-zero where there is no declared holding: a 0.00 here would
    // read as "exactly on pace", which is the opposite of "no schedule"
    text: (e) => (e.schedule?.on_pace == null ? "" : fmt(e.schedule.on_pace, "mid")),
  },
  {
    // entry sits between value and P&L: what it is worth now, what it cost, the difference.
    // Entry used to precede value, which left it two columns from the figure it explains.
    key: "entry", label: "entry", align: "left", estimate: 66,
    text: (e) => heldText(e, e.entry),
  },
  { key: "pnl", label: "P&L", estimate: 70, text: (e) => heldText(e, e.pnl) },
  {
    // the leg summary and the expiry used to be a second line inside the name cell, which
    // meant they were drawn unconditionally while every other figure had to earn its place.
    // As columns they drop like anything else and the picker can turn them off.
    key: "legs", label: "legs", estimate: 210,
    text: (e) => (e.legs ? legSummary(e.legs) : DASH),
  },
  {
    key: "expiry", label: "expiry", estimate: 70,
    text: (e) => shortDate(e.strike_date),
  },
  {
    key: "delta", label: "delta", estimate: 62,
    text: (e, isCombo) => greekText(e, isCombo, "option_delta", "delta"),
  },
  {
    key: "gamma", label: "gamma", estimate: 74,
    text: (e, isCombo) => greekText(e, isCombo, "option_gamma", "gamma"),
  },
  {
    key: "theta", label: "theta", estimate: 62,
    text: (e, isCombo) => greekText(e, isCombo, "option_theta", "theta"),
  },
  {
    key: "vega", label: "vega", estimate: 58,
    text: (e, isCombo) => greekText(e, isCombo, "option_vega", "vega"),
  },
] as const satisfies readonly Column[];

export const SINGLE_COLUMNS: readonly Column[] = SINGLE;
export const COMBO_COLUMNS: readonly Column[] = COMBO;

/** The keys each table has, as a type. A column named in `ALWAYS` or `PRIORITY` that no descriptor
 *  describes is a compile error rather than a column that is never drawn. */
export type SingleColumnKey = (typeof SINGLE)[number]["key"];
export type ComboColumnKey = (typeof COMBO)[number]["key"];

/** Columns that are always drawn: never dropped for width, never offered in the picker.
 *
 *  Identity, because a row you cannot name is not a row. And delta on the single-leg table,
 *  because every single-leg rule in this watchlist watches option_delta — a single-leg row
 *  without it does not say what its alarm is about. Combos are left alone: their rules watch
 *  the combo's value, which is pinned in their own order instead.
 *
 *  "actions" was here until the detail sheet took the controls (ADR 0008).
 */
export const ALWAYS: {
  single: readonly SingleColumnKey[];
  combo: readonly ComboColumnKey[];
} = {
  single: ["contract", "delta"],
  combo: ["combo"],
};

/** Is this column pinned on THIS table?
 *
 *  It used to be one PROTECTED set unioned across both tables, and that is wrong in exactly one
 *  place, which happens to be the place that matters: `delta` is pinned on the single-leg table
 *  and an ORDINARY column on a combo. The union meant the combo picker drew no delta checkbox at
 *  all and readHidden silently discarded `delta` from the combo cookie — so the one column the
 *  owner asked to see on that table was the one column it could not control.
 */
export const isPinned = (table: "single" | "combo", key: string): boolean =>
  (ALWAYS[table] as readonly string[]).includes(key);

/** What the second colour is earned against, and the band it has to clear.
 *
 *  "distance" is the fill as it has always been: how far the value has travelled toward its
 *  threshold. That is the honest reading, because the band is a fact about the ALARM rather than a
 *  judgement about the trade — one small move and Telegram sends, whether expiry is tomorrow or in
 *  seven weeks.
 *
 *  "pressure" makes the other claim on purpose: it weighs that distance by how little time is
 *  left, so a 99% at 48 DTE sits quiet and a 70% at 3 DTE does not. Measured on 2026-10-17, the
 *  live book was 99/97/94/94/88/53/49 at 44-48 DTE — four rows wearing a colour meant to be rare,
 *  with the loudest of them the least urgent thing owned.
 *
 *  Neither touches the bar, which is always the distance. Length says how close; colour says
 *  whether that closeness has been earned. Two channels, two meanings.
 */
export type Signal = "distance" | "pressure";

/** Where "about to fire" begins.
 *
 *  A third colour between watching and fired, and deliberately NOT a gradient. Fill measures
 *  distance to a threshold the owner chose, and across their book the highest fill has the
 *  MOST time left — so colouring by fill would shout loudest at the calmest row. This band is
 *  defensible only because "about to fire" is a fact about the ALARM rather than a judgement
 *  about the trade: one small move and a Telegram message goes out.
 *
 *  90 was a suggestion, not a finding. Move it. The band is worth having only while it stays
 *  rare — the book sits between 36% and 85% on an ordinary day, and a colour half the rows
 *  wear says nothing.
 *
 *  It was two exported names for the number 90 — an `IMMINENT_FILL` carrying this comment, and a
 *  `DEFAULT_BAND = IMMINENT_FILL` nineteen lines below it that was the only thing reading it.
 */
export const DEFAULT_BAND = 90;

/** The horizon is the manage-by DTE, served by /health so this is not a second copy of 21. */
export function pressure(fill: number, dte: number, horizon: number): number {
  if (horizon <= 0) return fill;
  // inside the horizon there is nothing left to discount: close really is urgent there
  return (fill * horizon) / Math.max(dte, horizon);
}

export function imminentReading(
  fill: number, dte: number, signal: Signal, horizon: number,
): number {
  return signal === "pressure" ? pressure(fill, dte, horizon) : fill;
}

/** How the rows are divided up inside a table.
 *
 *  Calls and puts because the two wings of a credit structure are the two halves of the question
 *  "which side is moving"; expiry because a watchlist with several of them interleaves them, and
 *  "what is happening to the 11-30s" is the other way to read the same book.
 *
 *  It PARTITIONS and never sorts: each group keeps the order the table already had, which is the
 *  order the service returns. Grouping should not quietly become a re-sort.
 */
export type Grouping = "none" | "type" | "expiry";

/** CALL, PUT, or MIXED for a structure holding both — a condor is both and neither, and calling
 *  it one of them would file half of it under the wrong heading. A spread's kind comes from its
 *  LEGS rather than the CMB it is stored as. */
export function rowKind(entry: Entry): "CALL" | "PUT" | "MIXED" {
  const legs = entry.legs;
  if (legs && legs.length > 0) {
    const kinds = new Set(legs.map((l) => l.option_type));
    if (kinds.size === 1) return legs[0]!.option_type === "PUT" ? "PUT" : "CALL";
    return "MIXED";
  }
  return entry.option_type === "PUT" ? "PUT" : "CALL";
}

export interface RowGroup {
  /** null draws no divider: one group covering the whole table is not information, and on a phone
   *  it costs a row of height to say nothing. */
  label: string | null;
  rows: Entry[];
}

const KIND_ORDER = ["CALL", "PUT", "MIXED"] as const;
const KIND_LABEL = { CALL: "calls", PUT: "puts", MIXED: "both sides" } as const;

export function groupRows(entries: Entry[], grouping: Grouping): RowGroup[] {
  if (grouping === "none" || entries.length === 0) return [{ label: null, rows: entries }];

  const buckets = new Map<string, Entry[]>();
  for (const entry of entries) {
    const key = grouping === "type" ? rowKind(entry) : entry.strike_date;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(entry); else buckets.set(key, [entry]);
  }
  // calls above puts, the way the wings are drawn; expiries nearest first, which the ISO date
  // sorts as text
  const keys = [...buckets.keys()].sort(grouping === "type"
    ? (a, b) => KIND_ORDER.indexOf(a as "CALL") - KIND_ORDER.indexOf(b as "CALL")
    : (a, b) => a.localeCompare(b));

  if (keys.length === 1) return [{ label: null, rows: entries }];
  return keys.map((key) => {
    const rows = buckets.get(key)!;
    const label = grouping === "type"
      ? KIND_LABEL[key as keyof typeof KIND_LABEL]
      // the DTE is the part worth reading, and it is the same for every row in the group
      : `${shortDate(key)} · ${rows[0]!.dte} dte`;
    return { label, rows };
  });
}

/** The columns a table draws when the viewer has unticked some, with no width involved — the
 *  snapshot renders at a width of its own and states its columns rather than measuring them. */
export function shownColumns(all: readonly Column[], hidden: Set<string>): Column[] {
  return all.filter((c) => !hidden.has(c.key));
}

/** Where a row's fill bar and bell go, given what is visible. Both normally live in
 *  hideable cells, so each falls back along a chain ending at the protected identity
 *  column — a breach can never be hidden by unticking a box. */
export function signalColumns(entry: Entry, isCombo: boolean, shown: Set<string>): {
  fill: string;
  bell: string;
} {
  const identity = isCombo ? "combo" : "contract";
  const watched = isCombo ? "value" : FIELD_COLUMN[entry.field];
  // the chain TERMINATES at the identity column, which ALWAYS pins on both tables and `readHidden`
  // refuses to hide — so the find cannot come back empty. It carried a `?? identity` fallback as
  // well, which looked like the guard and was unreachable: two guards for one claim means neither
  // is the one being checked.
  const fill = [watched, "alarm", identity].find((c) => c && shown.has(c))!;
  return { fill, bell: shown.has("alarm") ? "alarm" : identity };
}

const ESTIMATE: Record<string, number> = Object.fromEntries(
  [...SINGLE_COLUMNS, ...COMBO_COLUMNS].map((c) => [c.key, c.estimate]),
);

/** The fallback estimate for one column, by key, so the priority order can be checked against the
 *  same numbers the fitting rule uses.
 *
 *  Unknown keys THROW rather than taking a default. They cannot happen — `ALWAYS` and `PRIORITY`
 *  are typed to the descriptors and the fitting never invents a key — and the default they used to
 *  take was 64px, which is how a column could be half-added and look plausible while being
 *  measured against a number nobody chose.
 */
export const columnWidth = (key: string): number => {
  const estimate = ESTIMATE[key];
  if (estimate === undefined) throw new Error(`no column is described as "${key}"`);
  return estimate;
};

/** Which columns survive when there is not room for all of them.
 *
 *  A list of its own, and not a field on the descriptor, because the order a column is DRAWN in and
 *  the order it survives narrowing are two different facts: the widest column has to go last here
 *  while sitting wherever the table reads best. Typed to each table's keys, and held to them by
 *  `Fitting.test.ts` — a column added to a table and forgotten here would simply never be drawn.
 *
 *  THE WIDEST COLUMN GOES LAST. The loop below stops at the first column that does not fit
 *  rather than skipping it, because skipping made widening a window LOSE columns (ADR 0008) —
 *  and the price of stopping is that one wide column starves everything behind it. The single
 *  table was only ever well behaved by luck: its widest, `last_trade`, happens to be last.
 *  The combo table had `legs` — the widest column on either table — in the middle, so at 390px
 *  it drew six columns against the single table's nine, and expiry, delta, theta, vega and
 *  gamma could not be reached however they were ticked. That is the bug this ordering fixes;
 *  `Fitting.test.ts` asserts the rule rather than this list.
 */
export const PRIORITY: { single: SingleColumnKey[]; combo: ComboColumnKey[] } = {
  // delta and mid first because every rule in this watchlist is built on one of them;
  // the greeks nothing watches go last, together, because that is what the sheet is for
  single: ["contract", "alarm", "delta", "mid", "dte", "bid", "ask", "iv", "theta", "vega", "gamma", "last_trade"],
  // entry sits against P&L: it is the number the P&L is computed from, so distrusting one
  // means wanting the other beside it.
  //
  // delta is now ahead of the other greeks and of `legs`, because the owner asked for it on
  // this table: the combo's rules watch its value, but its delta is how far the position has
  // drifted toward the strike it was sold against. `legs` last — an unfamiliar combo is
  // identified by its legs, but these names already carry the strikes (1120_IC_7100_8200),
  // the detail sheet shows the legs whatever the table does, and at 263px it is the one
  // column wide enough to cost four others.
  combo: ["combo", "alarm", "value", "on_pace", "pnl", "entry", "dte", "delta", "expiry", "theta", "vega", "gamma", "legs"],
};

/** How much wider than its container the table may be.
 *
 *  The container scrolls sideways, and the owner would rather swipe than lose figures — so
 *  fitting exactly inside the screen was too strict. This is what stops it becoming an
 *  endless sideways scroll instead: roughly two screens, and the name column stays frozen
 *  so swiping never costs you the row you are reading. ADR 0008 records why this reversed.
 */
export const SCROLL_BUDGET = 2.2;

/** Which columns to draw, given the room available and what the viewer asked for.
 *
 *  Width wins and the picker is a wish list: ticking a column means "show this when there
 *  is room", unticking still hides it absolutely. The identity column is never dropped —
 *  a row you cannot identify is not a row — so it is kept even when nothing fits.
 */
export function columnsFor(
  table: "single" | "combo",
  available: number,
  hidden: Set<string>,
  widthOf: (key: string) => number = columnWidth,
): Column[] {
  const all = table === "single" ? SINGLE_COLUMNS : COMBO_COLUMNS;
  const byKey = new Map(all.map((c) => [c.key, c]));

  const budget = Number.isFinite(available) ? available * SCROLL_BUDGET : available;
  const always = ALWAYS[table] as readonly string[];
  const kept: string[] = [...always];
  // the pinned columns are spent first and never checked against the room available: they
  // are the reason the table is worth looking at, and .table-scroll catches the rest
  let used = always.reduce((n, k) => n + widthOf(k), 0);

  for (const key of PRIORITY[table]) {
    if (always.includes(key) || hidden.has(key) || !byKey.has(key)) continue;
    const w = widthOf(key);
    // STOP rather than skip. Skipping to a narrower column further down the order means a
    // window widened by twenty pixels can swap one column for another instead of simply
    // gaining one, and columns that appear and vanish as you drag are worse than columns
    // that are merely absent.
    if (used + w > budget) break;
    kept.push(key);
    used += w;
  }

  // drawn in the table's own order, not the priority order: priority decides WHICH
  // columns survive, never where they sit, or the layout would rearrange as you resize
  return all.filter((c) => kept.includes(c.key));
}

/** What the picker should offer at this width: exactly the columns that ticking would draw.
 *
 *  This used to measure each column ALONE against the width — `pinned + this column` — while
 *  the drawing loop spends the budget cumulatively and stops at the first miss. The two
 *  disagreed, so the combo picker at 390px offered five columns that no amount of ticking
 *  could reveal: the box went on, nothing happened, and the table looked broken. The honest
 *  question is not "is there room for this column in the abstract" but "if I turn this on, do
 *  I see it", so that is what is asked — of the drawing rule itself, which cannot drift from it.
 *
 *  It depends on what else is hidden, and should: unticking a wide column is how you make room
 *  for a narrow one, and the picker re-renders with the new answer.
 */
export function offerable(
  table: "single" | "combo",
  available: number,
  hidden: Set<string> = new Set(),
  widthOf: (key: string) => number = columnWidth,
): Set<string> {
  const always = ALWAYS[table] as readonly string[];
  const out = new Set<string>();
  for (const key of PRIORITY[table]) {
    if (always.includes(key)) continue;
    const without = new Set(hidden);
    without.delete(key);
    if (columnsFor(table, available, without, widthOf).some((c) => c.key === key)) out.add(key);
  }
  return out;
}

/** The badges drawn beside the name, in the order they appear.
 *
 *  A LEG rule — one watching part of a holding — said so in the table only by what it did not
 *  draw: entry, P&L and on-pace are blank for it, and blank for a rule holding nothing too, so
 *  the two read identically. Recording 1130_8100 on 2026-10-20 turned the adjacent 1130_8150 into
 *  a leg rule and nothing on its row changed; the distinction existed only in the detail sheet,
 *  which says it in a full sentence because it has the room.
 *
 *  It lives HERE, beside `widthsFromContent`, because a badge is width: the fitting is told in
 *  text how wide a column must be (ADR 0008), and the identity column is the one frozen at every
 *  scroll position. Carried as a wrapper around the row-to-text function first — which left the
 *  allowance one call site away from the measuring, and a mutation sweep showed that call site
 *  could be reverted with every test still green. Nothing passes it now; the measuring reads it.
 */
export function identityBadges(entry: Entry): { text: string; title?: string; quiet?: boolean }[] {
  const out: { text: string; title?: string; quiet?: boolean }[] = [];
  // a quarantined contract, and the only badge there has ever been: red, because it is a fault
  if (entry.error) out.push({ text: entry.error });
  // `positions` and not `scope` alone: an unlinked rule has no scope either, and it is precisely
  // that row this has to look different from
  if (entry.scope === "leg" && entry.positions.length > 0) {
    out.push({
      text: "leg",
      // terse in the cell, whole on hover: the holding's name is what you came to the row to
      // learn, and the sheet states it in full for anyone without a pointer
      title: `part of ${entry.positions.map((p) => p.name).join(", ")}`,
      quiet: true,
    });
  }
  return out;
}

/** Column widths derived from what is actually in the table, not guessed.
 *
 *  A pixel estimate cannot survive the reader changing their text size: the viewport is
 *  unchanged while the amount that fits is not. So widths are counted in CHARACTERS —
 *  the longest thing this column will actually draw, header included — and multiplied by
 *  the width of one character in the font the table is really using. That makes the result
 *  respond to both the data and the text size, with no probe table to render.
 *
 *  Figures are tabular-nums, so every digit is the same width and counting characters is
 *  exact for them. It is an approximation only for the identity column's proportional
 *  text, which is why CELL_PADDING carries a little slack.
 */
export function widthsFromContent(
  columns: readonly Column[],
  rows: readonly Entry[],
  isCombo: boolean,
  charWidth: number,
): Record<string, number> {
  const CELL_PADDING = 22; // 10px each side plus the border, per app.css
  const out: Record<string, number> = {};
  for (const c of columns) {
    let longest = c.label.length;
    // the badges are drawn beside the name, so the identity column has to be measured with them
    const extra = c.key === (isCombo ? "combo" : "contract")
      ? (r: Entry) => identityBadges(r).reduce((n, b) => n + b.text.length + 1, 0)
      : () => 0;
    for (const r of rows) {
      longest = Math.max(longest, c.text(r, isCombo).length + extra(r));
    }
    out[c.key] = Math.ceil(longest * charWidth) + CELL_PADDING;
  }
  return out;
}
