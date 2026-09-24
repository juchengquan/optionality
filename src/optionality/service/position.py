"""Position maths: what a held structure costs to close, what it is exposed to, what it is worth.

Every figure derives from each Leg's recorded Side. Note the two signings are inverses:
buying back a sold leg COSTS money, while that same sold leg contributes NEGATIVE exposure.
Keeping both in one place is what makes them impossible to confuse.
"""

from optionality.apis.aux import build_spx_code
from optionality.service.models import Position

SOLD = "sold"
BOUGHT = "bought"


def position_leg_codes(position: Position) -> list[str]:
    return [build_spx_code(position.strike_date, leg["option_type"], leg["strike"]) for leg in position.legs]


def _signed_sum(position: Position, by_code: dict, field: str, sold_sign: int) -> float | None:
    """Sum `field` over the legs; None if ANY leg is missing — never a partial position."""
    total = 0.0
    for leg, code in zip(position.legs, position_leg_codes(position), strict=True):
        record = by_code.get(code)
        value = record.get(field) if record else None
        if value is None:
            return None
        total += (sold_sign if leg["side"] == SOLD else -sold_sign) * value
    return total


def cost_to_close(position: Position, by_code: dict) -> float | None:
    """Points needed to buy the position back: sold legs cost, bought legs return."""
    return _signed_sum(position, by_code, "mid_price", sold_sign=1)


def position_greek(position: Position, by_code: dict, field: str) -> float | None:
    """Exposure-signed sum: a sold leg's greek counts against you, hence sold_sign=-1."""
    return _signed_sum(position, by_code, field, sold_sign=-1)


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
    if closing is None or size is None:
        return None
    # money, so 2dp is its own precision: float noise here reads as 160.99999999999986.
    # points and greeks stay exact and are rounded at display instead.
    return round((position.entry - closing) * position.contracts * size, 2)
