/** How the bot writes things. Ported from telegram_bot.py (ADR 0009, phase 7).
 *
 *  Telegram has no table markup, so a `<pre>` block with space-aligned columns is the idiom. The rules
 *  are ratified (CLAUDE.md): about forty monospace characters a row, four columns at most, and a new
 *  question gets a new command rather than a fifth column. `<pre>` with HTML parse mode is used ONLY
 *  for table replies — a plain reply must not be parsed as HTML, or a threshold written `<0.6` would
 *  vanish into a tag.
 *
 *  Every string here is asserted character for character in the tests, because they are read on a
 *  phone and a column that wraps is a table that cannot be read at all.
 */
import { thresholdFault } from "../domain/monitor.ts";
import type { HoldingValue } from "../holdings.ts";

export const HELP_TEXT = `Commands:
/holdings — where each Position stands: cost, P&L, pace
/monitors — list the watchlist with live state
/quotes — live prices (mid, bid/ask) for every watched code
/greeks — live delta/gamma/theta for every watched code
/vol — live IV/vega for every watched code
/watch <date> <CALL|PUT> <strike> <threshold> [field] [above|below] [signed] — add a monitor
/watchcombo <name> <date> <±C|Pstrike ...> <threshold> [field] [above|below] [signed] — watch a combo
/unwatch <name, code, id prefix, or contract like 260918 C8100> — remove a monitor
/combo <name> — per-leg breakdown of a combo
/threshold <name or contract> <value> — change a monitor's threshold
/rename <old> <new> — rename a combo (keeps its alarm state and history)
/snapshot <date> <CALL|PUT> <strike> — live quote
(leg signs: − short, the leg you sold; + long)
(dates: YYYY-MM-DD or YYYYMMDD)
/health — service status
/help — this message`;

/** The "/" autocomplete menu in the Telegram client. */
export const BOT_COMMANDS = [
  { command: "holdings", description: "Where each Position stands: cost, P&L, pace" },
  { command: "monitors", description: "List the watchlist with live state" },
  { command: "quotes", description: "Live prices (mid, bid/ask) for every watched code" },
  { command: "greeks", description: "Live delta/gamma/theta for every watched code" },
  { command: "vol", description: "Live IV/vega for every watched code" },
  { command: "watch", description: "Add a monitor: DATE CALL|PUT strike threshold" },
  { command: "watchcombo", description: "Watch a combo: NAME DATE −short +long Cstrike Pstrike ... threshold" },
  { command: "unwatch", description: "Remove a monitor by name, code, or id prefix" },
  { command: "combo", description: "Per-leg breakdown of a combo" },
  { command: "threshold", description: "Change a monitor's threshold: NAME|contract value" },
  { command: "rename", description: "Rename a combo: OLD NEW" },
  { command: "snapshot", description: "Live quote: DATE CALL|PUT strike" },
  { command: "health", description: "Alarm sweep status" },
  { command: "help", description: "Show usage" },
] as const;

/** Fields the bot prints to three places rather than four. */
const FIELD_FORMATS: Record<string, number> = {
  option_delta: 3,
  option_implied_volatility: 3,
};

/** Column headings short enough for forty characters. */
export const FIELD_SHORT: Record<string, string> = {
  option_delta: "delta",
  mid_price: "mid",
  option_implied_volatility: "IV",
};

/** Python's html.escape, which is quote=True by default: & < > " ' all go.
 *
 *  Written out rather than taken from a library because the output is compared character for
 *  character, and because the ORDER matters — escaping & after < would turn &lt; into &amp;lt;. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");
}

/** A `<pre>` table with space-aligned columns.
 *
 *  Widths are measured on the ESCAPED text, as the Python does. That is arguably wrong — `&amp;` is
 *  five characters of width for one character of content — but it is what the Python ships, and a
 *  contract code contains no escapable character, so the only rows it could affect are ones that do
 *  not occur. Faithful, and noted.
 */
export function table(headers: string[], rows: string[][]): string {
  const escaped = [headers, ...rows].map((row) => row.map((cell) => escapeHtml(String(cell))));
  const widths = headers.map((_, i) => Math.max(...escaped.map((row) => (row[i] ?? "").length)));
  const lines = escaped.map((row) =>
    row.map((cell, i) => cell.padEnd(widths[i]!)).join("  ").replace(/\s+$/, ""),
  );
  return `<pre>${lines.join("\n")}</pre>`;
}

/** The one thing worth saying about a holding, in a cell.
 *
 *  A Level reached outranks a pace gap: a Target or a Stop is a decision already made, while the
 *  gap is only a reading. The gap is said in WORDS, never as a bare sign — CONTEXT.md: "behind" is
 *  bad while a positive P&L is good, and a sign beside one invites reading the other. That rule is
 *  PaceLine's on the dashboard, and this is its second home on purpose: forty characters cannot
 *  hold the sentence that one writes.
 */
export function standingNote(v: HoldingValue): string {
  const s = v.schedule;
  if (!s) return "—";
  if (s.reached === "stop") return "STOP";
  if (s.reached === "target") return "TARGET";
  if (s.manage_by_due) return "MANAGE";
  if (s.pace_gap === null) return "—";
  return `${s.pace_gap > 0 ? "behind" : "ahead"} ${Math.abs(s.pace_gap).toFixed(2)}`;
}

/** Whether this field has a format of its own, which decides 3 places against 4. */
export function hasFormat(field: string): boolean {
  return field in FIELD_FORMATS;
}

/** A figure, to the places its field deserves. */
export function fmtValue(key: string, value: unknown): string {
  const places = FIELD_FORMATS[key];
  if (places !== undefined && typeof value === "number") return value.toFixed(places);
  // `str(value)` in the Python, and for a float that is not String(value) — see pyNumber
  if (typeof value === "number") return pyNumber(value);
  return String(value);
}

/** The bot's wording for a threshold the rule refuses, or null.
 *
 *  Longer than the API's, because it is read without the form that produced it. The rule is
 *  `thresholdFault` in domain/monitor.ts. The arguments are `(compare, threshold)` like every other
 *  caller of it: this took them the other way round while sharing the API function's name, and only
 *  a string-versus-number mismatch kept the compiler from allowing the swap.
 */
export function thresholdError(compare: string, threshold: number): string | null {
  switch (thresholdFault(compare, threshold)) {
    case "abs-not-positive":
      return "Threshold must be positive — abs monitors compare magnitudes. "
        + "Add 'signed' to compare raw values.";
    case "signed-zero":
      return "Signed threshold cannot be 0 (zero-width hysteresis band); use e.g. ±0.01.";
    default:
      return null;
  }
}

/** What a rule means, said back to the owner so a mistyped direction is visible at once. */
export function ruleText(
  prefix: string, field: string, threshold: number, direction: string, compare: string,
): string {
  const sign = direction === "below" ? "≤" : "≥";
  const metric = compare === "signed" ? field : `abs(${field})`;
  return `${prefix}: alarm when ${metric} ${sign} ${threshold}`;
}

/** A float as Python's `str()` renders it.
 *
 *  Three differences from `String(value)`, all of which reach the owner's screen:
 *
 *  - an integral value keeps its point: Python writes `100.0`, JavaScript `100`. These cells carry
 *    prices straight from moomoo, so whole numbers happen constantly.
 *  - below 1e-4 Python goes exponential: `1.5e-05` against `0.000015`. Reachable — a gamma threshold
 *    is the sort of figure typed as 0.00001.
 *  - at 1e16 Python goes exponential too, where JavaScript waits until 1e21.
 *
 *  The exponent is read from `toExponential()` rather than computed with a logarithm, because
 *  `Math.log10` is approximate exactly at the boundaries this has to get right. It WAS checked
 *  against the Python across thirty values and four precisions, by a differential named
 *  `diff-api` that went with the service it compared against (#145) and cannot be re-run. Nothing replaced it here: the bot's
 *  formatting is not domain, so it has no golden cases and no counterpart in `python/` — what holds
 *  these boundaries is format.test.ts, which names each one.
 */
export function pyNumber(value: number): string {
  if (Number.isNaN(value)) return "nan";
  if (!Number.isFinite(value)) return value > 0 ? "inf" : "-inf";
  if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0";

  const [mantissa, exponent] = value.toExponential().split("e") as [string, string];
  const exp = Number(exponent);
  if (exp >= -4 && exp < 16) {
    const plain = String(value);
    return plain.includes(".") ? plain : `${plain}.0`;
  }
  // Python writes the sign and at least two digits: 1e+16, 1.5e-05
  return `${mantissa}e${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
}
