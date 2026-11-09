"""The sweep loop: what is left of the scheduler once the run pipeline went (phase 10).

Port of backend/src/engine/scheduler.test.ts.

The cron half — schedules armed from the database, fired into the worker — was deleted with the
worker it fed (ADR 0014). The interval half is what drives the alarm engine, which is why the
scheduler itself survives: deleting it would stop the alarms.

The TypeScript runs these on real timers; here they run on the loop's VIRTUAL clock
(`conftest.py`), with the same intervals, deadlines and waits, so a second of sleeping costs
nothing and the order of events is still the real loop's. What only the Python can get wrong is at
the end.
"""

import asyncio
import gc
import logging
import time
from collections.abc import Callable

import pytest

from optionality_backend.engine.scheduler import Scheduler, SweepWatchdog

LOG = "optionality_backend.engine.scheduler"


@pytest.fixture
def scheduler():
    s = Scheduler()
    yield s
    s.stop_sweep()


def unexpected(age: float) -> None:
    raise RuntimeError("unexpected stall")


#: A deadline no test here will reach, for the cases that are not about the watchdog. Written out at
#: each call rather than made optional: `start_sweep` requires the decision, because the absence of
#: one is exactly what nothing noticed on 2026-10-16. `on_stall` raises so that a case which stalls
#: unexpectedly says so instead of passing quietly (the loop raises what it was handed when it closes,
#: `conftest.py`).
PATIENT = SweepWatchdog(stall_after_seconds=3600, on_stall=unexpected)


def counted(age: float) -> None:
    """counted elsewhere"""


class TestTheSweepJob:
    async def test_does_not_start_a_second_sweep_on_top_of_one_that_overran(self, scheduler: Scheduler) -> None:
        # two sweeps at once would make two batched calls and write the same rows twice
        running = 0
        peak = 0

        async def sweep() -> None:
            nonlocal running, peak
            running += 1
            peak = max(peak, running)
            await asyncio.sleep(0.2)
            running -= 1

        # fractional seconds, because an interval can be one — the point is the overrun, not the clock
        scheduler.start_sweep(0.05, sweep, PATIENT)
        await asyncio.sleep(0.3)
        scheduler.stop_sweep()
        assert peak == 1

    async def test_stops_when_asked(self, scheduler: Scheduler) -> None:
        sweeps = 0

        async def sweep() -> None:
            nonlocal sweeps
            sweeps += 1

        scheduler.start_sweep(0.05, sweep, PATIENT)
        assert sweeps == 1
        scheduler.stop_sweep()
        await asyncio.sleep(0.2)
        assert sweeps == 1

    async def test_survives_a_sweep_that_throws_rather_than_stopping_the_schedule(self, scheduler: Scheduler) -> None:
        # a broken sweep must never kill the loop: the next minute may work
        sweeps = 0

        async def sweep() -> None:
            nonlocal sweeps
            sweeps += 1
            raise RuntimeError("boom")

        scheduler.start_sweep(0.05, sweep, PATIENT)
        await asyncio.sleep(0.2)
        scheduler.stop_sweep()
        assert sweeps >= 2


async def wait_until(done: Callable[[], bool], seconds: float) -> None:
    """Polled, as the TypeScript's `waitUntil` is — on the loop's clock, which here is virtual."""
    deadline = asyncio.get_running_loop().time() + seconds
    while not done() and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.01)


def hangs() -> asyncio.Future[None]:
    """A sweep that never comes back: a future nobody will ever resolve."""
    return asyncio.get_running_loop().create_future()


class TestTheSweepWatchdog:
    """Coalescing is right, and on 2026-10-16 it was also how the alarm engine died: an OpenD request
    that never answered left `running` true, so every later tick returned at the first line. For
    eight minutes nothing swept, nothing threw, and /health reported "active" throughout. The request
    now times out (the moomoo client), and this is the backstop for the next way a sweep can hang —
    a raised failure is recoverable, an unsettled awaitable is not.
    """

    async def test_abandons_a_sweep_that_has_hung_so_the_loop_resumes(self, scheduler: Scheduler) -> None:
        starts = 0

        def sweep() -> asyncio.Future[None]:
            nonlocal starts
            starts += 1
            return hangs()

        scheduler.start_sweep(0.05, sweep, SweepWatchdog(stall_after_seconds=0.3, on_stall=counted))
        await wait_until(lambda: starts >= 2, 1.5)
        scheduler.stop_sweep()
        assert starts >= 2

    async def test_says_how_long_the_abandoned_sweep_had_been_running(self, scheduler: Scheduler) -> None:
        # the age is the whole value of the notice: "a sweep has been stuck for 90s" is actionable in a
        # way that "a sweep was abandoned" is not
        ages: list[float] = []
        scheduler.start_sweep(0.05, hangs, SweepWatchdog(stall_after_seconds=0.3, on_stall=ages.append))
        await wait_until(lambda: len(ages) > 0, 1.5)
        scheduler.stop_sweep()
        assert ages[0] >= 0.3

    async def test_does_not_let_a_hung_sweep_that_finally_returns_clear_a_newer_sweeps_flag(
        self, scheduler: Scheduler
    ) -> None:
        # the abandoned sweep is still out there and will settle one day. If it clears the flag as it
        # settles, the next tick starts a sweep ON TOP of the running one — two batched calls at once,
        # which is the very thing coalescing exists to prevent.
        resolvers: list[asyncio.Future[None]] = []
        starts = 0

        def sweep() -> asyncio.Future[None]:
            nonlocal starts
            starts += 1
            resolvers.append(hangs())
            return resolvers[-1]

        scheduler.start_sweep(0.05, sweep, SweepWatchdog(stall_after_seconds=0.3, on_stall=counted))

        await wait_until(lambda: starts >= 2, 1.5)
        after_abandon = starts
        resolvers[0].set_result(None)  # the hung first sweep finally returns
        await asyncio.sleep(0.15)  # several ticks, well inside the second's deadline
        scheduler.stop_sweep()
        assert starts == after_abandon

    async def test_still_coalesces_an_overrun_whose_deadline_has_not_passed(self, scheduler: Scheduler) -> None:
        # the watchdog must not turn every overrun into an abandonment: a sweep slower than one tick is
        # normal, and two batched calls at once is what coalescing is for
        running = 0
        peak = 0

        async def sweep() -> None:
            nonlocal running, peak
            running += 1
            peak = max(peak, running)
            await asyncio.sleep(0.2)
            running -= 1

        scheduler.start_sweep(0.05, sweep, PATIENT)
        await asyncio.sleep(0.3)
        scheduler.stop_sweep()
        assert peak == 1


class TestWhatOnlyThePythonCanGetWrong:
    async def test_runs_these_tests_on_virtual_time_so_an_hour_passes_at_once(self) -> None:
        # the guard on the arrangement itself: if the loop factory stopped applying, every test above
        # would still pass — slowly, on real sleeps, proving nothing about the clock they rely on
        wall = time.monotonic()
        await asyncio.sleep(3600)
        assert time.monotonic() - wall < 1

    async def test_measures_a_sweeps_age_on_the_loops_clock(self, scheduler: Scheduler) -> None:
        # the deadline and the ticks must read ONE clock: the ticks are the loop's timers, so the age
        # is the loop's time too. A wall clock here would also be a clock the suite cannot move.
        ages: list[float] = []
        scheduler.start_sweep(60, hangs, SweepWatchdog(stall_after_seconds=240, on_stall=ages.append))
        await asyncio.sleep(60 * 4 + 1)
        scheduler.stop_sweep()
        assert ages == [240]

    async def test_has_begun_the_first_sweep_by_the_time_start_sweep_returns(self, scheduler: Scheduler) -> None:
        # JavaScript runs an async function to its first `await` the moment it is called, so the
        # TypeScript's first sweep has stamped `sweep_at` before `startSweep` returns. An asyncio task
        # waits for the next turn of the loop unless it is started eagerly.
        reached: list[str] = []

        async def sweep() -> None:
            reached.append("began")
            await asyncio.sleep(1)
            reached.append("finished")

        scheduler.start_sweep(60, sweep, PATIENT)
        assert reached == ["began"]
        scheduler.stop_sweep()

    async def test_leaves_a_sweep_in_flight_to_finish_when_stopped(self, scheduler: Scheduler) -> None:
        # stopping is clearInterval: no more ticks, and the sweep already running is not interrupted.
        # Python COULD cancel it; the TypeScript cannot, so neither does this.
        finished = False

        async def sweep() -> None:
            nonlocal finished
            await asyncio.sleep(1)
            finished = True

        scheduler.start_sweep(60, sweep, PATIENT)
        scheduler.stop_sweep()
        await asyncio.sleep(2)
        assert finished

    async def test_keeps_a_sweep_alive_that_nothing_else_holds(self, scheduler: Scheduler) -> None:
        # the loop holds a task only weakly, and a sweep waiting on a future that only the sweep
        # references is garbage: collected mid-flight, its coroutine closed under it, and the loop told
        # "Task was destroyed but it is pending!". A JavaScript promise in the same state is simply
        # kept or forgotten, with nothing run either way. So the scheduler holds every sweep it starts
        # until that sweep settles.
        closed = False

        async def sweep() -> None:
            nonlocal closed
            try:
                await asyncio.get_running_loop().create_future()
            except GeneratorExit:
                closed = True
                raise

        scheduler.start_sweep(60, sweep, PATIENT)
        await asyncio.sleep(0)
        gc.collect()
        assert not closed

    async def test_lets_a_cancelled_sweep_end_cancelled_rather_than_logging_it_as_failed(
        self, scheduler: Scheduler, caplog: pytest.LogCaptureFixture
    ) -> None:
        # the process stopping cancels every task on the loop, a sweep among them; that is not a sweep
        # that failed, and catching it would keep the task alive past its own cancellation
        cancelled = False

        async def sweep() -> None:
            nonlocal cancelled
            try:
                await asyncio.sleep(10)
            except asyncio.CancelledError:
                cancelled = True
                raise

        scheduler.start_sweep(60, sweep, PATIENT)
        scheduler.stop_sweep()
        await asyncio.sleep(0)  # under way, whenever it began
        current = asyncio.current_task()
        others = [t for t in asyncio.all_tasks() if t is not current]
        for task in others:
            task.cancel()
        with caplog.at_level(logging.ERROR, logger=LOG):
            await asyncio.gather(*others, return_exceptions=True)
        assert cancelled
        assert all(t.cancelled() for t in others)
        assert [r.getMessage() for r in caplog.records if r.name == LOG] == []

    async def test_logs_a_sweep_that_raised_with_its_stack(
        self, scheduler: Scheduler, caplog: pytest.LogCaptureFixture
    ) -> None:
        async def sweep() -> None:
            raise RuntimeError("boom")

        with caplog.at_level(logging.ERROR, logger=LOG):
            scheduler.start_sweep(60, sweep, PATIENT)
            await asyncio.sleep(0)
        scheduler.stop_sweep()
        [record] = [r for r in caplog.records if r.name == LOG]
        assert record.getMessage() == "monitor sweep failed"
        assert record.exc_info is not None and str(record.exc_info[1]) == "boom"
