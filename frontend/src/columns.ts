import type { Entry } from "./api";
import { FIELD_COLUMN } from "./format";

export interface Column {
  key: string;
  label: string;
}

/** Columns that are always drawn: never dropped for width, never offered in the picker.
 *
 *  Identity, because a row you cannot name is not a row. And delta on the single-leg table,
 *  because every single-leg rule in this watchlist watches option_delta — a single-leg row
 *  without it does not say what its alarm is about. Combos are left alone: their rules watch
 *  the combo's value, which is pinned in their own order instead.
 *
 *  "actions" was here until the detail sheet took the controls (ADR 0008).
 */
export const ALWAYS: Record<"single" | "combo", readonly string[]> = {
  single: ["contract", "delta"],
  combo: ["combo"],
};

export const PROTECTED = new Set([...ALWAYS.single, ...ALWAYS.combo]);

export const SINGLE_COLUMNS: Column[] = [
  { key: "contract", label: "contract" }, { key: "alarm", label: "alarm" },
  { key: "dte", label: "dte" }, { key: "delta", label: "delta" },
  { key: "gamma", label: "gamma" }, { key: "theta", label: "theta" },
  { key: "vega", label: "vega" }, { key: "iv", label: "IV" },
  { key: "mid", label: "mid" }, { key: "bid", label: "bid" },
  { key: "ask", label: "ask" }, { key: "last_trade", label: "last trade" },
];

export const COMBO_COLUMNS: Column[] = [
  { key: "combo", label: "combo" }, { key: "alarm", label: "alarm" },
  { key: "dte", label: "dte" }, { key: "value", label: "value" },
  // entry sits between value and P&L: what it is worth now, what it cost, the difference.
  // Entry used to precede value, which left it two columns from the figure it explains.
  { key: "entry", label: "entry" }, { key: "pnl", label: "P&L" },
  { key: "delta", label: "delta" }, { key: "gamma", label: "gamma" },
  { key: "theta", label: "theta" }, { key: "vega", label: "vega" },
];

export const LEFT = new Set(["contract", "combo", "alarm", "entry"]);

/** The cookie stores what is HIDDEN, not what is kept, so a column added later shows up by
 *  default instead of staying invisible. "." separates because a comma makes the value
 *  quote-escaped and it stops round-tripping. Same names as /ui, so both agree. */
export function readHidden(table: "single" | "combo"): Set<string> {
  const raw = document.cookie
    .split("; ")
    .find((c) => c.startsWith(`ui_cols_${table}=`))
    ?.split("=")[1];
  const value = raw ? decodeURIComponent(raw).replace(/^"|"$/g, "") : "";
  return new Set(value.split(".").filter((k) => k && !PROTECTED.has(k)));
}

export function writeHidden(table: "single" | "combo", hidden: Set<string>): void {
  const value = [...hidden].sort().join(".");
  document.cookie = `ui_cols_${table}=${value};path=/;max-age=31536000;samesite=lax`;
}

export function visible(all: Column[], hidden: Set<string>): Column[] {
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
  const fill = [watched, "alarm", identity].find((c) => c && shown.has(c)) ?? identity;
  return { fill, bell: shown.has("alarm") ? "alarm" : identity };
}

/** Roughly how wide each column needs to be, in CSS pixels at the default text size.
 *
 *  These are a starting estimate only. Phase 4 replaces them with real measurement (ADR
 *  0008), because a pixel guess cannot survive the reader changing their text size — the
 *  viewport stays the same while what fits does not. Until then they let the rule be
 *  written and tested without a browser.
 */
const WIDTH: Record<string, number> = {
  // "261016 8050C" now, not "SPXW 261016 8050.00C" — see shortContract
  contract: 120, combo: 140, alarm: 110, dte: 46, entry: 66, value: 66, pnl: 70,
  delta: 62, gamma: 74, theta: 62, vega: 58, iv: 58, mid: 62, bid: 62, ask: 62,
  last_trade: 140,
};
const DEFAULT_WIDTH = 64;

export const PRIORITY: Record<"single" | "combo", string[]> = {
  // delta and mid first because every rule in this watchlist is built on one of them;
  // the greeks nothing watches go last, together, because that is what the sheet is for
  single: ["contract", "alarm", "delta", "mid", "dte", "bid", "ask", "iv", "theta", "vega", "gamma", "last_trade"],
  // entry sits against P&L: it is the number the P&L is computed from, so distrusting one
  // means wanting the other beside it
  combo: ["combo", "alarm", "value", "pnl", "entry", "dte", "delta", "theta", "vega", "gamma"],
};

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
  widthOf: (key: string) => number = (k) => WIDTH[k] ?? DEFAULT_WIDTH,
): Column[] {
  const all = table === "single" ? SINGLE_COLUMNS : COMBO_COLUMNS;
  const byKey = new Map(all.map((c) => [c.key, c]));

  const always = ALWAYS[table];
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
    if (used + w > available) break;
    kept.push(key);
    used += w;
  }

  // drawn in the table's own order, not the priority order: priority decides WHICH
  // columns survive, never where they sit, or the layout would rearrange as you resize
  return all.filter((c) => kept.includes(c.key));
}

/** What the picker should offer at this width. A column that cannot appear however it is
 *  ticked is not offered, so ticking is never silently ignored. */
export function offerable(
  table: "single" | "combo",
  available: number,
  widthOf: (key: string) => number = (k) => WIDTH[k] ?? DEFAULT_WIDTH,
): Set<string> {
  const always = ALWAYS[table];
  const base = always.reduce((n, k) => n + widthOf(k), 0);
  return new Set(
    PRIORITY[table].filter((k) => !always.includes(k) && base + widthOf(k) <= available),
  );
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
  columns: Column[],
  rows: readonly Entry[],
  isCombo: boolean,
  charWidth: number,
  cellText: (row: Entry, key: string, isCombo: boolean) => string,
  subText?: (row: Entry, key: string, isCombo: boolean) => string,
): Record<string, number> {
  const CELL_PADDING = 22; // 10px each side plus the border, per app.css
  // the combo cell's second line renders at 0.78rem (.legs in app.css), so counting its
  // characters at full width would demand a column half again as wide as it needs
  const SUB_SCALE = 0.78;
  const out: Record<string, number> = {};
  for (const c of columns) {
    let longest = c.label.length;
    for (const r of rows) {
      longest = Math.max(longest, cellText(r, c.key, isCombo).length);
      // a cell can render MORE than cellText returns — the combo identity draws a leg
      // summary underneath, and measuring the name alone asked for a fifth of the room
      if (subText) longest = Math.max(longest, subText(r, c.key, isCombo).length * SUB_SCALE);
    }
    out[c.key] = Math.ceil(longest * charWidth) + CELL_PADDING;
  }
  return out;
}
