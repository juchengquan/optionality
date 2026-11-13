/** What the browser remembers for this viewer, and nothing else.
 *
 *  Seven preferences: how often the screen polls, which columns the desk's book hides, which way is
 *  up, how a fired entry rule looks, privacy, the arrangement and the desk's price map. The old
 *  page at `/opt` had five more — the signal and its band (the near-firing highlight), the
 *  grouping and the single-leg table's columns — and they went with it (#301, ADR 0023); their
 *  cookies are simply never read again. The ones kept keep their names, so a choice made on either
 *  page before the swap is still the choice after it.
 *
 *  Cookies by decision, not localStorage: CLAUDE.md draws the line at behaviour versus preference —
 *  behaviour knobs live in `.env`, viewer preferences live in the browser, and there is no DB
 *  config layer. Every one of them is small, safe to lose and safe to hand-edit, and every reader
 *  below therefore validates rather than trusts.
 */

/** A preference is read and written in exactly one place each. The attributes are the reason:
 *  spelled out at five call sites they were five chances to drop the `max-age` and quietly make a
 *  session cookie, which reads back correctly all day and is gone tomorrow. */
function readCookie(name: string): string {
  const raw = document.cookie
    .split("; ")
    .find((c) => c.startsWith(`${name}=`))
    ?.split("=")[1];
  // a value containing a comma comes back quoted, and the quotes stop it round-tripping
  return raw ? decoded(raw).replace(/^"|"$/g, "") : "";
}

/** A cookie is hand-editable, and `decodeURIComponent` THROWS on a stray `%` rather than leaving
 *  it alone. These readers run inside `useState` initialisers, so a throw here is not a preference
 *  ignored — it is a blank dashboard, from a character typed into devtools. The undecoded text
 *  then goes to the reader's own validation, which rejects it like any other nonsense. */
function decoded(raw: string): string {
  try { return decodeURIComponent(raw); } catch { return raw; }
}

/** A year, so a choice made once is still there next week; `path=/` because the dashboard is
 *  served under a prefix and a cookie set on `/opt/` would not be read back beside it; `lax`
 *  because a viewer preference has no business travelling on a cross-site request. */
function writeCookie(name: string, value: string): void {
  document.cookie = `${name}=${value};path=/;max-age=31536000;samesite=lax`;
}

/** The columns the desk's book hides (ADR 0008, ADR 0023). The cookie stores what is HIDDEN, not
 *  what is kept, so a column added later shows up by default instead of staying invisible. "."
 *  separates because a comma makes the value quote-escaped and it stops round-tripping.
 *
 *  `ui_cols_combo` because it was the old page's combo table's cookie, and the desk took its
 *  column keys where the two tables shared one, so the choice made there carried over. It also
 *  holds keys the desk never offers (gamma, expiry…), which the desk leaves alone. */
export function readHidden(): Set<string> {
  return new Set(readCookie("ui_cols_combo").split(".").filter((k) => k));
}

export function writeHidden(hidden: Set<string>): void {
  writeCookie("ui_cols_combo", [...hidden].sort().join("."));
}

/** How often the screen asks, in seconds.
 *
 *  The one preference whose default is not a constant: it is the service's own sweep cadence, so a
 *  viewer who has never chosen polls about as often as the figures actually change. The bounds are
 *  the service's protection rather than the viewer's — every poll is a live Provider call (ADR
 *  0010), so a hand-edited `1` must not become one batch a second.
 */
export function readRefresh(fallback: number): number {
  const n = Number(readCookie("ui_refresh"));
  return Number.isFinite(n) && n > 0 ? Math.max(5, Math.min(3600, n)) : fallback;
}

export function writeRefresh(seconds: number): void {
  writeCookie("ui_refresh", String(seconds));
}

/** Which way is up. Green-up is the default; red-up is how much of Asia reads a screen (ADR 0023).
 *  It flips the DIRECTION and OUTCOME colours only: an alarm, a fault and a fired entry rule keep
 *  theirs whichever way this is set, or a red-up viewer would read a ringing row as a rising market. */
export type UpColour = "green" | "red";

export function readUp(): UpColour {
  return readCookie("ui_up") === "red" ? "red" : "green";
}

export function writeUp(up: UpColour): void {
  writeCookie("ui_up", up);
}

/** How a fired ENTRY rule looks: a rule on the watchlist saying a spread is worth selling, which is
 *  good news and gets a style of its own by default. The other choice paints it as a risk alarm. */
export type EntryStyle = "opportunity" | "risk";

export function readEntryStyle(): EntryStyle {
  return readCookie("ui_entry") === "risk" ? "risk" : "opportunity";
}

export function writeEntryStyle(style: EntryStyle): void {
  writeCookie("ui_entry", style);
}

/** Hides the money on screen and keeps %, Δ and DTE, for a screen somebody else can see. */
export function readPrivacy(): boolean {
  return readCookie("ui_privacy") === "on";
}

export function writePrivacy(on: boolean): void {
  writeCookie("ui_privacy", on ? "on" : "off");
}

/** The measured width chooses desk or phone (`auto`); a device can force either. */
export type ArrangementChoice = "auto" | "desk" | "phone";

export function readArrangement(): ArrangementChoice {
  const raw = readCookie("ui_arrangement");
  return raw === "desk" || raw === "phone" ? raw : "auto";
}

export function writeArrangement(choice: ArrangementChoice): void {
  writeCookie("ui_arrangement", choice);
}

/** Whether the desk's price map panel is open (#298): shut until the viewer opens it. */
export function readPriceMap(): boolean {
  return readCookie("ui_price_map") === "open";
}

export function writePriceMap(open: boolean): void {
  writeCookie("ui_price_map", open ? "open" : "shut");
}
