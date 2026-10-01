/** SPX contract codes and the expiry dates they are built from.
 *  Ported from apis/aux.py's normalize_strike_date and build_spx_code (ADR 0009, phase 3).
 */

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
