/** The desk table's columns, what each row says in them, and how many fit (ADR 0008, ADR 0023).
 *
 *  Pure: no React, no DOM. The table draws these, the inspector lists every one of them whether the
 *  table had room or not, and the fitting counts their characters — three readers of one text, as
 *  `columns.ts` arranges it for `/opt`, so the three cannot drift.
 *
 *  ONE table for the holdings and the watchlist, so one set of columns: a cell a row has nothing
 *  for is blank, not a dash, because a dash reads as "the figure has not arrived".
 *
 *  Every figure is one the service served. Nothing here models a price: a pace is the schedule's
 *  `on_pace` and `pace_gap`, the gap in words, never a curve drawn on screen (ADR 0023: "never draw what the system
 *  does not know"). The two pieces of arithmetic are a subtraction of two served day counts (days
 *  left before the Manage-by) and a share as a percentage.
 */
import type { Entry, Holding, Monitor } from "../../shared/api";
import { DASH, legSummary } from "../../shared/format";
import type { Mode } from "../mode";
import type { BookModel } from "../placement";
import { entryName, fieldWords, isEntrySignal, monitorName, QUARANTINED, sentence } from "../needs";
import { servedDelta } from "../legs";
import { paceWords } from "../pace";
import { cellWords, stripOfEntry, stripOfHolding, type Strip } from "../strip";

export type DeskRow =
  | { kind: "holding"; holding: Holding; rules: Entry[] }
  /** a rule as `/quotes` serves it; `nested` when it sits under a spread or a holding; `overlap`,
   *  the note of a combo drawn in the watchlist because it only partly overlaps a holding (#346) */
  | { kind: "rule"; entry: Entry; nested: boolean; overlap?: string | null }
  /** a rule the service switched off because it cannot evaluate it: only `/monitors` has it */
  | { kind: "quarantined"; monitor: Monitor };

export interface DeskColumn {
  /** Where a key is one `/opt`'s combo table also has, it IS that column, so the column choice
   *  made there (the `ui_cols_combo` cookie) carries over: hiding P&L there hides it here. */
  key: string;
  label: string;
  align?: "left";
  /** what the cell says, for the drawing, the inspector and the measuring alike; empty where the
   *  row has nothing to say in this column */
  text: (row: DeskRow, privacy: boolean) => string;
}

// ---- figures, with fixed decimals per field (ADR 0023)

const points = (n: number | null | undefined) => (n === null || n === undefined ? DASH : n.toFixed(2));
const delta = (n: number | null | undefined) => (n === null || n === undefined ? DASH : n.toFixed(3));
const share = (n: number | null) => (n === null ? DASH : `${Math.round(n * 100)}%`);

const MONEY = new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", maximumFractionDigits: 0, signDisplay: "exceptZero",
});

/** As `Money` in Book.tsx draws it: the same characters, so the measuring counts what is drawn. */
export function moneyText(value: number | null, privacy: boolean): string {
  if (value === null) return DASH;
  return privacy ? "$•••" : MONEY.format(value);
}

/** `-C7300 +C7350`: a holding's legs as the watchlist writes a combo's, short as minus. */
export function holdingLegs(holding: Holding): string {
  return holding.legs
    .map((l) => `${l.side === "short" ? "-" : "+"}${l.option_type[0]}${l.strike}`)
    .join(" ");
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
export function shortLegDelta(holding: Holding, rules: Entry[]): number | null {
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

/** What a quarantined rule watches and why nothing watches it now. */
export function quarantineSentence(m: Monitor): string {
  const sign = m.direction === "below" ? "≤" : "≥";
  const words = fieldWords(m.field, Boolean(m.legs));
  const why = (m.disabled_reason && QUARANTINED[m.disabled_reason]) ?? "switched off by the service";
  return `${m.compare === "abs" ? `|${words}|` : words} ${sign} ${m.threshold} — ${why}`;
}

/** Every row the table can draw, in the order it draws them: the fitting measures exactly these,
 *  and the inspector finds its row among them. */
export function tableRows(placed: BookModel): DeskRow[] {
  const out: DeskRow[] = [];
  for (const g of placed.holdings) {
    for (const p of g.rows.flat()) {
      out.push({ kind: "holding", holding: p.holding, rules: p.rules });
      for (const entry of p.rules) out.push({ kind: "rule", entry, nested: true });
    }
  }
  for (const entry of placed.unplaced) out.push({ kind: "rule", entry, nested: false });
  for (const g of placed.watchlist) {
    for (const i of g.items) {
      out.push({ kind: "rule", entry: i.entry, nested: false, overlap: i.overlap });
      for (const entry of i.under) out.push({ kind: "rule", entry, nested: true });
    }
  }
  for (const monitor of placed.quarantined) out.push({ kind: "quarantined", monitor });
  return out;
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
export type Attention = "fault" | "entry" | "alarm" | "stop" | "target" | "manage";

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

/** The chip's words, which are also what the measuring counts. */
export const ATTENTION_WORDS: Record<Attention, string> = {
  fault: "fault", entry: "entry signal", alarm: "ringing", stop: "at stop", target: "at target",
  manage: "manage-by",
};

// ---- the columns

const holdingOnly = (f: (h: Holding, rules: Entry[], privacy: boolean) => string) =>
  (row: DeskRow, privacy: boolean) => (row.kind === "holding" ? f(row.holding, row.rules, privacy) : "");

const NAME: DeskColumn = { key: "name", label: "spread", align: "left", text: (r) => rowName(r) };

const LEGS: DeskColumn = {
  key: "legs", label: "legs", align: "left",
  text: (r) => r.kind === "holding" ? holdingLegs(r.holding)
    : r.kind === "rule" && r.entry.legs ? legSummary(r.entry.legs) : "",
};

const VALUE: DeskColumn = {
  // a holding's Cost to close; a rule on held contracts, the cost to close of the contracts it
  // names; a watched spread's value — one drawn in the watchlist because it names a contract its
  // holding does not hold included (#346). The service serves that one no cost to close
  // (`costToCloseOf` is null unless every contract it names is held), except a ratio, whose repeated
  // contract it counts once: drawn as a watched spread, it shows its value. A single contract's mid
  key: "value", label: "value",
  text: (r) => r.kind === "holding" ? points(r.holding.cost_to_close)
    : r.kind === "rule"
      ? points(r.entry.legs
        ? (r.overlap ? r.entry.combo_value : (r.entry.cost_to_close ?? r.entry.combo_value))
        : quoted(r.entry, "mid_price"))
      : "",
};

const PNL: DeskColumn = {
  key: "pnl", label: "P&L", text: holdingOnly((h, _, privacy) => moneyText(h.pnl, privacy)),
};

const CAPTURED: DeskColumn = {
  key: "captured", label: "captured", text: holdingOnly((h) => share(h.captured)),
};

const DELTA: DeskColumn = {
  // a holding's SHORT LEG's delta; a spread's own (a signed sum of its legs, served); a contract's
  key: "delta", label: "Δ",
  text: (r) => r.kind === "holding" ? delta(shortLegDelta(r.holding, r.rules))
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
export const STRIP_CH = 10;

const DTE: DeskColumn = {
  key: "dte", label: "DTE",
  text: (r) => r.kind === "holding" ? String(r.holding.dte) : r.kind === "rule" ? String(r.entry.dte) : "",
};

const MANAGE: DeskColumn = {
  key: "manage", label: "manage-by",
  text: holdingOnly((h) => {
    const s = h.schedule;
    if (!s) return DASH;
    return s.manage_by_due ? "due" : `in ${h.dte - s.manage_by_dte}d`;
  }),
};

const ON_PACE: DeskColumn = {
  key: "on_pace", label: "on pace", text: holdingOnly((h) => h.schedule ? points(h.schedule.on_pace) : DASH),
};

const PACE_GAP: DeskColumn = {
  // Cost to close less on-pace, said in words (CONTEXT.md: Pace gap): BEHIND is costing more than
  // the plan, and a bare sign beside a P&L invites reading it the wrong way round (ADR 0011)
  key: "pace_gap", label: "pace gap",
  text: holdingOnly((h) => h.schedule ? paceWords(h.schedule.pace_gap) : DASH),
};

const TO_MANAGE: DeskColumn = {
  key: "to_manage", label: "DTE → manage-by",
  text: holdingOnly((h) => {
    const s = h.schedule;
    if (!s) return DASH;
    return s.manage_by_due ? `${h.dte} · due` : `${h.dte} → ${s.manage_by_dte}`;
  }),
};

const ALARM: DeskColumn = {
  // `/opt` calls its rule column "alarm", and so does its cookie
  key: "alarm", label: "rule", align: "left",
  text: (r) => r.kind === "rule" ? sentence(r.entry) : r.kind === "quarantined" ? quarantineSentence(r.monitor) : "",
};

/** The columns, in the order they are DRAWN. */
export const COLUMNS: Record<Mode, readonly DeskColumn[]> = {
  live: [NAME, LEGS, VALUE, PNL, CAPTURED, DELTA, STRIP, DTE, MANAGE, ALARM],
  // REVIEW is after the close, to understand: the outcome and the plan, not the market (ADR 0023)
  review: [NAME, LEGS, PNL, CAPTURED, ON_PACE, PACE_GAP, TO_MANAGE, ALARM],
};

export const PINNED = "name";

/** The order columns SURVIVE in, which is not the order they are drawn in. The widest goes last
 *  (ADR 0008): fitting stops at the first column that does not fit, so a wide column early on
 *  would starve every column behind it. The rule's sentence is the widest, and when it drops the
 *  fill bar moves into the name cell and the inspector still says it whole. */
export const PRIORITY: Record<Mode, readonly string[]> = {
  live: ["value", "pnl", "delta", "dte", "manage", "strip", "captured", "legs", "alarm"],
  review: ["pnl", "captured", "pace_gap", "on_pace", "to_manage", "legs", "alarm"],
};

/** Cell padding, in characters: half a character each side, plus the gap the grid leaves. */
const PAD_CH = 1.5;

/** How many characters a column needs, from the longest thing it will draw, its header included.
 *  The name cell also carries its chip and, nested, an indent; the rule cell its fill bar. */
export function charsOf(column: DeskColumn, rows: readonly DeskRow[], privacy: boolean): number {
  let longest = column.label.length;
  for (const r of rows) {
    let n = column.text(r, privacy).length;
    if (column.key === "name") {
      const a = attentionOf(r);
      // a chip is smaller type than the cell, but carries a glyph and its own padding
      if (a) n += ATTENTION_WORDS[a].length + 4;
      if (r.kind === "rule" && r.nested) n += 2;
    }
    if (column.key === "alarm" && n > 0) n += 6; // the fill bar beside the sentence
    if (column.key === "strip" && n > 0) n += STRIP_CH + 1; // the scale beside the words
    longest = Math.max(longest, n);
  }
  return longest + PAD_CH;
}

/** Which columns to draw: the pinned name, then by priority while there is room, STOPPING at the
 *  first that does not fit — skipping it for a narrower one made widening a window lose a column
 *  (ADR 0008). Unlike `/opt`'s table this one has no sideways budget: the desk is wide, and the
 *  inspector beside it is where every figure is said whole. The hidden ones are the viewer's
 *  choice and are never drawn. Returned in the drawing order. */
export function fitColumns(
  mode: Mode, available: number, hidden: ReadonlySet<string>, widthOf: (key: string) => number,
): DeskColumn[] {
  const kept = new Set([PINNED]);
  let used = widthOf(PINNED);
  for (const key of PRIORITY[mode]) {
    if (hidden.has(key)) continue;
    const w = widthOf(key);
    if (used + w > available) break;
    kept.add(key);
    used += w;
  }
  return COLUMNS[mode].filter((c) => kept.has(c.key));
}

/** What a column picker should offer: exactly the columns ticking would draw at this width. */
export function offerable(
  mode: Mode, available: number, hidden: ReadonlySet<string>, widthOf: (key: string) => number,
): Set<string> {
  const out = new Set<string>();
  for (const key of PRIORITY[mode]) {
    const without = new Set(hidden);
    without.delete(key);
    if (fitColumns(mode, available, without, widthOf).some((c) => c.key === key)) out.add(key);
  }
  return out;
}
