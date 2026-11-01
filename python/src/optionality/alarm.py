"""Whether a reading alarms, and what to say about it. Mirrors backend/src/domain/alarm.ts.

Ported under ADR 0017, which extended the golden cases past the arithmetic to the DECISIONS. The
notice is compared exactly, emoji and all: the direction (`fell ≤` against `crossed ≥`), the
recovery (`back above`, `back below`), the reminder suffix, and the figure at three decimals. Two
implementations agreeing on that sentence agree about far more than two agreeing on a boolean — and
it is the only thing in this package that exercises `to_fixed` through a case.

Nothing here sends anything. `alarm_policy` is deliberately absent: it reads the service's Settings,
so this package takes the two knobs directly, exactly as `exit.ExitPolicy` does.
"""

import math
from datetime import datetime

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from optionality.js import to_fixed
from optionality.monitor import Monitor, is_breached


class AlarmState(BaseModel):
    """What the database says about this rule right now. Accepts camelCase too, as the cases write it."""

    model_config = ConfigDict(frozen=True, alias_generator=to_camel, populate_by_name=True)
    triggered: bool
    last_alarm_at: datetime | None


class AlarmPolicy(BaseModel):
    model_config = ConfigDict(frozen=True, alias_generator=to_camel, populate_by_name=True)
    cooldown_seconds: float
    repeat_seconds: float


class AlarmDecision(BaseModel):
    model_config = ConfigDict(frozen=True)
    #: the flag's new value, or None when this reading does not change it
    triggered: bool | None
    #: what to send, or None for nothing. Non-None is also exactly when the stamp moves.
    notice: str | None


UNCHANGED = AlarmDecision(triggered=None, notice=None)


def _seconds_since(when: datetime | None, now: datetime) -> float:
    """Never alarmed counts as long ago, not as never: a rule whose first breach the cooldown
    swallowed has a flag and no stamp, and reading that as "too soon" would silence it for ever."""
    if when is None:
        return math.inf
    return (now - when).total_seconds()


def _figure(value: float) -> str:
    """Three decimals, through JavaScript's toFixed rather than Python's round: 0.0625 is 0.063
    here and 0.062 under `round`, and the cases carry that difference inside the sentence."""
    return f"{to_fixed(value, 3):.3f}"


def _below(monitor: Monitor) -> bool:
    return monitor.direction == "below"


def alarm_transition(
    monitor: Monitor,
    value: float,
    name: str,
    state: AlarmState,
    policy: AlarmPolicy,
    now: datetime,
) -> AlarmDecision:
    sign = "≤" if _below(monitor) else "≥"
    breached = is_breached(value, monitor.threshold, monitor.direction, monitor.compare)
    if breached == state.triggered:
        # the flag already says this; the only thing left to decide is whether to re-remind
        if not breached:
            return UNCHANGED
        repeat = policy.repeat_seconds
        if not repeat or _seconds_since(state.last_alarm_at, now) < repeat:
            return UNCHANGED
        return AlarmDecision(
            triggered=None,
            notice=f"⚠️ {name}: {monitor.field} {_figure(value)} still {sign} {monitor.threshold} (reminder)",
        )

    # the state changed, and it is written whether or not the owner hears about it
    if _seconds_since(state.last_alarm_at, now) < policy.cooldown_seconds:
        return AlarmDecision(triggered=breached, notice=None)
    if breached:
        word = "fell ≤" if _below(monitor) else "crossed ≥"
        words = f"⚠️ {name}: {monitor.field} {_figure(value)} {word} {monitor.threshold}"
    else:
        word = "back above" if _below(monitor) else "back below"
        words = f"✅ {name}: {monitor.field} {_figure(value)} {word} {monitor.threshold}"
    return AlarmDecision(triggered=breached, notice=words)
