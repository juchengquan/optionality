"""What the owner is told when the service cannot see the market. Mirrors typescript/src/domain/degraded.ts.

The reminder this module exists for was written after 2026-11-08, when moomoo's OpenD exited cleanly
after 23 days up, nothing restarted it, and the sweep failed 646 times over 2h42m — while the owner
was told once, at the fifth failure, and then heard nothing. The first notice was not the bug; the
silence after it was.

The notices are compared exactly, emoji and all, so the two implementations agree on the wording and
not merely on whether to speak: the threshold, the "still degraded" switch, the duration's shape
("over 7m", "over 3h5m", "over under a minute") and its absence when the start is unknown.

`degraded_policy` is deliberately absent, as `alarm.alarm_policy` and `exit.exit_policy` are: it
reads the service's Settings, so this package takes the two knobs directly.
"""

import math
from datetime import datetime

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel


class DegradedState(BaseModel):
    """The run of failures as the sweeper has counted it. Accepts camelCase too, as the cases write it."""

    model_config = ConfigDict(frozen=True, alias_generator=to_camel, populate_by_name=True)
    #: consecutive failed sweeps, counting the one being recorded
    failures: int
    #: when the run began; None when the service was restarted mid-outage
    since: datetime | None
    #: when the owner was last told anything about this outage; None if never
    last_notice_at: datetime | None


class DegradedPolicy(BaseModel):
    model_config = ConfigDict(frozen=True, alias_generator=to_camel, populate_by_name=True)
    #: how many consecutive failures before the owner hears about it at all
    after_failures: int
    #: re-reminds while it has not recovered; 0 off
    repeat_seconds: float


class DegradedVerdict(BaseModel):
    model_config = ConfigDict(frozen=True)
    #: what to send, or None for nothing. Non-None is also exactly when the stamp moves.
    notice: str | None


SILENT = DegradedVerdict(notice=None)


def _over(since: datetime | None, now: datetime) -> str:
    """How long it has been broken, or "" when the start is unknown.

    Unknown is a real case rather than a defensive one: the failure counter lives in the service's
    memory, so a restart mid-outage has failures and no start. Saying nothing is honest; deriving a
    start from the failure count would read as measured and be a guess about the sweep interval.
    """
    if since is None:
        return ""
    seconds = math.floor((now - since).total_seconds())
    if seconds < 60:
        return " over under a minute"
    minutes = seconds // 60
    if minutes < 60:
        return f" over {minutes}m"
    return f" over {minutes // 60}h{minutes % 60}m"


def _since(when: datetime | None, now: datetime) -> float:
    if when is None:
        return math.inf
    return (now - when).total_seconds()


def degraded_verdict(
    state: DegradedState, policy: DegradedPolicy, reason: str, now: datetime
) -> DegradedVerdict:
    """Whether to say anything about a failed sweep, and what.

    `reason` comes from the caller and names no vendor: the Provider is whichever one the deployment
    is configured with, and a notice saying "OpenD" while another Provider is answering is the bug
    ADR 0018 fixed in `verify_contracts` and this branch fixed once more in the sweeper's default.
    """
    failures = state.failures
    if failures < policy.after_failures:
        return SILENT

    if state.last_notice_at is not None:
        # due by the clock, not by the failure count, so the interval means the same thing whatever
        # MONITOR_INTERVAL_SECONDS is set to
        if not policy.repeat_seconds or _since(state.last_notice_at, now) < policy.repeat_seconds:
            return SILENT
        return DegradedVerdict(
            notice=(
                f"⚠️ monitoring still degraded: {failures} consecutive sweep failures"
                f"{_over(state.since, now)} ({reason})"
            )
        )

    # Past the threshold with nothing sent yet means the first notice never got out — a failed
    # send, or a service that started up already broken. The owner hears the FIRST wording rather
    # than a reminder, because "still degraded" implies an earlier message.
    return DegradedVerdict(
        notice=f"⚠️ monitoring degraded: {failures} consecutive sweep failures ({reason})"
    )


def recovered_notice(
    state: DegradedState, policy: DegradedPolicy, now: datetime
) -> str | None:
    """What to say when it comes back, or None when the owner was never told it was broken.

    Announcing a recovery from a problem nobody heard about is noise, and noise is what teaches
    someone to stop reading the channel the alarms arrive on.
    """
    if state.failures < policy.after_failures:
        return None
    elapsed = _over(state.since, now)
    return f"✅ monitoring recovered{' after' + elapsed.replace(' over', '') if elapsed else ''}"
