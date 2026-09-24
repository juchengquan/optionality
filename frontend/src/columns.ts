import type { Entry } from "./api";
import { FIELD_COLUMN } from "./format";

export interface Column {
  key: string;
  label: string;
}

/** Identity only. "actions" was here until the detail sheet took the controls (ADR
 *  0008) — a number box and three buttons per row could not survive a narrow screen,
 *  and full parity meant the operations could not go with it. */
export const PROTECTED = new Set(["contract", "combo"]);

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
  contract: 170, combo: 140, alarm: 110, dte: 46, entry: 66, value: 66, pnl: 70,
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
): Column[] {
  const all = table === "single" ? SINGLE_COLUMNS : COMBO_COLUMNS;
  const byKey = new Map(all.map((c) => [c.key, c]));
  const identity = table === "single" ? "contract" : "combo";

  const kept: string[] = [identity];
  let used = WIDTH[identity] ?? DEFAULT_WIDTH;

  for (const key of PRIORITY[table]) {
    if (key === identity || hidden.has(key) || !byKey.has(key)) continue;
    const w = WIDTH[key] ?? DEFAULT_WIDTH;
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
export function offerable(table: "single" | "combo", available: number): Set<string> {
  const identity = table === "single" ? "contract" : "combo";
  const base = WIDTH[identity] ?? DEFAULT_WIDTH;
  return new Set(
    PRIORITY[table].filter(
      (k) => k !== identity && base + (WIDTH[k] ?? DEFAULT_WIDTH) <= available,
    ),
  );
}
