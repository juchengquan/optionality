"""The alarm engine's account of its own health: what /health reads, and what moves it.

backend/src/engine/health.ts has no test of its own: `engine/sweeper.test.ts` reads it through
`s.health` after `MonitorSweeper.sweep()`, so those are its callers' tests, and these hold what they
rely on. Its describes "the watchdog" and "a sweep that never came back" are ported one for one,
under the same names, and four cases elsewhere in it that read the account after a sweep are held in
`TestWhatTheSweepReadsBack`: "survives a sender that throws", "mutes an expired monitor with a
notice" (a sweep with nothing to fetch is a sweep that succeeded), "is quarantined, not deleted"
(containment is a success) and "is not a success when the work after the batch throws".

The sweeper is not ported yet, so a sweep here is what `MonitorSweeper.sweep` TELLS the account, in
its order: `started_sweep` as it begins, then `fetched` and `failure()` when the Provider refuses the
batch, or `fetched` and `success()` when it answers (`Engine.sweep`). The clock moves between sweeps
as the TypeScript's `now` does. What only the Python can get wrong is at the end.
"""

import logging
import re
from datetime import UTC, datetime, timedelta

import pytest

from optionality_backend.engine.health import STALE_AFTER_SWEEPS, SweepHealth, SweepHealthDeps
from optionality_backend.env import settings_for
from optionality_backend.notify import NotifySender, notifier
from optionality_backend.ports import AlarmState, SweeperPort

LOG = "optionality_backend.engine.health"

#: `testing/sweep.ts`'s SWEEP_SETTINGS, which every sweep test starts from
SWEEP_SETTINGS = {
    "telegram_bot_token": "t",
    "telegram_chat_id": "c",
    "alarm_cooldown_seconds": 0,
    "display_tz": "Asia/Singapore",
}

#: The live sweep cadence (`MONITOR_INTERVAL_SECONDS` in .env), in seconds.
#:
#: Tests about a window of TIME sweep at this, rather than jumping the clock once: a window is ~120
#: sweeps wide at the live cadence, and the two that matter below are only ever crossed correctly if
#: nothing a sweep does to the alarm stamp depends on there having been few of them.
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

    async def sweep_for(self, seconds: int) -> None:
        """Sweep at the live cadence for `seconds` of wall clock — the sweeps a window actually holds."""
        for _ in range(0, seconds, CADENCE):
            await self.tick()

    def said(self, words: str) -> list[str]:
        return [t for t in self.sent if words in t]


def after(started: datetime, ms: int) -> datetime:
    return started + timedelta(milliseconds=ms)


class TestTheWatchdog:
    async def test_reports_degraded_once_at_the_threshold_and_recovers(self) -> None:
        e = Engine()
        e.failing = True
        limit = e.settings.degraded_after_failures

        for _ in range(limit + 1):
            await e.sweep()
        # edge-triggered, not once per failure
        assert len(e.said("degraded")) == 1
        assert e.health.consecutive_failures() == limit + 1
        assert e.health.last_sweep_ok() is False

        e.failing = False
        await e.sweep()
        assert e.said("recovered")
        assert e.health.consecutive_failures() == 0
        assert e.health.last_sweep_ok() is True

    async def test_keeps_saying_so_while_it_is_still_broken_and_says_how_long(self) -> None:
        # The gap this closes, measured: on 2026-11-08 OpenD exited and 646 sweeps failed over 2h42m,
        # and the owner got ONE message, in the first minute. The notice was right; the silence after
        # it meant the engine knew something the owner no longer did.
        e = Engine()
        e.failing = True
        limit = e.settings.degraded_after_failures
        started = e.now

        for _ in range(limit):
            await e.sweep()
        assert len(e.said("degraded")) == 1
        assert "⚠️ monitoring degraded:" in e.sent[0]

        # half an hour of failing sweeps: the reminder is due by the CLOCK, so time has to move
        e.now = after(started, 1_799_000)
        await e.sweep()
        assert len(e.said("degraded")) == 1

        e.now = after(started, 1_801_000)
        await e.sweep()
        reminders = e.said("still degraded")
        assert len(reminders) == 1
        assert "over 30m" in reminders[0]

        # and not again until the next interval
        e.now = after(started, 1_900_000)
        await e.sweep()
        assert len(e.said("still degraded")) == 1

        e.failing = False
        e.now = after(started, 9_720_000)
        await e.sweep()
        assert e.said("recovered")[0] == "✅ monitoring recovered after 2h42m"

    async def test_starts_a_new_outage_cleanly_rather_than_reporting_the_last_ones_age(self) -> None:
        # the stamps are cleared on recovery, so a second outage an hour later does not claim to have
        # been broken since the first one
        e = Engine()
        e.failing = True
        limit = e.settings.degraded_after_failures
        started = e.now

        for _ in range(limit):
            await e.sweep()
        e.failing = False
        await e.sweep()

        e.failing = True
        e.now = after(started, 3_600_000)
        for _ in range(limit):
            await e.sweep()
        e.now = after(started, 3_600_000 + 1_801_000)
        await e.sweep()
        reminders = e.said("still degraded")
        assert len(reminders) == 1
        # 30m into the SECOND outage, not 1h30m since the first
        assert "over 30m" in reminders[0]

    async def test_notices_a_provider_that_keeps_dropping_and_recovering_which_the_run_cannot(self) -> None:
        # The outage of 2026-11-08 that the service missed entirely: a launchd agent was killing OpenD
        # 27s after every start and restarting it a minute later, so the sweep failed roughly a third
        # of the time for an hour. Every success reset the consecutive counter below its threshold, so
        # "monitoring degraded" never fired — while a five-minute total outage would have fired in the
        # first minute. The owner found it by looking at the dashboard.
        e = Engine()
        started = e.now

        # fail, succeed, fail, succeed… five failures inside the window, never two in a row
        for i in range(10):
            e.now = after(started, i * 90_000)
            e.failing = i % 2 == 0
            await e.sweep()

        # the run never reached the threshold, so the sustained notice stayed silent — correctly
        assert e.said("monitoring degraded") == []
        assert e.health.consecutive_failures() == 0
        # and the RATE spoke instead
        said = e.said("unreliable")
        assert len(said) == 1
        assert "failed sweeps in the last 15m" in said[0]

    @staticmethod
    def flapping_bouts(**over: object):
        """A bout of flapping: `sweeps` sweeps 90s apart from `start` seconds after `started`, every
        other one failing — five failures inside the 15m window by the ninth sweep, never two in a
        row. Answers how many times the owner has been called unreliable so far, and the engine."""
        e = Engine(**over)
        started = e.now

        async def bout(start: int, sweeps: int) -> int:
            for i in range(sweeps):
                e.now = started + timedelta(seconds=start + i * 90)
                e.failing = i % 2 == 0
                await e.sweep()
            return len(e.said("unreliable"))

        return bout, e

    async def test_says_a_provider_is_unreliable_again_on_flapping_repeat_seconds_from_the_last_notice(self) -> None:
        # first said at the fifth failure, 720s in; the failures after it are 180s apart, so the first
        # one 600s on is at 1440s — and at the default 1800 nothing more is said in 1710s
        bout, e = self.flapping_bouts(flapping_repeat_seconds=600)
        assert await bout(0, 20) == 2
        assert e.said("monitoring degraded") == [], "never five in a row"

    async def test_with_flapping_repeat_seconds_0_says_it_once_and_not_for_a_later_bout_either(self) -> None:
        # Nothing marks the end of a bout — a success is what flapping looks like — so nothing clears
        # the stamp, and 0 means one notice until the service restarts. At the default the second
        # bout, an hour on, is announced as the first was.
        once, _ = self.flapping_bouts(flapping_repeat_seconds=0)
        assert await once(0, 20) == 1
        assert await once(3600, 10) == 1, "an hour later, flapping again"

    async def test_announces_a_later_bout_at_the_default_interval_as_it_did_before_there_was_a_knob(self) -> None:
        bout, _ = self.flapping_bouts()
        assert await bout(0, 20) == 1
        assert await bout(3600, 10) == 2

    async def test_does_not_call_a_single_blip_unreliable(self) -> None:
        e = Engine()
        e.failing = True
        await e.sweep()
        e.failing = False
        await e.sweep()
        assert e.said("unreliable") == []

    async def test_says_one_thing_or_the_other_about_a_sustained_outage_never_both(self) -> None:
        # a long enough outage trips the run AND fills the window, and two notices about one
        # unavailable provider is the noise that teaches someone to stop reading the channel
        e = Engine()
        e.failing = True
        started = e.now
        for i in range(10):
            e.now = after(started, i * 30_000)
            await e.sweep()
        assert len(e.said("monitoring degraded")) == 1
        assert e.said("unreliable") == []

    async def test_does_not_announce_a_recovery_it_was_never_degraded_from(self) -> None:
        e = Engine()
        e.failing = True
        await e.sweep()  # one failure, well short of the threshold
        e.failing = False
        await e.sweep()
        assert e.said("recovered") == []

    async def test_labels_its_own_health(self) -> None:
        h = Engine().health
        assert h.alarm_state() == AlarmState(label="starting", bad=False)
        h.sweep_ok = True
        assert h.alarm_state() == AlarmState(label="active", bad=False)
        h.sweep_ok = False
        h.consecutive_failures_count = 1
        assert h.alarm_state() == AlarmState(label="STALLED (1 failed sweep)", bad=True)
        h.consecutive_failures_count = 3
        assert h.alarm_state() == AlarmState(label="STALLED (3 failed sweeps)", bad=True)


class TestASweepThatNeverCameBack:
    """The failure mode of 2026-10-16: not a sweep that failed, but a sweep that never came back.

    Every field /health reads was green throughout — `sweep_at` is stamped when a sweep BEGINS, the
    failure counters only move when a fetch returns, and `opend` was a TCP probe answered by a gateway
    that would not log in. Three fields, no new information between them, and eight minutes of a dead
    alarm engine reported as "active".
    """

    INTERVAL = settings_for(**SWEEP_SETTINGS).monitor_interval_seconds

    def stale(self, e: Engine) -> datetime:
        return e.now - timedelta(milliseconds=self.INTERVAL * STALE_AFTER_SWEEPS * 1000 + 1000)

    def test_calls_itself_stalled_when_no_sweep_has_begun_for_several_intervals(self) -> None:
        e = Engine()
        e.health.sweep_ok = True  # the last one that finished was fine
        e.health.sweep_at = self.stale(e)
        assert e.health.last_sweep_ok() is False
        state = e.health.alarm_state()
        assert state.bad is True
        assert re.search(r"no sweep for \d+s", state.label)

    def test_is_not_stalled_merely_because_one_sweep_is_in_flight(self) -> None:
        # a sweep takes real time and may straddle a tick; that is overrun, not death
        e = Engine()
        e.health.sweep_ok = True
        e.health.sweep_at = e.now - timedelta(seconds=self.INTERVAL)
        assert e.health.last_sweep_ok() is True
        assert e.health.alarm_state() == AlarmState(label="active", bad=False)

    def test_calls_a_first_sweep_that_never_came_back_stalled_not_starting(self) -> None:
        # the two halves of /health must not contradict each other. With the "starting" branch above
        # the staleness check, a service whose very first sweep hangs reads `alarms: "starting", bad:
        # false` for ever while `last_sweep_ok` is already false — which is the 2026-10-16 failure
        # mode wearing a reassuring label. The case below sets `sweep_ok` first and so cannot see the
        # ordering at all (mutation sweep, 2026-11-09).
        e = Engine()
        e.health.sweep_at = self.stale(e)
        assert e.health.sweep_ok is None  # it has not come back even once
        assert e.health.last_sweep_ok() is False
        state = e.health.alarm_state()
        assert state.bad is True
        assert re.search(r"no sweep for \d+s", state.label)

    def test_is_starting_not_stalled_before_the_first_sweep(self) -> None:
        # launchd restarts after every merge, and a service that has not swept yet must not cry stall
        e = Engine()
        assert e.health.last_sweep_ok() is True
        assert e.health.alarm_state() == AlarmState(label="starting", bad=False)

    async def test_counts_an_abandoned_sweep_as_a_failure_and_says_so_at_the_threshold(self) -> None:
        # what the scheduler's watchdog calls. Without this a stall is cleared by the next tick and
        # leaves no trace at all.
        e = Engine()
        limit = e.settings.degraded_after_failures
        for _ in range(limit):
            await e.health.record_stall(90)
        assert e.health.consecutive_failures() == limit
        assert e.health.last_sweep_ok() is False
        assert len(e.said("degraded")) == 1
        assert "90" in "\n".join(e.sent)

    async def test_reports_what_the_last_fetch_did_which_is_not_what_a_port_probe_can_tell_you(self) -> None:
        e = Engine()
        e.failing = True
        assert e.health.last_fetch_ok() is None  # nothing asked yet, nothing to claim
        await e.sweep()
        assert e.health.last_fetch_ok() is False
        e.failing = False
        await e.sweep()
        assert e.health.last_fetch_ok() is True

    async def test_re_stamps_the_freshness_of_every_batch_which_is_the_only_thing_it_is_read_for(self) -> None:
        # `fetched_at` is freshness (CLAUDE.md), and a freshness stamp written once and then kept is
        # worse than no stamp at all: /health goes on reporting the first batch's instant while the
        # market moves. Every other case here sweeps exactly once before reading it, so keeping the
        # first stamp passed the lot (mutation sweep, 2026-11-09).
        e = Engine(monitor_interval_seconds=CADENCE)
        await e.sweep()
        first = e.health.last_fetch_at()
        assert first == e.now

        await e.tick()
        assert e.health.last_fetch_at() == e.now
        assert e.health.last_fetch_at() > first

    async def test_re_stamps_when_each_sweep_began_which_is_what_staleness_is_measured_from(self) -> None:
        # The sibling hole, found by the same sweep: every case about staleness above sets `sweep_at`
        # by hand to state an age, so keeping the first stamp passed all of them — and the service it
        # describes is one whose `last_sweep_at` freezes at the first sweep of the process and then
        # reports itself STALLED for ever while sweeping every 15 seconds.
        e = Engine(monitor_interval_seconds=CADENCE)
        await e.sweep()
        first = e.health.last_sweep_at()
        assert first == e.now

        await e.sweep_for(CADENCE * STALE_AFTER_SWEEPS * 2)
        assert e.health.last_sweep_at() == e.now
        assert e.health.last_sweep_at() > first
        # and the engine therefore still calls itself active, which is the half /health reports
        assert e.health.alarm_state() == AlarmState(label="active", bad=False)


class TestWhatTheSweepReadsBack:
    """The sweep suite's other cases that read the account after a sweep, held at the account."""

    async def test_keeps_its_account_when_the_sender_throws(self) -> None:
        # "survives a sender that throws": a broken notifier must not stop the engine recording what
        # it saw — here through the account's own notices, the recovery among them, whose send comes
        # AFTER the counters are cleared
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

    async def test_calls_a_sweep_with_nothing_to_fetch_a_success(self) -> None:
        # everything expiring on one Friday is this sweep: it begins and succeeds with no batch at all,
        # and without the success an empty watchlist leaves /health reading "starting" for ever
        e = Engine()
        e.health.started_sweep(e.now)
        await e.health.success()
        assert e.health.last_sweep_ok() is True
        assert e.health.alarm_state() == AlarmState(label="active", bad=False)

    async def test_is_not_a_success_when_the_work_after_the_batch_fails(self) -> None:
        # the batch came back and the sweep still failed: two different questions, two answers
        e = Engine()
        e.health.started_sweep(e.now)
        e.health.fetched(True, e.now)
        await e.health.failure("the sweep threw: refused")
        assert e.health.last_sweep_ok() is False
        assert e.health.consecutive_failures() == 1
        assert e.health.last_fetch_ok() is True


class TestWhatNoCallerReads:
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
