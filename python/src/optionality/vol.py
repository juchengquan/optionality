"""What of a pace gap vol accounts for (ADR 0011). Mirrors typescript/src/domain/vol.ts.

Measured from the Position's own daily samples, starting on the day it was Opened. None — never a
guess — whenever the chain is not whole.
"""

import math
from datetime import datetime
from itertools import pairwise
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from optionality.exit import dte_at_open, on_pace
from optionality.expiry import in_sample_hours, market_date, sample_timing
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
            f"its samples begin on {_day_words(samples[0].observed_on)}, not on {_day_words(position.opened_at)} "
            "when it was Opened: the vol it was sold at was never recorded"
        )
    codes = position_leg_codes(position)
    # times the leg's quantity, as cost_to_close multiplies it (#351); the readings stay per contract
    signs = [(1 if leg.side == "short" else -1) * leg.qty for leg in position.legs]
    for s in samples:
        whole = (
            s.legs_iv is not None
            and s.legs_vega is not None
            and all(_reading(s.legs_iv.get(code)) and _reading(s.legs_vega.get(code)) for code in codes)
        )
        if not whole:
            return f"{_day_words(s.observed_on)} has no vol reading for every leg"
    vol = 0.0
    for prev, cur in pairwise(samples):
        if prev.dte - cur.dte != 1:
            return f"the record skips from {_day_words(prev.observed_on)} to {_day_words(cur.observed_on)}: a day is missing"
        for i, c in enumerate(codes):
            vol += signs[i] * prev.legs_vega[c] * (cur.legs_iv[c] - prev.legs_iv[c])
    if not math.isfinite(vol):
        return "the readings do not add up to a finite figure"
    return VolAttribution(vol=vol, from_=samples[0].observed_on, to=samples[-1].observed_on, days=len(samples) - 1)


class PacedSample(VolSample):
    """One day's sample as the vol route reads it: the readings, that day's Cost to close, and when it
    was observed (UTC as stored, None on rows from before observation times were kept)."""

    cost_to_close: float | None
    observed_at: str | None


PacedTiming = Literal["close", "in-hours", "before-open", "after-close", "unrecorded"]


class PaceExplained(BaseModel):
    """A pace gap explained, as far as the samples can (#333). Mirrors `PaceExplained` in vol.ts:
    the gap is the one at the LAST sample, so vol + rest = gap holds of one instant, and each absent
    figure says why."""

    model_config = ConfigDict(frozen=True, populate_by_name=True)
    vol: float | None
    from_: str | None = Field(alias="from")
    to: str | None
    days: int | None
    reason: str | None
    at: str | None
    timing: PacedTiming | None
    gap: float | None
    gap_reason: str | None
    rest: float | None
    vega: float | None
    cover: float | None
    cover_reason: str | None


VEGA_FLOOR = 0.005
"""A net vega smaller than this is zero: the precision every vega is shown at."""

_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def _day_words(iso: str) -> str:
    """ "9 Nov": a stored YYYY-MM-DD as the dashboard writes a day, by string."""
    return f"{int(iso[8:10])} {_MONTHS[int(iso[5:7]) - 1]}"


def pace_explained(samples: list[PacedSample], position: Position, now: datetime) -> PaceExplained:
    """The vol part, the gap at the last sample it splits, and why for each figure that is absent."""
    m = _measure(samples, position)
    measured = None if isinstance(m, str) else m
    if isinstance(m, str):
        reason: str | None = m
    elif m.days == 0:
        reason = f"only {_day_words(m.from_)}, the day it was Opened, is recorded: nothing has moved yet"
    else:
        reason = None

    last = samples[-1] if samples else None

    timing: PacedTiming | None = None
    if last is not None:
        t = sample_timing(last.observed_at)
        timing = "in-hours" if t == "close" and last.observed_on == market_date(now) and in_sample_hours(now) else t

    opened_dte = dte_at_open(position.strike_date, position.opened_at) if position.opened_at else None
    gap: float | None = None
    gap_reason: str | None = None
    if opened_dte is None:
        gap_reason = "Opened is not recorded, so there is no On-pace to measure a gap from"
    elif last is None:
        gap_reason = "no day has been recorded for it yet"
    elif position.entry is None:
        gap_reason = "Entry is not recorded, so there is no On-pace to measure a gap from"
    else:
        pace = on_pace(position.entry, opened_dte, last.dte)
        if pace is None:
            gap_reason = f"there is no On-pace at {last.dte} DTE for a holding opened at {opened_dte} DTE"
        elif last.cost_to_close is None:
            gap_reason = f"{_day_words(last.observed_on)} has no Cost to close"
        else:
            gap = last.cost_to_close - pace

    # exposure-signed, short -1, as `position_greek` signs a holding's
    vega: float | None = None
    if last is not None and last.legs_vega is not None:
        codes = position_leg_codes(position)
        if all(_reading(last.legs_vega.get(c)) for c in codes):
            vega = 0.0
            for i, c in enumerate(codes):
                leg = position.legs[i]
                vega += (-1 if leg.side == "short" else 1) * leg.qty * last.legs_vega[c]
            if abs(vega) < VEGA_FLOOR:
                vega = 0.0

    cover: float | None = None
    cover_reason: str | None = None
    if gap is None:
        cover_reason = gap_reason
    elif vega is None:
        cover_reason = f"{_day_words(last.observed_on)} has no vega for every leg"
    elif vega == 0:
        cover_reason = "its legs' vegas cancel out, so no move in vol would cover the gap"
    else:
        cover = abs(gap / vega)

    return PaceExplained(
        vol=measured.vol if measured else None,
        from_=measured.from_ if measured else None,
        to=measured.to if measured else None,
        days=measured.days if measured else None,
        reason=reason,
        at=last.observed_on if last else None,
        timing=timing,
        gap=gap,
        gap_reason=gap_reason,
        rest=gap - measured.vol if reason is None and gap is not None and measured else None,
        vega=vega,
        cover=cover,
        cover_reason=cover_reason,
    )
