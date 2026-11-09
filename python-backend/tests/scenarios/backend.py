"""THE SEAM: where the runner meets the Python backend (ADR 0021, phase 2; filled from phase 3).

The TypeScript replayer builds its service on a world in three places in `doors.ts`: the sweeper
in `open`, the HTTP app in `runHttp` (`createApp(deps).request`) and the bot in `runBot`. The
Python runner asks for all three at once, through `build`: the backend constructed on an open
world, with only the vendors, Telegram, the clock and the id minter faked — the real routes, the
real bot, the real engine. Nothing is ported, so `build` raises `NotPorted`, and every scenario
sits on the backlog.

**What phase 3 does here, and nothing else.** The tracer bullet serves `GET /positions`: `build`
then constructs the backend's deps from the world (`world.db`, `world.env`, `lambda:
world.clock.now`, `world.new_id`, `world.provider`, `world.sources`) and returns a `Service` whose
`request` goes through FastAPI's `TestClient` and comes back as a `Response`. The doors it does
not have yet keep raising `NotPorted` from their own method — `sweep` until the engine lands in
phase 4, `handle_update` until the bot does — so a scenario needing one stays on the backlog and
its skip says which. A world with earlier sweeps needs `sweep` before its event can even start.

**An unported door RAISES; it never does nothing.** Two scenarios expect nothing at all to happen —
`bot/a-message-from-any-other-chat-gets-no-reply.json` and
`sweep/an-empty-book-is-swept-without-asking-the-provider-anything.json` — and a backend whose
methods are empty passes both. Measured, by plugging one in here: the backlog's rule then failed
them with "take it off the backlog", which is the rule working and the stub lying.

Synchronous on purpose, as `TestClient` is: if the backend's loop is asyncio (ADR 0021,
Decision 6), driving it to completion is `build`'s business, so the runner never grows an event
loop of its own to keep in step with the backend's.
"""

from dataclasses import dataclass
from typing import Any, Protocol

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


def build(world: OpenWorld) -> Service:
    """The Python backend on `world`. Raises `NotPorted` until phase 3 (see the module's doc)."""
    raise NotPorted(
        "the Python backend cannot be built on a world yet: nothing is ported (ADR 0021; phase 3 is GET /positions)"
    )
