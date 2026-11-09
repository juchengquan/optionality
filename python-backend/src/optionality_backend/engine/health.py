"""The alarm engine's account of its own health: what `/health` reads, and what moves it. Port of
backend/src/engine/health.ts.

Paired with `entrypoints/http/routes/health.py` the way `monitors.py`, `positions.py` and
`references.py` are paired with their routes — the module does the work, the route reports it.

It was nine mutable fields and ten methods on `MonitorSweeper`, interleaved with the sweep itself,
and splitting them out cost nothing because the seam was already drawn: this class implements
`SweeperPort` exactly, which is the interface the HTTP layer had always reached the engine through
(`ports.py`). The sweep holds one, calls `success()` or `failure()` at the end of a sweep, and keeps
the database, the quotes and the alarms. Nothing in here opens a database or sends a quote request;
the only IO is a Telegram line.

Everything it remembers is IN MEMORY on purpose, and the reason is the same for every field: each
claim is about a RUN — of failures, of sweeps — and a restart genuinely breaks the run. Nothing was
being swept while the service was down, so a count carried across a restart would be about a
stretch of time the engine did not observe. The cost is that a service restarted mid-outage reports
the failures without the duration, which `optionality.degraded` prints as nothing rather than as a
guess, and that a deploy gives a recovering provider its full count again — the conservative
direction in both cases.

WHETHER a run of failures is worth a message is `optionality.degraded` and `optionality.flapping`,
not this file: the two measure different things (how LONG a failure lasted, and how OFTEN one
happens) and only one of them may speak per sweep, because two notices about one unavailable
provider is the noise that teaches somebody to stop reading the channel.

The class is deliberately NOT exported by the engine's door (`engine/__init__.py` says why), so the
one instance is the one `MonitorSweeper` builds and hands out as `sweeper.health`.

**Where the Python differs, and why.**

- **The two policies are read here.** The TypeScript takes `degradedPolicy` and `flappingPolicy`
  from the library's domain; the Python library leaves both out because they read the service's
  Settings (its own docstrings say so) and takes the knobs directly. So `_degraded_policy` and
  `_flapping_policy` below read the same settings into the same fields.
- **A number in a sentence goes through `optionality.js`**: `math_round` and `js_string`, so a stall
  is "90s" as the TypeScript says it, never Python's "90.0s", and 88.5 rounds up to 89 as
  `Math.round` does where Python's `round` gives 88.
- `SweepHealthDeps` is a frozen dataclass, and `alarm_state` answers `ports.AlarmState`, the
  TypeScript's anonymous `{ label, bad }` with a name.
"""

import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime

from optionality.degraded import DegradedPolicy, DegradedState, degraded_verdict, recovered_notice
from optionality.flapping import FlappingPolicy, FlappingState, flapping_verdict
from optionality.js import js_string, math_round

from ..env import Settings
from ..notify import Notifier
from ..ports import AlarmState

log = logging.getLogger(__name__)

#: How many sweep intervals may pass with nothing starting before the engine calls itself stalled.
#:
#: One sweep can legitimately overrun a tick — a batch takes real time. Four in a row is not an
#: overrun, it is a sweep that is not coming back, and /health must stop calling that "active".
#: `scheduler.py`'s watchdog abandons at the same age, so the engine says stalled and then recovers
#: itself rather than waiting for a restart.
STALE_AFTER_SWEEPS = 4


def _degraded_policy(settings: Settings) -> DegradedPolicy:
    return DegradedPolicy(
        after_failures=settings.degraded_after_failures, repeat_seconds=settings.degraded_repeat_seconds
    )


def _flapping_policy(settings: Settings) -> FlappingPolicy:
    return FlappingPolicy(
        window_seconds=settings.flapping_window_seconds,
        after_failures=settings.flapping_after_failures,
        repeat_seconds=settings.flapping_repeat_seconds,
    )


@dataclass(frozen=True)
class SweepHealthDeps:
    settings: Settings
    notify: Notifier
    now: Callable[[], datetime]


class SweepHealth:
    def __init__(self, deps: SweepHealthDeps) -> None:
        self._deps = deps
        self.consecutive_failures_count = 0
        #: When the current run of failures began, and when the owner was last told about it.
        self.degraded_since: datetime | None = None
        self.last_degraded_notice_at: datetime | None = None
        #: When each recent sweep failed, for the RATE rather than the run.
        #:
        #: A consecutive count measures how LONG a failure lasted and cannot see a provider that keeps
        #: dropping and recovering — which went unnoticed for an hour on 2026-11-08. Pruned to the
        #: window on every append, so this cannot grow: at a 15s sweep and a 15m window it holds at
        #: most 60 entries.
        self.recent_failures: list[datetime] = []
        self.last_flapping_notice_at: datetime | None = None
        #: Stamped at the START of a sweep — one instant per sweep, which is what makes `_stale_for`
        #: able to see a sweep that began and never ended. Nothing else notices that.
        self.sweep_at: datetime | None = None
        #: None until the first sweep: "starting" is a different thing from "working"
        self.sweep_ok: bool | None = None
        self.fetch_at: datetime | None = None
        #: What the last batch actually did: None before any was asked for. A port probe cannot
        #: answer this — OpenD can hold the socket open and refuse to log in (2026-10-16).
        self.fetch_ok: bool | None = None

    # --- what a sweep tells it -------------------------------------------------------------------
    def started_sweep(self, at: datetime) -> None:
        """A sweep has begun. One instant per sweep, held by the sweep as a local too: every date a
        sweep reckons must come from the same instant or a sweep straddling midnight disagrees with
        itself."""
        self.sweep_at = at

    def fetched(self, ok: bool, at: datetime | None = None) -> None:
        """A batch came back, or did not. Separate from the sweep's own verdict because they are
        different questions: a batch can arrive and the sweep still fail on the work after it."""
        self.fetch_ok = ok
        if ok and at is not None:
            self.fetch_at = at

    # --- the SweeperPort the /health route reads -------------------------------------------------
    def last_sweep_at(self) -> datetime | None:
        return self.sweep_at

    def last_fetch_at(self) -> datetime | None:
        return self.fetch_at

    def last_sweep_ok(self) -> bool:
        if self._stale_for() is not None:
            return False
        return True if self.sweep_ok is None else self.sweep_ok

    def last_fetch_ok(self) -> bool | None:
        """Whether the last batch came back, for /health to report in place of a port probe."""
        return self.fetch_ok

    def consecutive_failures(self) -> int:
        return self.consecutive_failures_count

    def alarm_state(self) -> AlarmState:
        """The human label the status strip shows. Derived here so the engine gives its own account of
        its health rather than the client inferring one."""
        # a sweep that never came back outranks whatever the last one that did come back reported
        stale = self._stale_for()
        if stale is not None:
            return AlarmState(label=f"STALLED (no sweep for {js_string(math_round(stale))}s)", bad=True)
        if self.sweep_ok is None:
            return AlarmState(label="starting", bad=False)
        if self.sweep_ok:
            return AlarmState(label="active", bad=False)
        n = self.consecutive_failures_count
        return AlarmState(label=f"STALLED ({n} failed sweep{'' if n == 1 else 's'})", bad=True)

    def _stale_for(self) -> float | None:
        """How long since a sweep last BEGAN, if that is longer than the engine tolerates."""
        if self.sweep_at is None:
            return None  # nothing has started: that is "starting", not stalled
        age = (self._deps.now() - self.sweep_at).total_seconds()
        limit = self._deps.settings.monitor_interval_seconds * STALE_AFTER_SWEEPS
        return age if age > limit else None

    # --- the record a sweep leaves ---------------------------------------------------------------
    async def record_stall(self, age_seconds: float) -> None:
        """A sweep the loop gave up waiting for (`scheduler.py`'s watchdog).

        Counted as a failure, because a sweep that never returned told us less than one that failed:
        without this the next tick simply starts another and the stall leaves no trace anywhere.
        """
        age = js_string(math_round(age_seconds))
        log.error("monitor sweep abandoned after %ss", age)
        await self.failure(f"a sweep stuck for {age}s")

    async def failure(self, reason: str = "the Provider did not answer") -> None:
        """The default names no vendor on purpose: the Provider is whichever one this deployment is
        configured with, and this said "OpenD unreachable?" whatever was answering. Same bug ADR 0018
        fixed in `verify_contracts`, which was not the only place it had been written."""
        settings, notify = self._deps.settings, self._deps.notify
        now = self._deps.now()
        self.sweep_ok = False
        self.consecutive_failures_count += 1
        if self.degraded_since is None:
            self.degraded_since = now

        # the rate, beside the run: pruned here so the list cannot grow
        self.recent_failures.append(now)
        while (
            self.recent_failures and (now - self.recent_failures[0]).total_seconds() > settings.flapping_window_seconds
        ):
            self.recent_failures.pop(0)

        announced = self.last_degraded_notice_at is not None
        verdict = degraded_verdict(
            DegradedState(
                failures=self.consecutive_failures_count,
                since=self.degraded_since,
                last_notice_at=self.last_degraded_notice_at,
            ),
            _degraded_policy(settings),
            reason,
            now,
        )
        # the stamp moves only when something was actually said, which is what makes the interval
        # measure silence rather than sweeps
        if verdict.notice is not None:
            self.last_degraded_notice_at = now
            await notify(verdict.notice)
            return

        # and only where the sustained notice said nothing: two notices about one unavailable
        # provider is noise, and `announced` is read BEFORE the line above so a sweep cannot both
        # announce an outage and call it unreliable
        flapping = flapping_verdict(
            FlappingState(
                failures=self.recent_failures, last_notice_at=self.last_flapping_notice_at, announced=announced
            ),
            _flapping_policy(settings),
            now,
        )
        if flapping.notice is not None:
            self.last_flapping_notice_at = now
            await notify(flapping.notice)

    async def success(self) -> None:
        settings, notify = self._deps.settings, self._deps.notify
        notice = recovered_notice(
            DegradedState(
                failures=self.consecutive_failures_count,
                since=self.degraded_since,
                last_notice_at=self.last_degraded_notice_at,
            ),
            _degraded_policy(settings),
            self._deps.now(),
        )
        self.consecutive_failures_count = 0
        self.degraded_since = None
        self.last_degraded_notice_at = None
        self.sweep_ok = True
        # `recent_failures` is NOT cleared, which is the whole point: a success is exactly what a
        # flapping provider produces between failures, and clearing on one would make this blind to the
        # thing it was written for. Entries age out of the window instead.
        # after the counters are cleared: a failed send must not leave the service looking degraded
        if notice is not None:
            await notify(notice)
