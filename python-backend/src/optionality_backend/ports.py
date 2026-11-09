"""What the HTTP layer needs from the rest of the service, named as interfaces (ADR 0009, phase 5).
Port of backend/src/ports.ts.

The routes reach the alarm engine and the vendors through these signatures rather than importing
them, so a test fakes them instead — which is what keeps the rule the harness exists for: a test must
never reach the real moomoo SDK, because it blocks indefinitely on a dead port and a missing fake
looks like a hung suite (CLAUDE.md).

**Where the Python differs, and why.** A TypeScript interface is a `Protocol` here, checked by
structure as the compiler checks an interface, and `runtime_checkable` because Python has no
compiler in the gate: a test can then ask whether a fake answers one. That checks the members exist,
not their signatures.

`QuoteFetcher` is defined HERE, where the TypeScript imports it from the library. The library's
`optionality.quotes.QuoteFetcher` is SYNCHRONOUS — a notebook has no event loop — while the service
runs on one asyncio loop (ADR 0021, Decision 6), so a fetch must be awaitable: a blocking SDK call
inside it runs in a worker thread with a timeout, and every other call is a coroutine already. Same
name, same shape, `async`. Import it from here in the backend, never from `optionality.quotes`.
"""

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Protocol, runtime_checkable

from optionality.quote import Batch

#: One bounded batch call to a Provider (the library's `quotes.ts`), awaited.
type QuoteFetcher = Callable[[list[str]], Awaitable[Batch]]


@dataclass(frozen=True)
class AlarmState:
    """The human label the status strip shows, and whether it is bad. An anonymous object type in
    the TypeScript (`{ label: string; bad: boolean }`), named here because Python has no other way to
    say what a method returns."""

    label: str
    bad: bool


@runtime_checkable
class SweeperPort(Protocol):
    """The alarm engine's account of its own health, as /health reports it.

    `SweepHealth` in `engine/health.py` is the implementation, and this is its whole surface — which
    is what made splitting it out of `MonitorSweeper` free: the seam had been drawn here since phase
    5 and the engine had simply grown through it. `main` hands the routes and the bot that object
    rather than the sweeper, so nothing reachable from a request can start a sweep.
    """

    def last_sweep_at(self) -> datetime | None: ...

    def last_sweep_ok(self) -> bool: ...

    def consecutive_failures(self) -> int: ...

    def alarm_state(self) -> AlarmState:
        """Derived here rather than client-side so the engine gives its own account."""
        ...

    def last_fetch_at(self) -> datetime | None: ...

    def last_fetch_ok(self) -> bool | None:
        """What the last batch did, or None before one was asked for. /health reports this instead of
        a port probe: a socket that accepts is not a gateway that answers."""
        ...


@runtime_checkable
class VendorClient(Protocol):
    """An open vendor: one market-data vendor this build can reach (ADR 0015, widened by 0019).

    Every vendor answers this much, whether it is the Provider or only serves a Reference — the
    vendor door opens them all the same way, and one shutdown loop hangs them all up. What a
    Reference-only vendor does NOT have to answer is `reachable`: that question is asked of the
    Provider alone (see below), and a vendor with no gateway to probe would have to invent one.
    """

    @property
    def name(self) -> str:
        """What this vendor is called, as a Reference's `source` names it and `/health` prints it."""
        ...

    @property
    def fetch_quotes(self) -> QuoteFetcher:
        """The one question every vendor answers (the library's `quotes`)."""
        ...

    def close(self) -> None:
        """Hang up, so the next call reconnects. Called on the way out of the process."""
        ...


@runtime_checkable
class ProviderClient(VendorClient, Protocol):
    """The Provider: the one vendor the alarms read from, chosen before boot (ADR 0015).

    The vendor door builds whichever one `.env` names. `name` and `reachable` exist for `/health`,
    which until ADR 0015 reported `opend: true` — the vendor's name on the API contract, and a
    sentence on the dashboard that would have been a lie the moment anything else was behind it.
    """

    async def reachable(self) -> bool:
        """Whether the gateway is there AT ALL, in whatever terms this Provider has — a TCP connect for
        moomoo's OpenD, a handshake for IB Gateway's socket.

        Consulted only while nothing has been fetched yet: an answered request outranks a probe, and a
        socket that accepts is not a gateway that answers (ADR 0010, and 2026-10-16, when OpenD held
        the port open and timed out every login)."""
        ...
