"""The engine's tests run on a loop whose clock is VIRTUAL: time passes only when nothing is ready.

The TypeScript's `scheduler.test.ts` runs on real timers at a 50ms interval — "the point is the
clock, not a mock of it" — and spends about two seconds sleeping to prove what it proves. Here the
same tests, with the same intervals and deadlines, run on `VirtualTimeLoop`: a real asyncio loop,
every callback and task scheduled as asyncio schedules them, whose clock jumps to the next timer
whenever the loop would otherwise sit in `select` waiting for it. So the order of events is the
real loop's and only the waiting is skipped — which is what vitest's fake timers would buy, without
replacing a single function the scheduler calls. It can do that because in asyncio, unlike Node,
the clock is the LOOP's: `loop.time()`, `call_later`, `asyncio.sleep` and `asyncio.timeout` all read
it, and the scheduler measures a sweep's age with it too.

Every async test under `tests/engine/` runs on it, through pytest-asyncio's
`pytest_asyncio_loop_factories` hook. Nothing else here sleeps — the health account takes its `now`
injected, as the TypeScript's does — so for those tests it changes nothing, and an accidental real
sleep cannot hide in them.

It also says what a plain loop only logs. An exception raised in a timer's callback, or a task that
fails or is destroyed unfinished with nobody to tell, reaches `call_exception_handler`, which a real
loop prints and carries on from. Here it is kept and RAISED when the loop closes, so the test it
happened in errors. That is the Python for a thing the TypeScript gets from Node: its suite's
`patient` watchdog throws on a stall nobody expected so that the case "says so instead of passing
quietly", and an exception thrown in a Node timer is fatal.
"""

import asyncio
import selectors
from collections.abc import Callable
from typing import Any

import pytest


class _Clock:
    """The loop's time, shared with the selector that moves it."""

    def __init__(self) -> None:
        self.now = 0.0


class _Selector(selectors.DefaultSelector):
    """`select`, except that waiting for a timer advances the clock instead of the wall.

    A real select runs first with no timeout, so a real file descriptor that is ready — the loop's
    own self-pipe — is still served. Only when nothing is ready and a timer is due does the clock
    jump, by exactly the wait the loop asked for. With no timer at all (`timeout` None) it blocks as
    a real loop would, because there is no time to skip to.
    """

    def __init__(self, clock: _Clock) -> None:
        super().__init__()
        self._clock = clock

    def select(self, timeout: float | None = None) -> list[tuple[selectors.SelectorKey, int]]:
        ready = super().select(0)
        if ready or timeout == 0:
            return ready
        if timeout is None:
            return super().select(None)
        self._clock.now += timeout
        return []


class VirtualTimeLoop(asyncio.SelectorEventLoop):
    def __init__(self) -> None:
        self._clock = _Clock()
        super().__init__(_Selector(self._clock))
        #: what reached the exception handler, raised at close
        self.unhandled: list[dict[str, Any]] = []

    def time(self) -> float:
        return self._clock.now

    def call_exception_handler(self, context: dict[str, Any]) -> None:
        self.unhandled.append(context)
        super().call_exception_handler(context)

    def close(self) -> None:
        super().close()
        if self.unhandled:
            said = [str(c.get("exception") or c.get("message")) for c in self.unhandled]
            self.unhandled = []
            raise AssertionError("the loop was handed what nobody handled: " + "; ".join(said))


def pytest_asyncio_loop_factories(
    config: pytest.Config, item: pytest.Item
) -> dict[str, Callable[[], asyncio.AbstractEventLoop]]:
    """Every async test under `tests/engine/` runs on virtual time (the docstring above says why)."""
    return {"virtual time": VirtualTimeLoop}
