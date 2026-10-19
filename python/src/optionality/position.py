"""Position maths: what a held structure costs to close, what it is exposed to, what it is worth.
Mirrors backend/src/domain/position.ts.

Every figure derives from each Leg's Side, and the two signings are INVERSES: buying back a short leg
COSTS money, while that same short leg contributes NEGATIVE exposure. Greeks are only ever signed
numbers; "short" means a Leg and nothing else (ADR 0013).

Money is `round(x, 2)` and the combined figures use `sum()`: the TypeScript reproduces exactly these
two Python rules (its `roundMoney` and `pySum`), so here they are simply themselves.
"""

import math
from collections.abc import Iterable
from typing import Literal

from pydantic import BaseModel, ConfigDict

from optionality._js import number, truthy
from optionality.contract import build_spx_code
from optionality.quote import ByCode

type Side = Literal["short", "long"]
type OptionType = Literal["CALL", "PUT"]

POSITION_GREEK_FIELDS = ("option_delta", "option_gamma", "option_theta", "option_vega")


class Leg(BaseModel):
    """A Contract you hold, with the Side you are on: long if you bought it, short if you sold it."""

    model_config = ConfigDict(frozen=True, extra="ignore")
    side: Side
    option_type: OptionType
    strike: float


class Position(BaseModel):
    """An options structure you actually hold. `entry` is the net credit RECEIVED per contract, so a
    debit is negative. Extra fields an API response carries (created_at, ...) are ignored."""

    model_config = ConfigDict(frozen=True, extra="ignore")
    name: str
    strike_date: str
    contracts: int
    entry: float | None
    legs: tuple[Leg, ...]
    strategy: str | None = None
    id: str | None = None
    opened_at: str | None = None


class Holding(BaseModel):
    """Which Positions hold a set of contracts, and whether the set is all of them or part."""

    model_config = ConfigDict(frozen=True)
    found: frozenset[str]
    scope: Literal["all", "leg"] | None


def _value(by_code: ByCode, code: str, field: str) -> object:
    record = by_code.get(code)
    return None if record is None else record.get(field)


def scoped_legs(position: Position, scope: str | None = None) -> list[Leg]:
    """The legs a scope selects. For a condor, "calls" and "puts" are exactly the wings."""
    if scope == "calls":
        return [leg for leg in position.legs if leg.option_type == "CALL"]
    if scope == "puts":
        return [leg for leg in position.legs if leg.option_type == "PUT"]
    return list(position.legs)


def position_leg_codes(position: Position, scope: str | None = None) -> list[str]:
    return [build_spx_code(position.strike_date, leg.option_type, leg.strike) for leg in scoped_legs(position, scope)]


def leg_readings(position: Position, by_code: ByCode, field: str) -> dict[str, float] | None:
    """One reading per leg, or None if any is missing or not a finite number — never half a map."""
    readings: dict[str, float] = {}
    for code in position_leg_codes(position):
        value = _value(by_code, code, field)
        if value is None:
            return None
        n = number(value)
        if not math.isfinite(n):
            return None
        readings[code] = n
    return readings


def _signed_sum(position: Position, by_code: ByCode, field: str, short_sign: int, scope: str | None) -> float | None:
    """`field` summed over the scoped legs; None if ANY is missing — never a partial position."""
    total = 0.0
    for leg, code in zip(scoped_legs(position, scope), position_leg_codes(position, scope), strict=True):
        value = _value(by_code, code, field)
        if value is None:
            return None
        total += (short_sign if leg.side == "short" else -short_sign) * number(value)
    return total


def cost_to_close(position: Position, by_code: ByCode, scope: str | None = None) -> float | None:
    """Points needed to close: short legs cost to buy back, long legs return."""
    return _signed_sum(position, by_code, "mid_price", 1, scope)


def position_greek(position: Position, by_code: ByCode, field: str, scope: str | None = None) -> float | None:
    """Exposure-signed: a short leg's greek counts AGAINST you."""
    return _signed_sum(position, by_code, field, -1, scope)


def cost_to_close_of(positions: list[Position], by_code: ByCode, codes: Iterable[str]) -> float | None:
    """What it would cost to close just these Contracts, out of what you hold (#105).

    By Side, never from a combo's signs. None unless EVERY named Contract is held exactly once and
    priced: a partial answer to "what would this cost" is worse than none, which is the rule combos
    already follow for their values. Held twice is ambiguous for the reason positions_holding
    refuses it, and was being counted twice rather than refused (2026-10-20)."""
    named = set(codes)
    total = 0.0
    found: set[str] = set()
    for position in positions:
        for leg in position.legs:
            code = build_spx_code(position.strike_date, leg.option_type, leg.strike)
            if code not in named:
                continue
            if code in found:  # two holdings share this strike
                return None
            mid = _value(by_code, code, "mid_price")
            if mid is None:
                return None
            total += (1 if leg.side == "short" else -1) * number(mid)
            found.add(code)
    return total if len(found) == len(named) else None


def contract_size(by_code: ByCode) -> float | None:
    """Points-to-money multiplier, taken from the quotes rather than assumed to be 100."""
    for record in by_code.values():
        size = record.get("option_contract_size")
        if truthy(size):
            return number(size)
    return None


def position_pnl(position: Position, by_code: ByCode) -> float | None:
    """Entry less Cost to close, in money. None unless every leg is priced and an entry is known."""
    closing = cost_to_close(position, by_code)
    size = contract_size(by_code)
    if closing is None or size is None or position.entry is None:
        return None
    return round((position.entry - closing) * position.contracts * size, 2)


def _sum_or_none(parts: list[float | None]) -> float | None:
    if not parts or any(p is None for p in parts):
        return None
    return sum(parts)


def combined_cost_to_close(positions: list[Position], by_code: ByCode, scope: str | None = None) -> float | None:
    """What it costs to close several Positions at once — a stop over two credit spreads."""
    return _sum_or_none([cost_to_close(p, by_code, scope) for p in positions])


def combined_entry(positions: list[Position]) -> float | None:
    return _sum_or_none([p.entry for p in positions])


def combined_pnl(positions: list[Position], by_code: ByCode) -> float | None:
    total = _sum_or_none([position_pnl(p, by_code) for p in positions])
    return None if total is None else round(total, 2)


def combined_greek(positions: list[Position], by_code: ByCode, field: str, scope: str | None = None) -> float | None:
    return _sum_or_none([position_greek(p, by_code, field, scope) for p in positions])


def positions_holding(positions: list[Position], contracts: list[str]) -> Holding:
    """The Positions that hold these contracts. Nothing if a contract is held twice (ambiguous) or not
    at all. "all" when every leg of every Position found is among these contracts, "leg" when this
    watches part of one. Naming contracts beyond them does not stop it covering what IS held; a held
    leg it does not name does."""
    owners: dict[str, list[str]] = {}
    for position in positions:
        for code in position_leg_codes(position):
            owners.setdefault(code, []).append(position.id)
    if any(len(owners.get(code, [])) > 1 for code in contracts):
        return Holding(found=frozenset(), scope=None)
    found = frozenset(owner for code in contracts for owner in owners.get(code, []))
    if not found:
        return Holding(found=frozenset(), scope=None)
    # membership, not cardinality: counting legs against contracts made an adjacent spread sharing
    # one leg come out equal to covering the holding whole (2026-10-20)
    watched = set(contracts)
    covered = all(
        all(code in watched for code in position_leg_codes(position))
        for position in positions
        if position.id in found
    )
    return Holding(found=found, scope="all" if covered else "leg")
