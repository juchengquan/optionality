"""The sweep loop, on a plain interval. What drives the alarm engine. Port of
backend/src/engine/scheduler.ts.

This held the cron schedule too: schedules armed from the database and fired into the worker. That
half went with the run pipeline in phase 10 (ADR 0014). This half must NOT go — `__main__` calls
`start_sweep` with the sweeper, so deleting the scheduler would stop the alarms.

**Where the Python differs, and why.**

- **The interval is a timer re-armed at the start of each tick** (`loop.call_later`), which is when
  Node's `setInterval` re-arms, and stopping cancels the timer as `clearInterval` does.
- **The first sweep starts EAGERLY.** JavaScript runs an async function to its first `await` the
  moment it is called, so the TypeScript's `startSweep` returns with the first sweep already begun
  and its instant stamped. An asyncio task waits for the next turn of the loop, so each sweep's task
  is started with `eager_start=True`, which restores JavaScript's order.
- **A sweep's age is read off the loop's clock** (`loop.time()`, monotonic), where the TypeScript
  reads `Date.now()`. The ticks are the loop's timers, so the deadline then reads the same clock as
  the ticks it is measured in, and a test can move both at once (`tests/engine/conftest.py`).
- **Every sweep is held until it settles.** The loop holds a task only weakly, so a sweep waiting on
  something only it references would be collected mid-flight — its coroutine closed under it, and
  "Task was destroyed but it is pending!" — where a JavaScript promise is simply kept or forgotten.
  A sweep the watchdog abandons is DISOWNED, not cancelled, as in the TypeScript: Python could
  cancel it, but then the two backends would do different things to a hung sweep.
- **A failed sweep is caught as `Exception`**, never wider: `asyncio.CancelledError` is the process
  stopping, which ends the sweep rather than counting as one that failed.
- **`SweepWatchdog` is a frozen dataclass** that `__main__` builds by name, from the engine's door:
  the TypeScript passes an object literal that the compiler checks by its shape. An exception raised
  by its `on_stall` reaches the loop's exception handler, which logs it, and the loop goes on —
  Node re-arms the interval too, and then dies of the uncaught exception.
"""

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class SweepWatchdog:
    """What to do about a sweep that has not come back.

    REQUIRED, not optional. Abandoning a sweep is a judgement only the caller can make — it knows
    what a sweep costs and what a missed one costs — but on 2026-10-16 the absence of any such
    judgement was what let the alarm engine die quietly, and an absent argument is the one thing a
    call can refuse. `__main__` sets the deadline from the sweep interval and counts the stall as a
    failed sweep, which is what makes it visible on /health and, at the threshold, on Telegram.
    """

    #: how long a single sweep may be unfinished before the loop stops waiting for it
    stall_after_seconds: float
    #: told the abandoned sweep's age in seconds, for the record it leaves
    on_stall: Callable[[float], None]


class Scheduler:
    def __init__(self) -> None:
        self._sweep_timer: asyncio.TimerHandle | None = None
        #: every sweep started and not yet settled, abandoned ones included (see the docstring)
        self._sweeps: set[asyncio.Task[None]] = set()

    def start_sweep(self, every_seconds: float, sweep: Callable[[], Awaitable[None]], watchdog: SweepWatchdog) -> None:
        """The sweep, on a plain interval. Called on the running loop.

        An interval rather than a cron expression, because an interval is what this is: a cron
        pattern cannot express it anyway — the seconds field tops out at 60, so a step of 60 in that
        position is a syntax error — and 60 is the real setting.

        Fires immediately as well as on the interval. Without that every restart left the alarm engine
        quiet and the dashboard's cache empty for a whole MONITOR_INTERVAL_SECONDS — and restarts
        happen after every merge.
        """
        self.stop_sweep()
        loop = asyncio.get_running_loop()
        running = False
        started_at = 0.0
        # which sweep the flag belongs to. Bumped when one is abandoned, so the abandoned sweep, when
        # it settles, can tell that the flag it would clear is no longer its own.
        generation = 0

        async def settle(pending: Awaitable[None], mine: int) -> None:
            nonlocal running
            # a broken sweep must never kill the loop — the next minute may work
            try:
                await pending
            except Exception:
                log.exception("monitor sweep failed")
            finally:
                if mine == generation:
                    running = False

        def run() -> None:
            nonlocal running, started_at, generation
            # coalesce: a sweep that overruns its interval must not have a second one started on top
            # of it
            if running:
                age = loop.time() - started_at
                if age < watchdog.stall_after_seconds:
                    return
                # Give up on it. Coalescing forever is indistinguishable from a stopped engine, and the
                # sweep is not cancelled — only disowned.
                generation += 1
                watchdog.on_stall(age)
            running = True
            started_at = loop.time()
            mine = generation
            task = asyncio.Task(settle(sweep(), mine), loop=loop, eager_start=True)
            if not task.done():
                self._sweeps.add(task)
                task.add_done_callback(self._sweeps.discard)

        def tick() -> None:
            self._sweep_timer = loop.call_later(every_seconds, tick)
            run()

        self._sweep_timer = loop.call_later(every_seconds, tick)
        run()

    def stop_sweep(self) -> None:
        if self._sweep_timer is not None:
            self._sweep_timer.cancel()
        self._sweep_timer = None
