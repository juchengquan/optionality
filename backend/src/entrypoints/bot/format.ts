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
import { MARKET_TZ, valuedTiming } from "optionality/domain/expiry";
import { thresholdFault } from "optionality/domain/monitor";
import type { HoldingValue } from "../../holdings.ts";

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

/** The widest a table row may be (CLAUDE.md: about forty monospace characters). 42, not 40, because
 *  `/monitors` already writes 41 with a twelve-character contract, and that row is not to change. */
export const TABLE_WIDTH = 42;
/** The narrowest a shortened name is made, whatever the other columns take: past this a name says
 *  nothing, and a row a little too wide is better than one that names nothing. */
const FIT_FLOOR = 12;

/** `cell` in at most `room` UTF-16 units — JavaScript's `length`, which every width here counts —
 *  shortened in its MIDDLE: the head names it (the expiry, the first leg) and the last third keeps
 *  its end, where `/quotes` puts the 🔔. Cut by code point, so a surrogate pair is never split. */
export function fitCell(cell: string, room: number): string {
  if (cell.length <= room) return cell;
  const chars = Array.from(cell);
  const budget = room - 1; // the ellipsis is one unit
  const tailMax = Math.floor(budget / 3);
  let tailN = 0;
  let tailW = 0;
  while (tailN < chars.length && tailW + chars[chars.length - 1 - tailN]!.length <= tailMax) {
    tailW += chars[chars.length - 1 - tailN]!.length;
    tailN++;
  }
  let headN = 0;
  let headW = 0;
  while (headN < chars.length - tailN && headW + chars[headN]!.length <= budget - tailW) {
    headW += chars[headN]!.length;
    headN++;
  }
  return `${chars.slice(0, headN).join("")}…${chars.slice(chars.length - tailN).join("")}`;
}

/** A `<pre>` table with space-aligned columns.
 *
 *  Widths are measured on the ESCAPED text, as the Python does. That is arguably wrong — `&amp;` is
 *  five characters of width for one character of content — but it is what the Python ships, and a
 *  contract code contains no escapable character, so the only rows it could affect are ones that do
 *  not occur. Faithful, and noted.
 *
 *  A row the FIRST column would push past `TABLE_WIDTH` has that cell shortened (`fitCell`): it is
 *  the name — a rule's code, a holding's — and a derived name keeps every leg (#351), so six legs
 *  with quantities run to some fifty characters. The figures beside it are never cut.
 */
export function table(headers: string[], rows: string[][]): string {
  const measure = (cells: string[][]) => cells.map((row) => row.map((cell) => escapeHtml(String(cell))));
  let escaped = measure([headers, ...rows]);
  const widthsOf = (all: string[][]) =>
    headers.map((_, i) => Math.max(...all.map((row) => (row[i] ?? "").length)));
  if (headers.length > 1) {
    const w = widthsOf(escaped);
    const room = Math.max(FIT_FLOOR, TABLE_WIDTH - (w.slice(1).reduce((a, b) => a + b, 0) + 2 * (headers.length - 1)));
    if (w[0]! > room) {
      escaped = measure([headers, ...rows.map((row) => [fitCell(String(row[0] ?? ""), room), ...row.slice(1)])]);
    }
  }
  const widths = widthsOf(escaped);
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
 *  the dashboard's too (`frontend/src/pace.ts`), and this is its second home on purpose: forty
 *  characters cannot hold the sentence that one writes.
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

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const NEW_YORK = new Intl.DateTimeFormat("en-US", {
  timeZone: MARKET_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

/** "Fri 13 Nov": a market day (YYYY-MM-DD), its names written out here rather than by a locale,
 *  so both backends spell September alike. */
function dayWords(isoDay: string): string {
  const d = new Date(`${isoDay}T00:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** "Fri 13 Nov 16:14": a stored UTC stamp on New York's clock — the close is New York's, so the
 *  page and the bot both say it in New York's time (#380) — or null where the stamp is unreadable. */
function newYorkWhen(observedAt: string | null): string | null {
  if (valuedTiming(observedAt) === "unrecorded") return null;
  const parts = Object.fromEntries(NEW_YORK.formatToParts(
    new Date(`${observedAt!.slice(0, 10)}T${observedAt!.slice(11, 23)}Z`),
  ).map((p) => [p.type, p.value]));
  return `${dayWords(`${parts.year}-${parts.month}-${parts.day}`)} ${parts.hour}:${parts.minute}`;
}

/** Which stored row a holding was valued from, in words: "as of the close, Fri 13 Nov 16:14" — or,
 *  where no row with a cost was taken in a session, that reading's own timing, so it is never
 *  passed off as a close (`closeSample`'s fallback, #380) — a weekend's included, which is said by
 *  its time alone (`valuedTiming`, #387). */
export function closeWords(close: { observed_on: string; observed_at: string | null }): string {
  const when = newYorkWhen(close.observed_at);
  switch (valuedTiming(close.observed_at)) {
    case "close": return `as of the close, ${when}`;
    case "after-close": return `as of ${when}, after the close`;
    case "before-open": return `as of ${when}, before the open`;
    case "weekend": return `as of ${when}`;
    default: return `as of ${dayWords(close.observed_on)}, at a time not recorded`;
  }
}

/** The one line `/holdings` adds under its table outside the session (#380): which close the figures
 *  are from. The latest close if any holding was valued from one in a session, else the latest row;
 *  then how many holdings were valued from another row, and how many had none and were valued live
 *  (a dash out of hours, never a 0) — or, where the Provider could not be asked for them, were not
 *  valued at all (#387). The page's market-closed line says the same thing. */
export function closedLine(values: readonly HoldingValue[]): string {
  const closes = values.flatMap((v) => (v.close === null ? [] : [v.close]));
  const live = values.length - closes.length;
  // one call prices every holding valued live, so either all of them were asked or none was
  const unasked = values.some((v) => v.close === null && v.unpriced !== null);
  const liveWords = unasked ? "and the Provider could not be asked" : "valued live";
  if (closes.length === 0) return `market closed — no close recorded yet${unasked ? ", " : "; "}${liveWords}`;
  const later = (a: (typeof closes)[number], b: (typeof closes)[number]) =>
    b.observed_on > a.observed_on || (b.observed_on === a.observed_on && (b.observed_at ?? "") > (a.observed_at ?? ""));
  const inHours = closes.filter((c) => valuedTiming(c.observed_at) === "close");
  const pool = inHours.length > 0 ? inHours : closes;
  const latest = pool.reduce((a, b) => (later(a, b) ? b : a));
  const key = (c: (typeof closes)[number]) => `${c.observed_on} ${valuedTiming(c.observed_at)}`;
  const others = closes.filter((c) => key(c) !== key(latest)).length;
  let line = `market closed — ${closeWords(latest)}`;
  if (others > 0) line += `; ${others} as of another reading`;
  if (live > 0) line += `; ${live} with no close, ${liveWords}`;
  return line;
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
