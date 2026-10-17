"""What of a pace gap vol accounts for (ADR 0011). Mirrors backend/src/domain/vol.ts.

Measured from the Position's own daily samples, starting on the day it was Opened. None — never a
guess — whenever the chain is not whole.
"""

import math
from itertools import pairwise
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from optionality.position import Position, position_leg_codes


class VolSample(BaseModel):
    """One day's per-leg readings. The maps hold whatever was stored; a reading counts only if it is a
    finite number, so a stored null or text is a missing day rather than a zero."""

    model_config = ConfigDict(frozen=True, extra="ignore")
    observed_on: str
    dte: int
    legs_iv: dict[str, Any] | None
    legs_vega: dict[str, Any] | None


class VolAttribution(BaseModel):
    """`vol` in Cost-to-close units: positive means vol made the holding dearer to buy back."""

    model_config = ConfigDict(frozen=True, populate_by_name=True)
    vol: float
    from_: str = Field(alias="from")
    to: str
    days: int


def _reading(v: object) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def vol_attribution(samples: list[VolSample], position: Position) -> VolAttribution | None:
    """Vol's share of the gap. `samples` must be ordered by `observed_on`."""
    if not samples or samples[0].observed_on != position.opened_at:
        return None
    codes = position_leg_codes(position)
    signs = [1 if leg.side == "short" else -1 for leg in position.legs]
    for s in samples:
        if s.legs_iv is None or s.legs_vega is None:
            return None
        for code in codes:
            if not _reading(s.legs_iv.get(code)) or not _reading(s.legs_vega.get(code)):
                return None
    vol = 0.0
    for prev, cur in pairwise(samples):
        if prev.dte - cur.dte != 1:
            return None
        for i, c in enumerate(codes):
            vol += signs[i] * prev.legs_vega[c] * (cur.legs_iv[c] - prev.legs_iv[c])
    if not math.isfinite(vol):
        return None
    return VolAttribution(vol=vol, from_=samples[0].observed_on, to=samples[-1].observed_on, days=len(samples) - 1)
