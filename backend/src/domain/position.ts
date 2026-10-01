/** Position maths: what a held structure costs to close, what it is exposed to, what it is
 *  worth. Ported from service/position.py (ADR 0009, phase 3).
 *
 *  Every figure derives from each Leg's recorded Side. Note the two signings are INVERSES:
 *  buying back a sold leg COSTS money, while that same sold leg contributes NEGATIVE exposure.
 *  Keeping both in one place is what makes them impossible to confuse.
 *
 */
import { buildSpxCode } from "./contract.ts";
import type { ByCode } from "./quote.ts";

export type Side = "sold" | "bought";
export type OptionType = "CALL" | "PUT";

export interface Leg {
  side: Side;
  option_type: OptionType;
  strike: number;
}

export interface Position {
  name: string;
  strike_date: string;
  contracts: number;
  entry: number | null;
  legs: Leg[];
  strategy?: string | null;
  id?: string;
}

export type { ByCode, Quote } from "./quote.ts";


/** greeks are linear in the legs, so an exposure-signed sum is the greek OF the position.
 *  IV is intensive and never summed — the same rule combos hold to. */
export const POSITION_GREEK_FIELDS = [
  "option_delta",
  "option_gamma",
  "option_theta",
  "option_vega",
] as const;

/** Round money to 2dp the way Python's round() does, which is subtler than it looks.
 *
 *  Python rounds the ACTUAL binary value, and only applies its half-to-even rule when that value
 *  is exactly a half. 0.005 is stored a shade above a half so it goes up; 0.015 a shade below so
 *  it goes down; 0.125 is exact, so the even rule applies and gives 0.12.
 *
 *  Two tempting translations get this wrong. Math.round(v * 100) / 100 differs on five of two
 *  hundred sampled values, because multiplying by 100 destroys the very precision that decides
 *  the tie. Plain toFixed(2) differs on one — the exact half, where it rounds away from zero.
 *  So: toFixed, except on an exact half, where the even neighbour wins. Verified at 0 of 210.
 */
function roundMoney(value: number): number {
  // 30 digits is far more than a double needs to reveal whether the expansion really stops at
  // a half, which is what separates 0.125 from 0.005
  const frac = Math.abs(value).toFixed(30).split(".")[1] ?? "";
  const exactlyHalf = frac[2] === "5" && /^0*$/.test(frac.slice(3));
  if (!exactlyHalf) return Number(value.toFixed(2));
  const cents = Math.trunc(Math.abs(value) * 100);
  const even = cents % 2 === 0 ? cents : cents + 1;
  return (value < 0 ? -even : even) / 100;
}

/** Sum `field` over the scoped legs; null if ANY is missing — never a partial position. */
function signedSum(
  position: Position, byCode: ByCode, field: string, soldSign: number, scope?: string | null,
): number | null {
  const legs = scopedLegs(position, scope);
  const codes = positionLegCodes(position, scope);
  let total = 0;
  for (const [i, leg] of legs.entries()) {
    const value = byCode[codes[i]!]?.[field];
    if (value === null || value === undefined) return null;
    total += (leg.side === "sold" ? soldSign : -soldSign) * Number(value);
  }
  return total;
}

/** The legs a scope selects. For a condor, "calls" and "puts" are exactly the wings. */
export function scopedLegs(position: Position, scope?: string | null): Leg[] {
  if (scope === "calls") return position.legs.filter((l) => l.option_type === "CALL");
  if (scope === "puts") return position.legs.filter((l) => l.option_type === "PUT");
  return [...position.legs];
}

export function positionLegCodes(position: Position, scope?: string | null): string[] {
  return scopedLegs(position, scope).map((l) =>
    buildSpxCode(position.strike_date, l.option_type, l.strike),
  );
}

/** Points needed to buy the position back: sold legs cost, bought legs return. */
export function costToClose(p: Position, byCode: ByCode, scope?: string | null): number | null {
  return signedSum(p, byCode, "mid_price", 1, scope);
}

/** Exposure-signed sum: a sold leg's greek counts AGAINST you, hence soldSign = −1. This is the
 *  inverse of costToClose's signing, and keeping both in one file is what makes them hard to
 *  confuse. */
export function positionGreek(
  p: Position, byCode: ByCode, field: string, scope?: string | null,
): number | null {
  return signedSum(p, byCode, field, -1, scope);
}

/** Points-to-money multiplier, taken from the quotes rather than assumed to be 100. */
export function contractSize(byCode: ByCode): number | null {
  for (const record of Object.values(byCode)) {
    const size = record.option_contract_size;
    if (size) return Number(size);
  }
  return null;
}

/** Entry less cost to close, in money. Null unless every leg is priced and a size is known. */
export function positionPnl(p: Position, byCode: ByCode): number | null {
  const closing = costToClose(p, byCode);
  const size = contractSize(byCode);
  // entry is for the whole holding, so P&L is too; an unknown entry means an unknown P&L,
  // never a fabricated one
  if (closing === null || size === null || p.entry === null) return null;
  // money, so 2dp is its own precision: float noise here reads as 160.99999999999986.
  // points and greeks stay exact and are rounded at display instead.
  return roundMoney((p.entry - closing) * p.contracts * size);
}

/** Python's sum() over floats, which since CPython 3.12 is NOT a left-to-right addition: it
 *  carries a running correction term (improved Kahan-Babuska, after Neumaier). A plain reduce
 *  diverges — three of four hundred sampled cases, e.g. a combined delta of -0.46 against
 *  -0.45999999999999996. Per-leg sums are unaffected because Python accumulates those with a
 *  plain `+=`, which is why only the combined figures drifted.
 *
 *  The per-leg sums deliberately stay naive, for the same reason: faithful means matching what
 *  the other side does, not what is most accurate. */
function pySum(values: number[]): number {
  let s = 0;
  let c = 0;
  for (const x of values) {
    const t = s + x;
    if (Math.abs(s) >= Math.abs(x)) c += (s - t) + x;
    else c += (x - t) + s;
    s = t;
  }
  // CPython applies the correction only when it is finite and non-zero, so an overflow to ±inf
  // stays ±inf rather than turning into nan, and a negative zero keeps its sign
  return c !== 0 && Number.isFinite(c) ? s + c : s;
}

/** All-or-nothing across a list, the same rule a single position holds to. */
function sumOrNull(parts: (number | null)[]): number | null {
  if (parts.length === 0 || parts.some((x) => x === null)) return null;
  return pySum(parts as number[]);
}

/** What it costs to close several Positions at once — a stop over two credit spreads. */
export function combinedCostToClose(
  ps: Position[], byCode: ByCode, scope?: string | null,
): number | null {
  return sumOrNull(ps.map((p) => costToClose(p, byCode, scope)));
}

/** Total taken in across Positions. Unknown if any one of them is. */
export function combinedEntry(ps: Position[]): number | null {
  return sumOrNull(ps.map((p) => p.entry));
}

export function combinedPnl(ps: Position[], byCode: ByCode): number | null {
  const total = sumOrNull(ps.map((p) => positionPnl(p, byCode)));
  return total === null ? null : roundMoney(total);
}

export function combinedGreek(
  ps: Position[], byCode: ByCode, field: string, scope?: string | null,
): number | null {
  return sumOrNull(ps.map((p) => positionGreek(p, byCode, field, scope)));
}

/** Which Positions a Monitor's contracts belong to, and whether it watches legs or wholes.
 *
 *  A Monitor exists to warn, never to record what you own (CONTEXT.md), so it does not bring a
 *  Position into being — it finds the one it is watching. That is a lookup rather than a guess:
 *  a contract appears in exactly one Position's legs, or in none.
 *
 *  Returns no link at all in the two honest cases:
 *
 *  - Nothing holds the contract. Watching a strike you have no position in is legitimate; it
 *    simply has no entry and no P&L, which is why those fields read empty rather than zero.
 *  - Something holds it TWICE. Rolling a spread can leave the old and the new sharing a strike
 *    for a day, and the entry is then genuinely ambiguous. A wrong P&L is worse than an absent
 *    one — a missing figure makes you look, a wrong one does not.
 *
 *  Scope is "all" when the Positions found are covered exactly by the Monitor's contracts, and
 *  "leg" when it watches part of a larger structure. Several Positions at once is normal and not
 *  ambiguity: a condor's stop spans both its spreads (ADR 0004).
 */
export function positionsHolding(
  positions: (Position & { id: string })[], contracts: string[],
): { found: Set<string>; scope: "all" | "leg" | null } {
  const owners = new Map<string, string[]>();
  for (const position of positions) {
    for (const code of positionLegCodes(position)) {
      const held = owners.get(code);
      if (held) held.push(position.id);
      else owners.set(code, [position.id]);
    }
  }

  if (contracts.some((code) => (owners.get(code)?.length ?? 0) > 1)) {
    return { found: new Set(), scope: null };
  }

  const found = new Set(contracts.flatMap((code) => owners.get(code) ?? []));
  if (found.size === 0) return { found: new Set(), scope: null };

  const covered = positions
    .filter((p) => found.has(p.id))
    .reduce((n, p) => n + (p.legs?.length ?? 0), 0);
  return { found, scope: covered === contracts.length ? "all" : "leg" };
}
