"""Monitors: a rule that watches one value. Mirrors backend/src/domain/monitor.ts.

A combo's value is the signed sum of its legs under their signs — minus is short — with NO partial
sums: any unpriced leg leaves no value. IV is never summed. The 🔔 flips at the EXACT threshold.
"""

from typing import Literal

from pydantic import BaseModel, ConfigDict

from optionality._js import number
from optionality.contract import build_spx_code
from optionality.quote import ByCode

COMBO_GREEK_FIELDS = ("option_delta", "option_gamma", "option_theta", "option_vega")
NON_ADDITIVE_FIELDS = frozenset({"option_implied_volatility"})

type ThresholdFault = Literal["abs-not-positive", "signed-zero"]


class MonitorLeg(BaseModel):
    model_config = ConfigDict(frozen=True, extra="ignore")
    sign: Literal[1, -1]
    option_type: Literal["CALL", "PUT"]
    strike: float


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
        total += leg.sign * number(value)
    return total


def monitor_value(monitor: Monitor, by_code: ByCode) -> float | None:
    if not monitor.legs:
        record = by_code.get(monitor.code)
        value = None if record is None else record.get(monitor.field)
        return None if value is None else number(value)
    return combo_field_sum(monitor, by_code, monitor.field)


def threshold_fill(value: float | None, threshold: float | None, direction: str, compare: str) -> int | None:
    """How far a value has travelled toward its threshold, 0-100, rounded half to even."""
    if value is None or not threshold:
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
    return max(0, min(100, round(ratio * 100)))


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
