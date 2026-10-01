/** Position maths: what a held structure costs to close, what it is exposed to, what it is
 *  worth. Ported from service/position.py (ADR 0009, phase 3).
 *
 *  Every figure derives from each Leg's recorded Side. Note the two signings are INVERSES:
 *  buying back a sold leg COSTS money, while that same sold leg contributes NEGATIVE exposure.
 *  Keeping both in one place is what makes them impossible to confuse.
 *
 *  Phase 2 leaves these throwing. The tests beside them are the contract.
 */
import { buildSpxCode } from "./contract.ts";

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
  contracts: number | null;
  entry: number | null;
  legs: Leg[];
  strategy?: string | null;
  id?: string;
}

/** One contract's live figures, as the sweep caches them, indexed by code. */
export type Quote = Record<string, number | string | null | undefined>;
export type ByCode = Record<string, Quote>;

/** greeks are linear in the legs, so an exposure-signed sum is the greek OF the position.
 *  IV is intensive and never summed — the same rule combos hold to. */
export const POSITION_GREEK_FIELDS = [
  "option_delta",
  "option_gamma",
  "option_theta",
  "option_vega",
] as const;

const unimplemented = (name: string): never => {
  throw new Error(`${name} is not implemented yet — phase 2 ports the tests, phase 3 the code`);
};

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

export function costToClose(_p: Position, _byCode: ByCode, _scope?: string | null): number | null {
  return unimplemented("costToClose");
}

export function positionGreek(
  _p: Position, _byCode: ByCode, _field: string, _scope?: string | null,
): number | null {
  return unimplemented("positionGreek");
}

export function contractSize(_byCode: ByCode): number | null {
  return unimplemented("contractSize");
}

export function positionPnl(_p: Position, _byCode: ByCode): number | null {
  return unimplemented("positionPnl");
}

export function combinedCostToClose(
  _ps: Position[], _byCode: ByCode, _scope?: string | null,
): number | null {
  return unimplemented("combinedCostToClose");
}

export function combinedEntry(_ps: Position[]): number | null {
  return unimplemented("combinedEntry");
}

export function combinedPnl(_ps: Position[], _byCode: ByCode): number | null {
  return unimplemented("combinedPnl");
}
