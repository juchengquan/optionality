"""JavaScript's number rules, where the TypeScript relies on them and Python's differ (ADR 0014).

The TypeScript is canonical, and it rounds three ways. Two of them it took from Python on purpose
(`round(x, 2)` for money, half-to-even for the fill bar), so the port uses Python's own there. The
other two are JavaScript's and must be reproduced here, because Python's `round` ties to even:

- `Math.round` ties toward +infinity: 12.5 → 13, -2.5 → -2 (Python: 12 and -2)
- `Number.prototype.toFixed` rounds the EXACT binary value and ties away from zero:
  0.03125 → "0.0313" (Python's round(0.03125, 4): 0.0312)

`number` and `truthy` are JavaScript's `Number(v)` and `if (v)`, for values read out of a quote,
where moomoo can send a string.
"""

import math
from decimal import ROUND_HALF_UP, Decimal


def math_round(x: float) -> float:
    """`Math.round`: the nearest integer, ties toward +infinity. Exact, unlike floor(x + 0.5)."""
    if not math.isfinite(x):
        return x
    floor = math.floor(x)
    return float(floor + 1 if x - floor >= 0.5 else floor)


def to_fixed(x: float, digits: int) -> float:
    """`Number(x.toFixed(digits))`: the exact value rounded half away from zero."""
    if not math.isfinite(x) or abs(x) >= 1e21:
        return x
    return float(Decimal(x).quantize(Decimal(1).scaleb(-digits), rounding=ROUND_HALF_UP))


def number(value: object) -> float:
    """`Number(value)` for what a quote field can hold."""
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        text = value.strip()
        if text == "":
            return 0.0
        try:
            return float(text)
        except ValueError:
            return math.nan
    return math.nan


def truthy(value: object) -> bool:
    """JavaScript's truthiness, which differs from Python's on NaN."""
    if isinstance(value, float) and math.isnan(value):
        return False
    return bool(value)
