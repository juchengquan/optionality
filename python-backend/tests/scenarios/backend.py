"""THE SEAM: where the runner meets the Python backend (ADR 0021, phase 2; filled from phase 3).

The TypeScript replayer builds its service on a world in three places in `doors.ts`: the sweeper
in `open`, the HTTP app in `runHttp` (`createApp(deps).request`) and the bot in `runBot`. The
Python runner asks for all three at once, through `build`: the backend constructed on an open
world, with only the vendors, Telegram, the clock and the id minter faked — the real routes, the
real bot, the real engine.

**What is built so far** (phase 3, the tracer): the HTTP door. `build` reads Settings from the
world's `.env` lines with the backend's own `env.settings_from_env`, as `world.ts` does, and builds
`create_app` on `world.db` with the world's clock, id minter, Provider and sources. The doors it does
not have yet raise `NotPorted` from their own method — `sweep` until the engine lands in phase 4 and
`handle_update` until the bot does — so a scenario needing one stays on the backlog and its skip says
which. A world with earlier sweeps needs `sweep` before its event can even start. The sweeper's
account of itself, which `/health` will read, raises too; inside a request the app answers that as
its 500, so such a skip shows the difference rather than naming the engine.

**An unported door RAISES; it never does nothing.** Two scenarios expect nothing at all to happen —
`bot/a-message-from-any-other-chat-gets-no-reply.json` and
`sweep/an-empty-book-is-swept-without-asking-the-provider-anything.json` — and a backend whose
methods are empty passes both. Measured, by plugging one in here: the backlog's rule then failed
them with "take it off the backlog", which is the rule working and the stub lying.

**One loop, the caller's thread.** The service runs on ONE asyncio loop (ADR 0021, Decision 6), and
its database connection refuses any thread but the one that opened it — `world.db`, opened in the
runner's. So a `Service` owns an `asyncio.Runner` for its whole life, in the caller's thread, and
every door runs on it: a request goes through `httpx2.ASGITransport` there, and the sweep and the
bot will join it. FastAPI's `TestClient` cannot be used: it runs the app on a loop in a thread of its
own, where the first query fails with sqlite3's "objects created in a thread can only be used in that
same thread" (measured). The runner itself stays synchronous, so it never grows an event loop of its
own to keep in step with the backend's; `close` ends the loop, and `doors.opened` calls it.
"""

import asyncio
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Protocol

import httpx2
from optionality.quote import Batch
from optionality.quotes import QuoteFetcher as LibraryFetcher

from optionality_backend.entrypoints.http import Deps, create_app
from optionality_backend.env import settings_from_env
from optionality_backend.ports import AlarmState, QuoteFetcher

from .world import OpenWorld


class NotPorted(Exception):
    """A door, or a part of the service behind one, that the Python backend does not have yet."""


@dataclass(frozen=True)
class Response:
    """What the HTTP door answered: its status, its Content-Type ("" when it sent none) and its body
    as text. The runner parses it, as `runHttp` does, so every backend is read the same way."""

    status: int
    content_type: str
    text: str


class Service(Protocol):
    """The Python backend, built on an open world."""

    def sweep(self) -> None:
        """One tick of the sweep at `world.clock.now`, its Provider failing while `world.outage`
        says so, delivering through `world.send`."""

    def request(self, method: str, path: str, headers: dict[str, str], body: str | None) -> Response:
        """One request through the HTTP door. `body` is JSON text, and `headers` already carries
        `Content-Type: application/json` when there is one; None is no body at all."""

    def handle_update(self, update: dict[str, Any]) -> None:
        """One Telegram update through the bot's update handler — not the long poll — answering
        through `world.api`."""

    def close(self) -> None:
        """Let go of whatever the backend holds — its loop — before the world is removed."""


def _awaited(fetch: LibraryFetcher) -> QuoteFetcher:
    """A world's vendor, which answers at once, as the awaitable port the backend calls."""

    async def fetch_quotes(codes: list[str]) -> Batch:
        return fetch(codes)

    return fetch_quotes


@dataclass(frozen=True)
class _Provider:
    """The world's Provider as the backend's `ProviderClient`."""

    name: str
    fetch_quotes: QuoteFetcher
    #: the world's own probe, asked each time: `/health` reads it only before any batch has been
    answers: Callable[[], bool]

    async def reachable(self) -> bool:
        return bool(self.answers())

    def close(self) -> None:
        """Nothing to hang up."""


class _NoEngine:
    """The sweeper's account of itself, which `/health` reads and the engine owns. Not ported: every
    question raises, so a scenario that reaches it says why it cannot pass rather than passing on an
    invented answer."""

    def _unported(self) -> Any:
        raise NotPorted("the alarm engine is not ported yet (ADR 0021, phase 4)")

    def last_sweep_at(self) -> datetime | None:
        return self._unported()

    def last_sweep_ok(self) -> bool:
        return self._unported()

    def consecutive_failures(self) -> int:
        return self._unported()

    def alarm_state(self) -> AlarmState:
        return self._unported()

    def last_fetch_at(self) -> datetime | None:
        return self._unported()

    def last_fetch_ok(self) -> bool | None:
        return self._unported()


class _Backend:
    def __init__(self, world: OpenWorld) -> None:
        self._loop = asyncio.Runner()
        fetchers = {name: _awaited(fetch) for name, fetch in world.sources.items()}
        provider = _Provider(
            name=world.provider.name,
            # the SAME fetcher the sources hold under its name, as `openVendors` opens a vendor once
            fetch_quotes=fetchers[world.provider.name],
            answers=world.provider.reachable,
        )
        deps = Deps(
            settings=settings_from_env(world.env),
            db=world.db,
            now=lambda: world.clock.now,
            new_id=world.new_id,
            sweeper=_NoEngine(),
            provider=provider,
            sources=fetchers,
        )
        self._client = httpx2.AsyncClient(
            transport=httpx2.ASGITransport(app=create_app(deps)), base_url="http://scenario"
        )

    def sweep(self) -> None:
        raise NotPorted("the sweep is not ported yet (ADR 0021, phase 4: the engine)")

    def handle_update(self, update: dict[str, Any]) -> None:
        raise NotPorted("the bot is not ported yet (ADR 0021, phase 4)")

    def request(self, method: str, path: str, headers: dict[str, str], body: str | None) -> Response:
        answer = self._loop.run(self._client.request(method, path, headers=headers, content=body))
        return Response(answer.status_code, answer.headers.get("content-type", ""), answer.text)

    def close(self) -> None:
        try:
            self._loop.run(self._client.aclose())
        finally:
            self._loop.close()


def build(world: OpenWorld) -> Service:
    """The Python backend on `world` (see the module's doc for what it has so far)."""
    return _Backend(world)
