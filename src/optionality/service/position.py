"""Position maths: what a held structure costs to close, what it is exposed to, what it is worth.

Every figure derives from each Leg's recorded Side. Note the two signings are inverses:
buying back a sold leg COSTS money, while that same sold leg contributes NEGATIVE exposure.
Keeping both in one place is what makes them impossible to confuse.
"""

from optionality.apis.aux import build_spx_code
from optionality.service.models import Position

SOLD = "sold"
BOUGHT = "bought"

# greeks are linear in the legs, so an exposure-signed sum is the greek OF the position.
# IV is intensive and never summed — the same rule combos hold to.
POSITION_GREEK_FIELDS = ("option_delta", "option_gamma", "option_theta", "option_vega")


def scoped_legs(position: Position, scope: str | None = None) -> list[dict]:
    """The legs a scope selects. For a condor, "calls" and "puts" are exactly the wings."""
    if scope == "calls":
        return [leg for leg in position.legs if leg["option_type"] == "CALL"]
    if scope == "puts":
        return [leg for leg in position.legs if leg["option_type"] == "PUT"]
    return list(position.legs)


def position_leg_codes(position: Position, scope: str | None = None) -> list[str]:
    return [
        build_spx_code(position.strike_date, leg["option_type"], leg["strike"]) for leg in scoped_legs(position, scope)
    ]


def _signed_sum(position: Position, by_code: dict, field: str, sold_sign: int, scope: str | None) -> float | None:
    """Sum `field` over the scoped legs; None if ANY is missing — never a partial position."""
    legs = scoped_legs(position, scope)
    total = 0.0
    for leg, code in zip(legs, position_leg_codes(position, scope), strict=True):
        record = by_code.get(code)
        value = record.get(field) if record else None
        if value is None:
            return None
        total += (sold_sign if leg["side"] == SOLD else -sold_sign) * value
    return total


def cost_to_close(position: Position, by_code: dict, scope: str | None = None) -> float | None:
    """Points needed to buy the position back: sold legs cost, bought legs return."""
    return _signed_sum(position, by_code, "mid_price", sold_sign=1, scope=scope)


def position_greek(position: Position, by_code: dict, field: str, scope: str | None = None) -> float | None:
    """Exposure-signed sum: a sold leg's greek counts against you, hence sold_sign=-1."""
    return _signed_sum(position, by_code, field, sold_sign=-1, scope=scope)


def contract_size(by_code: dict) -> float | None:
    """Points-to-money multiplier, taken from the quotes rather than assumed to be 100."""
    for record in by_code.values():
        size = record.get("option_contract_size")
        if size:
            return float(size)
    return None


def position_pnl(position: Position, by_code: dict) -> float | None:
    """Entry less cost to close, in money. None unless every leg priced and a size is known."""
    closing = cost_to_close(position, by_code)
    size = contract_size(by_code)
    # entry is for the whole holding, so P&L is too; unknown entry means unknown P&L,
    # never a fabricated one
    if closing is None or size is None or position.entry is None:
        return None
    # money, so 2dp is its own precision: float noise here reads as 160.99999999999986.
    # points and greeks stay exact and are rounded at display instead.
    return round((position.entry - closing) * position.contracts * size, 2)


def combined_cost_to_close(positions: list[Position], by_code: dict, scope: str | None = None) -> float | None:
    """What it costs to close several Positions at once — a stop over two credit spreads."""
    parts = [cost_to_close(p, by_code, scope) for p in positions]
    return None if not parts or any(x is None for x in parts) else sum(parts)


def combined_entry(positions: list[Position]) -> float | None:
    """Total taken in across Positions. Unknown if any one of them is."""
    entries = [p.entry for p in positions]
    return None if not entries or any(e is None for e in entries) else sum(entries)


def combined_pnl(positions: list[Position], by_code: dict) -> float | None:
    parts = [position_pnl(p, by_code) for p in positions]
    return None if not parts or any(x is None for x in parts) else round(sum(parts), 2)


def combined_greek(positions: list[Position], by_code: dict, field: str, scope: str | None = None) -> float | None:
    parts = [position_greek(p, by_code, field, scope) for p in positions]
    return None if not parts or any(x is None for x in parts) else sum(parts)
