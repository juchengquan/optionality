/** An SPX weekly option's moomoo code. Ported from apis/aux.py's build_spx_code.
 *
 *  Every contract this service can create goes through here, which is why the dashboard can
 *  shorten the displayed name: the SPXW and the trailing 000 are on every one of them. */
export function buildSpxCode(strikeDate: string, optionType: string, strike: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(strikeDate);
  if (!m) throw new Error(`invalid strike_date: ${strikeDate}`);
  const [, y, mo, d] = m;
  const letter = optionType.toUpperCase() === "CALL" ? "C" : "P";
  return `US.SPXW${y!.slice(2)}${mo}${d}${letter}${Math.trunc(strike)}000`;
}
