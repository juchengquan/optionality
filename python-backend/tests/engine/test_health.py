"""The alarm engine's account of its own health: what /health reads, and what moves it.

backend/src/engine/health.ts has no test of its own: `engine/sweeper.test.ts` reads it through
`s.health` after `MonitorSweeper.sweep()`, so those are its callers' tests. They are ported, one for
one, in `test_sweeper.py` — "the watchdog", "a sweep that never came back", and the cases elsewhere in
that suite that read the account after a sweep — against the real sweep, now that it is ported. This
module held them against an imitation of the sweep until then, and keeps only what no sweep test can
show: what the account does with its own notices and its own memory.

A sweep here is what `MonitorSweeper.sweep` TELLS the account, in its order: `started_sweep` as it
begins, then `fetched` and `failure()` when the Provider refuses the batch, or `fetched` and
`success()` when it answers (`Engine.sweep`). The clock moves between sweeps as the TypeScript's `now`
does. What only the Python can get wrong is at the end.
"""

import logging
from datetime import UTC, datetime, timedelta

import pytest
from sweep import SWEEP_SETTINGS

from optionality_backend.engine.health import SweepHealth, SweepHealthDeps
from optionality_backend.env import settings_for
from optionality_backend.notify import NotifySender, notifier
from optionality_backend.ports import AlarmState, SweeperPort

LOG = "optionality_backend.engine.health"

#: The live sweep cadence (`MONITOR_INTERVAL_SECONDS` in .env), in seconds.
#:
#: The window below is crossed at it, sweep by sweep, as the live service crosses it.
CADENCE = 15


class Engine:
    """The test's clock, what was sent, and the one health account reading both — as the sweeper
    builds it: `notify` from the settings and the sender, `now` the sweep's own clock."""

    def __init__(self, send: NotifySender | None = None, **over: object) -> None:
        self.now = datetime(2026, 10, 1, 5, 0, tzinfo=UTC)
        self.sent: list[str] = []
        self.failing = False
        self.settings = settings_for(**{**SWEEP_SETTINGS, **over})
        notify = notifier(self.settings, send or self.sent.append)
        self.health = SweepHealth(SweepHealthDeps(settings=self.settings, notify=notify, now=lambda: self.now))

    async def sweep(self) -> None:
        """One sweep with something to fetch, as `runSweep` tells the account about it."""
        at = self.now
        self.health.started_sweep(at)
        if self.failing:
            self.health.fetched(False)
            await self.health.failure()
            return
        self.health.fetched(True, self.now)
        await self.health.success()

    async def tick(self) -> None:
        """One sweep, a cadence later. The clock MOVES between sweeps, as the scheduler makes it."""
        self.now += timedelta(seconds=CADENCE)
        await self.sweep()

    def said(self, words: str) -> list[str]:
        return [t for t in self.sent if words in t]


class TestWhatNoCallerReads:
    async def test_keeps_its_account_when_the_sender_of_its_own_notices_throws(self) -> None:
        # the recovery's send comes AFTER the counters are cleared, so a failed one must not leave the
        # service looking degraded. "survives a sender that throws" holds the sweep's alarm notices;
        # this holds the account's own, which no sweep test reaches
        def send(text: str) -> None:
            raise RuntimeError("telegram is down")

        e = Engine(send=send)
        e.failing = True
        for _ in range(e.settings.degraded_after_failures):
            await e.sweep()
        e.failing = False
        await e.sweep()
        assert e.health.consecutive_failures() == 0
        assert e.health.last_sweep_ok() is True

    async def test_forgets_failures_older_than_the_window_so_the_list_cannot_grow(self) -> None:
        # what the field's comment promises and nothing else can see: `flapping_verdict` ignores a
        # failure outside the window whether or not it was pruned, so only the memory depends on this
        e = Engine()
        e.failing = True
        window = e.settings.flapping_window_seconds
        for _ in range(window // CADENCE * 3):
            await e.tick()
        assert len(e.health.recent_failures) == window // CADENCE + 1
        assert (e.now - e.health.recent_failures[0]).total_seconds() == window


class TestWhatOnlyThePythonCanGetWrong:
    def test_answers_the_sweeper_port_which_is_all_the_routes_see(self) -> None:
        assert isinstance(Engine().health, SweeperPort)

    async def test_says_a_stalls_age_as_javascript_would(self) -> None:
        # `Math.round` and a number in a template: 88.5 is "89s", a half rounded up — where Python's
        # `round` says 88, and its `str` of a float says "89.0"
        e = Engine()
        for _ in range(e.settings.degraded_after_failures):
            await e.health.record_stall(88.5)
        [notice] = e.said("degraded")
        assert notice.endswith("(a sweep stuck for 89s)")

    def test_says_how_long_since_a_sweep_began_as_javascript_would(self) -> None:
        e = Engine()
        e.health.sweep_at = e.now - timedelta(seconds=240.5)
        assert e.health.alarm_state() == AlarmState(label="STALLED (no sweep for 241s)", bad=True)

    async def test_logs_an_abandoned_sweep_with_its_age(self, caplog: pytest.LogCaptureFixture) -> None:
        with caplog.at_level(logging.ERROR, logger=LOG):
            await Engine().health.record_stall(90.2)
        assert [(r.levelno, r.getMessage()) for r in caplog.records if r.name == LOG] == [
            (logging.ERROR, "monitor sweep abandoned after 90s")
        ]
