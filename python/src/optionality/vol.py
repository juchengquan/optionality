"""What of a pace gap vol accounts for (ADR 0011). Mirrors typescript/src/domain/vol.ts.

Measured from the Position's own daily samples, starting on the day it was Opened. None — never a
guess — whenever the chain is not whole.
"""

import math
from itertools import pairwise
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from optionality.exit import dte_at_open, on_pace
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
    m = _measure(samples, position)
    return None if isinstance(m, str) else m


def _measure(samples: list[VolSample], position: Position) -> VolAttribution | str:
    """The measurement, or the reason there is none: one walk, as `measure` in vol.ts."""
    if position.opened_at is None:
        return "Opened is not recorded, so there is no day to measure vol from"
    if not samples:
        return "no day has been recorded for it yet"
    if samples[0].observed_on != position.opened_at:
        return (
            f"its samples begin on {samples[0].observed_on}, not on {position.opened_at} when it was "
            "Opened: the vol it was sold at was never recorded"
        )
    codes = position_leg_codes(position)
    signs = [1 if leg.side == "short" else -1 for leg in position.legs]
    for s in samples:
        whole = (
            s.legs_iv is not None
            and s.legs_vega is not None
            and all(_reading(s.legs_iv.get(code)) and _reading(s.legs_vega.get(code)) for code in codes)
        )
        if not whole:
            return f"{s.observed_on} has no vol reading for every leg"
    vol = 0.0
    for prev, cur in pairwise(samples):
        if prev.dte - cur.dte != 1:
            return f"the record skips from {prev.observed_on} to {cur.observed_on}: a day is missing"
        for i, c in enumerate(codes):
            vol += signs[i] * prev.legs_vega[c] * (cur.legs_iv[c] - prev.legs_iv[c])
    if not math.isfinite(vol):
        return "the readings do not add up to a finite figure"
    return VolAttribution(vol=vol, from_=samples[0].observed_on, to=samples[-1].observed_on, days=len(samples) - 1)


class PacedSample(VolSample):
    """One day's sample as the vol route reads it: the readings, and that day's Cost to close."""

    cost_to_close: float | None


class PaceExplained(BaseModel):
    """A pace gap explained, as far as the samples can (#333). Mirrors `PaceExplained` in vol.ts:
    the gap is the one at the LAST sample's close, so vol + rest = gap holds of one instant."""

    model_config = ConfigDict(frozen=True, populate_by_name=True)
    vol: float | None
    from_: str | None = Field(alias="from")
    to: str | None
    days: int | None
    reason: str | None
    at: str | None
    gap: float | None
    rest: float | None
    vega: float | None
    cover: float | None


def pace_explained(samples: list[PacedSample], position: Position) -> PaceExplained:
    """The vol part, the reason when there is none, and the gap at the last close it splits."""
    m = _measure(samples, position)
    measured = None if isinstance(m, str) else m
    if isinstance(m, str):
        reason: str | None = m
    elif m.days == 0:
        reason = f"only {m.from_}, the day it was Opened, is recorded: nothing has moved yet"
    else:
        reason = None

    last = samples[-1] if samples else None
    opened_dte = dte_at_open(position.strike_date, position.opened_at) if position.opened_at else None
    pace = None if last is None else on_pace(position.entry, opened_dte, last.dte)
    gap = None if last is None or pace is None or last.cost_to_close is None else last.cost_to_close - pace

    # exposure-signed, short -1, as `position_greek` signs a holding's
    vega: float | None = None
    if last is not None and last.legs_vega is not None:
        codes = position_leg_codes(position)
        if all(_reading(last.legs_vega.get(c)) for c in codes):
            vega = 0.0
            for i, c in enumerate(codes):
                vega += (-1 if position.legs[i].side == "short" else 1) * last.legs_vega[c]

    return PaceExplained(
        vol=measured.vol if measured else None,
        from_=measured.from_ if measured else None,
        to=measured.to if measured else None,
        days=measured.days if measured else None,
        reason=reason,
        at=last.observed_on if last else None,
        gap=gap,
        rest=gap - measured.vol if reason is None and gap is not None and measured else None,
        vega=vega,
        cover=None if gap is None or vega is None or vega == 0 else abs(gap / vega),
    )
