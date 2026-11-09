/** SPX contract codes and the expiry dates they are built from.
 *  Ported from apis/aux.py's normalize_strike_date and build_spx_code (ADR 0009, phase 3).
 */

/** CALL or PUT, the only two kinds of contract this service names. It lives here rather than with
 *  the Legs that carry it because it is half of a code's grammar. */
export type OptionType = "CALL" | "PUT";

/** Both forms Python's date.fromisoformat takes, which is the pair the API accepts. */
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const COMPACT_DATE = /^(\d{4})(\d{2})(\d{2})$/;

/** Parse a strike date to its parts, rejecting anything that is not a real day.
 *
 *  Python leans on date.fromisoformat for both jobs at once — accepting two spellings and
 *  refusing 2026-13-45. A bare regex does only the first, so the round-trip below does the
 *  second: Date rolls an impossible day over into the next month, and that shows up as a
 *  component that no longer matches what went in.
 */
function parseStrikeDate(strikeDate: string): { y: string; mo: string; d: string } {
  const m = ISO_DATE.exec(strikeDate) ?? COMPACT_DATE.exec(strikeDate);
  if (!m) throw new Error(`invalid strike_date: ${strikeDate}`);
  const [, y, mo, d] = m as unknown as [string, string, string, string];
  const asDate = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  const rolled = asDate.getUTCFullYear() !== Number(y)
    || asDate.getUTCMonth() !== Number(mo) - 1
    || asDate.getUTCDate() !== Number(d);
  if (rolled) throw new Error(`invalid strike_date: ${strikeDate}`);
  return { y, mo, d };
}

/** Accepts both 2026-12-18 and 20261218; always returns the dashed form. */
export function normalizeStrikeDate(strikeDate: string): string {
  const { y, mo, d } = parseStrikeDate(strikeDate);
  return `${y}-${mo}-${d}`;
}

/** An SPX weekly option's moomoo code.
 *
 *  Every contract this service can create goes through here, which is why the dashboard can
 *  shorten the displayed name: the SPXW and the trailing 000 are on every one of them. */
export function buildSpxCode(strikeDate: string, optionType: string, strike: number): string {
  const { y, mo, d } = parseStrikeDate(strikeDate);
  const letter = optionType.toUpperCase() === "CALL" ? "C" : "P";
  // int(strike) in Python truncates toward zero, which Math.trunc matches and Math.floor does not
  return `US.SPXW${y.slice(2)}${mo}${d}${letter}${Math.trunc(strike)}000`;
}

/** `2026-10-16` → `261016`: the six digits a code carries, and the bot's short form with it. */
export function compactStrikeDate(strikeDate: string): string {
  const { y, mo, d } = parseStrikeDate(strikeDate);
  return `${y.slice(2)}${mo}${d}`;
}

/** A contract's three facts — exactly what buildSpxCode is given. */
export interface SpxContract {
  strike_date: string;
  option_type: OptionType;
  strike: number;
}

/** Strict, because it is buildSpxCode's inverse and nothing else: a leading-zero strike parses
 *  to a number whose own code is a different string, so it is refused rather than round-tripped
 *  into something else. */
const SPX_CODE = /^US\.SPXW(\d{2})(\d{2})(\d{2})([CP])(0|[1-9]\d*)000$/;

/** buildSpxCode read backwards, or null for any string it could not have written.
 *
 *  Null and not a throw: the strings arriving here come from a provider, the database or a person
 *  typing into Telegram, and every caller's answer to one it does not recognise is to leave it
 *  alone. The code carries two year digits, so this reads them as 20YY — which is what
 *  buildSpxCode wrote, and the only reading that round-trips.
 *
 *  It exists because three places knew this grammar by heart instead (ADR 0015).
 */
export function parseSpxCode(code: string): SpxContract | null {
  const m = SPX_CODE.exec(code);
  if (!m) return null;
  const [, yy, mo, d, letter, strike] = m as unknown as [string, string, string, string, string, string];
  let strikeDate: string;
  try {
    // a well-formed code can still name 2026-02-30, and a day nothing expires on is worse than null
    strikeDate = normalizeStrikeDate(`20${yy}${mo}${d}`);
  } catch {
    return null;
  }
  return { strike_date: strikeDate, option_type: letter === "C" ? "CALL" : "PUT", strike: Number(strike) };
}

/** `US.SPXW261030C8100000` as `261030 C8100`. The SPXW and the trailing 000 are on every contract
 *  this service can create, so they carry no information and cost twelve of the bot's forty
 *  characters. Anything this cannot read is returned untouched, so a quarantined code from
 *  somewhere else is shown as it is rather than shortened into a different-looking contract. */
export function shortSpxCode(code: string): string {
  const c = parseSpxCode(code);
  if (!c) return code;
  return `${compactStrikeDate(c.strike_date)} ${c.option_type === "CALL" ? "C" : "P"}${c.strike}`;
}

const SHORT_CODE = /^(\d{2})(\d{2})(\d{2})([CP])(0|[1-9]\d*)$/;

/** shortSpxCode read backwards: what the bot prints is what /unwatch accepts. Spaces and case are
 *  a person's, not the grammar's, so they are stripped before matching; null for anything else. */
export function expandSpxShort(short: string): string | null {
  const m = SHORT_CODE.exec(short.replace(/\s+/g, "").toUpperCase());
  if (!m) return null;
  const [, yy, mo, d, letter, strike] = m as unknown as [string, string, string, string, string, string];
  try {
    return buildSpxCode(`20${yy}${mo}${d}`, letter === "C" ? "CALL" : "PUT", Number(strike));
  } catch {
    return null;
  }
}
