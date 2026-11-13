"""Monitors: a rule that watches one value. Mirrors typescript/src/domain/monitor.ts.

A combo's value is the signed sum of its legs under their signs — minus is short — with NO partial
sums: any unpriced leg leaves no value. IV is never summed. The 🔔 flips at the EXACT threshold.
"""

import math
from typing import Literal

from pydantic import BaseModel, ConfigDict, SerializerFunctionWrapHandler, model_serializer

from optionality.contract import build_spx_code
from optionality.js import number
from optionality.quote import ByCode

COMBO_GREEK_FIELDS = ("option_delta", "option_gamma", "option_theta", "option_vega")
NON_ADDITIVE_FIELDS = frozenset({"option_implied_volatility"})

type ThresholdFault = Literal["abs-not-positive", "signed-zero"]


class MonitorLeg(BaseModel):
    model_config = ConfigDict(frozen=True, extra="ignore")
    sign: Literal[1, -1]
    option_type: Literal["CALL", "PUT"]
    strike: float
    #: how many of this contract one of the combo holds: the 2 of a 1×2 ratio (#351). Absent is 1,
    #: which is every row written before it; it multiplies the leg's signed figure and nothing else.
    qty: int = 1

    @model_serializer(mode="wrap")
    def _as_given(self, handler: SerializerFunctionWrapHandler) -> dict[str, object]:
        """`qty` dumped only where it was given, as the TypeScript's optional key is: a leg recorded
        before #351 has none, and one that says 1 says so."""
        data = handler(self)
        if "qty" not in self.model_fields_set:
            data.pop("qty", None)
        return data


class Monitor(BaseModel):
    """A rule. `legs` present makes it a combo; absent or empty, it watches `code` alone."""

    model_config = ConfigDict(frozen=True, extra="ignore")
    code: str
    strike_date: str
    option_type: str
    strike: float
    field: str
    threshold: float
    direction: str
    compare: str
    legs: tuple[MonitorLeg, ...] | None = None
    id: str | None = None


def monitor_leg_codes(monitor: Monitor) -> list[str]:
    if not monitor.legs:
        return [monitor.code]
    return [build_spx_code(monitor.strike_date, leg.option_type, leg.strike) for leg in monitor.legs]


def combo_field_error(field: str) -> str | None:
    if field in NON_ADDITIVE_FIELDS:
        return f"combos cannot watch {field}: it is not additive across legs"
    return None


def combo_field_sum(monitor: Monitor, by_code: ByCode, field: str) -> float | None:
    if combo_field_error(field):
        return None  # guard for legacy rows: never fabricate a summed IV
    legs = monitor.legs or ()
    codes = monitor_leg_codes(monitor)
    if len(legs) != len(codes):
        raise ValueError("a code per leg")
    total = 0.0
    for leg, code in zip(legs, codes, strict=True):
        record = by_code.get(code)
        value = None if record is None else record.get(field)
        if value is None:
            return None
        total += leg.sign * leg.qty * number(value)
    return total


def monitor_value(monitor: Monitor, by_code: ByCode) -> float | None:
    if not monitor.legs:
        record = by_code.get(monitor.code)
        value = None if record is None else record.get(monitor.field)
        return None if value is None else number(value)
    return combo_field_sum(monitor, by_code, monitor.field)


def threshold_fill(value: float | None, threshold: float | None, direction: str, compare: str) -> int | None:
    """How far a value has travelled toward its threshold, 0-100, rounded half to even."""
    # `not threshold` excludes 0 as well as a missing one — nothing can be a fraction of zero — and
    # NaN with it, because JavaScript's `!NaN` is true where Python's `not nan` is False: a NaN
    # threshold answered a fill here and None there (review 2026-11-01).
    if value is None or not threshold or math.isnan(threshold):
        return None
    metric = abs(value) if compare == "abs" else value
    if metric < 0 or threshold < 0:
        return None
    if direction == "above":
        ratio = metric / threshold
    elif metric > 0:
        ratio = threshold / metric
    else:
        return None
    scaled = ratio * 100
    # a NaN reading is not a fill, and `round(nan)` raises where the TypeScript propagated it to
    # the bar's width as "NaN%". Both answer "no figure" now; infinity still clamps.
    if math.isnan(scaled):
        return None
    if math.isinf(scaled):
        return 100 if scaled > 0 else 0
    return max(0, min(100, round(scaled)))


def threshold_fault(compare: str, threshold: float) -> ThresholdFault | None:
    """Why a threshold cannot be compared that way: an abs threshold must be positive, a signed one
    must not be exactly zero."""
    if compare == "abs" and threshold <= 0:
        return "abs-not-positive"
    if compare == "signed" and threshold == 0:
        return "signed-zero"
    return None


def is_breached(value: float, threshold: float, direction: str, compare: str) -> bool:
    """Whether the value has breached, at the threshold exactly. Anything not "below" is above."""
    metric = value if compare == "signed" else abs(value)
    return metric <= threshold if direction == "below" else metric >= threshold


def threshold_distance(value: float | None, threshold: float, direction: str, compare: str) -> float | None:
    """How far the watched figure still has to move to breach, in the field's own units (ADR 0023).

    `is_breached` said as a number, reading the figure as it does, so the distance is at or below zero
    EXACTLY when `is_breached` is true — 0 at the threshold itself — and negative by how far past it.
    None where there is no figure to measure: no reading, a NaN one, or a NaN threshold."""
    if value is None:
        return None
    metric = value if compare == "signed" else abs(value)
    distance = metric - threshold if direction == "below" else threshold - metric
    return None if math.isnan(distance) else distance
