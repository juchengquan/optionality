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
  { key: "dte", label: "dte" }, { key: "entry", label: "entry" },
  { key: "value", label: "value" }, { key: "pnl", label: "P&L" },
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
