"""A provider that keeps failing and recovering. Mirrors typescript/src/domain/flapping.ts.

Written after an hour of exactly that went unnoticed on 2026-11-08: a launchd agent was killing
OpenD 27 seconds after every start and restarting it a minute later, so the sweep failed roughly a
third of the time. `degraded.py` could not see it — it counts CONSECUTIVE failures, and every
success in between reset the counter below the threshold. A consecutive count measures how LONG a
failure lasted; nothing measured how OFTEN one happened.

The notice is compared exactly, emoji and all, so the two implementations agree on the wording and
not merely on whether to speak: the count, the window's shape ("15m", "1h30m"), the inclusive edge,
and the silence underneath `degraded`'s own notice.

`flapping_policy` is deliberately absent, as `degraded.degraded_policy` and `alarm.alarm_policy`
are: it reads the service's Settings, so this package takes the knobs directly.
"""

import math
from datetime import datetime

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel


class FlappingState(BaseModel):
    """The recent failures as the sweeper has recorded them. Accepts camelCase too, as the cases write it."""

    model_config = ConfigDict(frozen=True, alias_generator=to_camel, populate_by_name=True)
    #: when each recent sweep failed; anything outside the window is ignored rather than trusted
    #: to have been pruned
    failures: list[datetime]
    #: when the owner was last told the provider is unreliable; None if never
    last_notice_at: datetime | None
    #: whether a sustained outage has already been announced, in words that fit it better
    announced: bool


class FlappingPolicy(BaseModel):
    model_config = ConfigDict(frozen=True, alias_generator=to_camel, populate_by_name=True)
    window_seconds: float
    after_failures: int
    repeat_seconds: float


class FlappingVerdict(BaseModel):
    model_config = ConfigDict(frozen=True)
    #: what to send, or None for nothing. Non-None is also exactly when the stamp moves.
    notice: str | None


SILENT = FlappingVerdict(notice=None)


def _spoken(seconds: float) -> str:
    """The window, said the way a person would."""
    minutes = math.floor(seconds / 60)
    if minutes < 60:
        return f"{minutes}m"
    return f"{minutes // 60}h{minutes % 60}m"


def _since(when: datetime | None, now: datetime) -> float:
    if when is None:
        return math.inf
    return (now - when).total_seconds()


def flapping_verdict(
    state: FlappingState, policy: FlappingPolicy, now: datetime
) -> FlappingVerdict:
    """Whether to say the provider is unreliable, and what."""
    if not policy.after_failures:
        return SILENT

    # a sustained outage is already being reported, in words that fit it better
    if state.announced:
        return SILENT

    # inclusive at the edge: a failure exactly `window_seconds` old is the oldest one this window
    # is about, and excluding it would make the count depend on the millisecond a sweep landed on
    inside = [at for at in state.failures if _since(at, now) <= policy.window_seconds]
    if len(inside) < policy.after_failures:
        return SILENT

    told = state.last_notice_at is not None
    if told and (
        not policy.repeat_seconds
        or _since(state.last_notice_at, now) < policy.repeat_seconds
    ):
        return SILENT

    return FlappingVerdict(
        notice=(
            f"⚠️ monitoring unreliable: {len(inside)} failed sweeps in the last "
            f"{_spoken(policy.window_seconds)}, with successes in between — a provider that keeps "
            "dropping and recovering"
        )
    )
