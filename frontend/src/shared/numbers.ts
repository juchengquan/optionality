/** Every number the page writes, written one way (the owner's standard of 2026-11-16, ADR 0023).
 *
 *  ONE formatter, so the desk, the phone, the inspector, the sheet, the saved picture and Copy as
 *  text cannot spell a figure apart:
 *
 *  - every negative with the true minus, U+2212 — money (`−$4,528`), legs (`−C8050`, `format.ts`),
 *    percentages and points alike. A hyphen-minus before a digit is a typesetting fault the page
 *    is now held against (`NumberFormat.test.tsx`);
 *  - fixed places by what the figure is: points and prices 2, Δ 3, Γ 4, Θ and ν 2, IV 2 and a `%`,
 *    breakevens 2 — never "however many the float carries";
 *  - a served non-zero that rounds away at its places said as a bound, `<0.0001` or `>−0.0001`,
 *    because `0.0000` reads as none;
 *  - SPX one way everywhere: two places and NO thousands separator, `7561.70`, as a strike (`C8050`)
 *    and a breakeven (`8054.72`) are written beside it — the three are read against each other.
 *
 *  Pure, and no locale but `en-US` named explicitly: the owner's browser is Chinese, and a bare
 *  `toLocaleString()` renders in the device's language: the page once read `screen updated 晚上9:39:53`.
 */
import { DASH } from "./format";

/** U+2212, the true minus. */
export const MINUS = "−";

/** A text's sign as the page writes it: a leading hyphen-minus (before a digit, a `$` or a point)
 *  becomes the true minus, anything else is left as it is. */
export const trueMinus = (text: string): string => text.replace(/^-(?=[\d$.])/, MINUS);

/** `n` to `places` decimals with the true minus, and never a served non-zero as zero: a Γ of
 *  −0.00004 at four places is `>−0.0001`, never `-0.0000`; a zero is `0.00`, never `-0.00`. */
export function fixed(n: number, places: number): string {
  const text = n.toFixed(places);
  if (Number(text) !== 0) return trueMinus(text);
  if (n === 0) return (0).toFixed(places);
  const unit = (1 / 10 ** places).toFixed(places);
  return n > 0 ? `<${unit}` : `>${MINUS}${unit}`;
}

/** A figure or the dash where there is none. */
const orDash = (format: (n: number) => string) => (n: number | null | undefined): string =>
  n === null || n === undefined || !Number.isFinite(n) ? DASH : format(n);

/** The places per field (ADR 0023). A price — a mid, a value, a cost to close — to the cent; a
 *  delta to three, so a rule 0.004 away does not read "0.00 away"; gamma to four; theta, vega and
 *  IV to two. */
export const PLACES: Readonly<Record<string, number>> = {
  mid_price: 2, option_delta: 3, option_gamma: 4, option_theta: 2, option_vega: 2, option_implied_volatility: 2,
};

/** Points or a price: `2.95`, `−2.95`. */
export const points = orDash((n) => fixed(n, 2));
/** Points with their sign always written: `+4.72`, `−45.28`, `0.00`. */
export const signedPoints = orDash((n) => {
  const text = fixed(n, 2);
  return n > 0 && !text.startsWith("<") ? `+${text}` : text;
});
export const delta = orDash((n) => fixed(n, 3));
export const vega = orDash((n) => fixed(n, 2));
/** IV as served, in percent: `27.17%`. */
export const iv = orDash((n) => `${fixed(n, 2)}%`);

/** An axis TICK, not a figure: to as few places as it needs, at most `places`, with the true minus —
 *  `20%`, `22.5%`, `−$400` — as the burndown's ticks are written. A tick names a gridline, and two
 *  idle zeros on every one widen the axis the three history panels share (review of #418: at 272px
 *  `20.00%` pushed the IV panel's readout onto its point). */
export const tick = (n: number, places = 2): string => trueMinus(String(Number(n.toFixed(places))));

/** A field's figure to its places — a price for a field this does not know. */
export function figureOf(field: string, n: number | null | undefined): string {
  if (field === "option_implied_volatility") return iv(n);
  return orDash((v) => fixed(v, PLACES[field] ?? 2))(n);
}

/** A share as a whole percentage, `38%`, `−12%`. */
export const percent = orDash((share) => trueMinus(`${Math.round(share * 100)}%`));

/** SPX, or any index level: two places, no separator (above). */
export const spx = orDash((n) => fixed(n, 2));

const MONEY = new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", maximumFractionDigits: 0, signDisplay: "exceptZero",
});
const MONEY_PLAIN = new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", maximumFractionDigits: 0,
});

/** Dollars, signed: `+$177`, `−$4,528`, `$0`. */
export const money = orDash((n) => trueMinus(MONEY.format(n)));
/** Dollars with a sign only where negative: `$472`, `−$4,528` (a chart's axis). */
export const moneyPlain = orDash((n) => trueMinus(MONEY_PLAIN.format(n)));

/** A plain decimal as typed — a sign, digits, a fraction — and nothing else: `Number()` also reads
 *  "0x10" as 16, "1e-2" as 0.01 and "Infinity", none of which is a figure anybody typed on purpose. */
const PLAIN = /^[+-]?(\d+\.?\d*|\.\d+)$/;

/** A number as a person types or PASTES it into a box, or null for blank or not a number: the one
 *  reader of every figure box (the rule editor's threshold and total, the add forms' strikes, Entry
 *  and thresholds, the holding forms' Entry and Exit). The page writes a negative with the true
 *  minus, so a figure copied from it starts with U+2212, read as the hyphen-minus a keyboard types. */
export function readNumber(text: string): number | null {
  const t = text.trim().replace(/^−/, "-");
  return PLAIN.test(t) ? Number(t) : null;
}
