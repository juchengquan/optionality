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

from optionality.js import js_string, to_fixed
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


def _mirrored(monitor: Monitor, value: float) -> bool:
    """A magnitude rule that read a NEGATIVE figure, so the whole comparison is mirrored to suit it.

    `is_breached` compares the magnitude under `compare: "abs"`, and the notice used to print the
    raw value beside a signed comparison — `option_delta -0.151 crossed >= 0.12`, which is false.
    The figure has to stay as it is, so that it matches the dashboard, so the COMPARISON moves:
    |v| >= t with v < 0 is v <= -t, and |v| <= t is v >= -t. The direction word flips and the
    threshold is shown negated, and every branch then reads true of the number beside it.
    """
    return monitor.compare != "signed" and value < 0


def _threshold(monitor: Monitor, value: float) -> str:
    """The threshold as JAVASCRIPT would write it, which drops a trailing `.0`.

    `Monitor.threshold` is a Python float, so `mid_price >= 5` printed "5.0" where the TypeScript
    prints "5" — a divergence in the one string ADR 0017 exists to compare exactly, in an ordinary
    rule. Every alarm case used 0.3, so the corpus could not see it (review 2026-11-01).
    """
    shown = -monitor.threshold if _mirrored(monitor, value) else monitor.threshold
    return js_string(shown)


def _below(monitor: Monitor, value: float) -> bool:
    return (monitor.direction == "below") != _mirrored(monitor, value)


def alarm_transition(
    monitor: Monitor,
    value: float,
    name: str,
    state: AlarmState,
    policy: AlarmPolicy,
    now: datetime,
) -> AlarmDecision:
    sign = "≤" if _below(monitor, value) else "≥"
    shown = _threshold(monitor, value)
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
            notice=f"⚠️ {name}: {monitor.field} {_figure(value)} still {sign} {shown} (reminder)",
        )

    # the state changed, and it is written whether or not the owner hears about it
    if _seconds_since(state.last_alarm_at, now) < policy.cooldown_seconds:
        return AlarmDecision(triggered=breached, notice=None)
    if breached:
        word = "fell ≤" if _below(monitor, value) else "crossed ≥"
        words = f"⚠️ {name}: {monitor.field} {_figure(value)} {word} {shown}"
    else:
        word = "back above" if _below(monitor, value) else "back below"
        words = f"✅ {name}: {monitor.field} {_figure(value)} {word} {shown}"
    return AlarmDecision(triggered=breached, notice=words)
