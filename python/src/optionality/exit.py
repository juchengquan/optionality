"""Exit schedules from a decay shape (ADR 0011). Mirrors backend/src/domain/exit.ts.

On-pace is a REFERENCE — what Cost to close would be at a DTE if only time had passed — and no alarm
is ever raised from it. `target_dte` uses JavaScript's `Math.round`, which ties up where Python's
`round` ties to even: 12.5 is 13 here, as in the service.
"""

import math
from datetime import date
from typing import Literal

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from optionality._js import math_round
from optionality.contract import normalize_strike_date


class ExitPolicy(BaseModel):
    """The three knobs the service reads from its settings. Accepts camelCase too, as the cases write it."""

    model_config = ConfigDict(frozen=True, alias_generator=to_camel, populate_by_name=True)
    take_fraction: float
    stop_multiple: float
    manage_by_dte: int


class ExitLevels(BaseModel):
    model_config = ConfigDict(frozen=True)
    on_pace: float | None
    pace_gap: float | None
    target: float | None
    stop: float | None
    target_dte: int | None
    manage_by_dte: int
    reached: Literal["target", "stop"] | None
    manage_by_due: bool


def dte_at_open(strike_date: str, opened_at: str) -> int:
    """DTE on the day the Position was Opened."""
    return (
        date.fromisoformat(normalize_strike_date(strike_date)) - date.fromisoformat(normalize_strike_date(opened_at))
    ).days


def on_pace(entry: float | None, opened_dte: int | None, dte: int) -> float | None:
    if entry is None or opened_dte is None:
        return None
    if opened_dte <= 0 or dte < 0 or dte > opened_dte:
        return None
    return entry * math.sqrt(dte / opened_dte)


def exit_levels(
    entry: float | None,
    opened_dte: int | None,
    dte: int,
    policy: ExitPolicy,
    cost_to_close: float | None = None,
) -> ExitLevels | None:
    """The schedule at `dte`, or None when the Position was never declared Opened."""
    if opened_dte is None:
        return None
    pace = on_pace(entry, opened_dte, dte)
    credit = entry is not None and entry > 0
    target = entry * (1 - policy.take_fraction) if credit else None
    stop = entry * policy.stop_multiple if credit else None
    reached: Literal["target", "stop"] | None = None
    if cost_to_close is not None and target is not None and stop is not None:
        if cost_to_close >= stop:
            reached = "stop"
        elif cost_to_close <= target:
            reached = "target"
    return ExitLevels(
        on_pace=pace,
        pace_gap=None if pace is None or cost_to_close is None else cost_to_close - pace,
        target=target,
        stop=stop,
        target_dte=int(math_round(opened_dte * (1 - policy.take_fraction) ** 2)) if credit and opened_dte > 0 else None,
        manage_by_dte=policy.manage_by_dte,
        reached=reached,
        manage_by_due=dte <= policy.manage_by_dte,
    )
