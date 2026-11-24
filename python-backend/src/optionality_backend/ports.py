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

`verify_contracts`, the creation probe, is here for the same reason: the TypeScript imports it from its
library's `quotes.ts`, and the Python library's takes the synchronous fetcher. It is the library's two
cased verdicts, `unverifiable_verdict` and `verify_verdict`, around one awaited fetch.
"""

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal, Protocol, runtime_checkable

from optionality.quote import Batch, unverifiable_verdict, verify_verdict

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
class AccountWatch(Protocol):
    """A watch the library keeps on the account (ADR 0031): what the service holds while `GET /account`
    is asked. The library's `IbkrAccountWatch` is one; stated here by what the service uses of it, so
    this vocabulary names no client.

    **Where the Python differs, and why.** `picture()` is a mapping — the library's `IbkrLiveAccount`,
    which only the IB vendor's descriptor may import (`tests/test_seams.py`) — where the TypeScript names
    the type through the library's fields door, which the Python has no counterpart of. `lost` is the
    exception the connection closed with."""

    def picture(self) -> Mapping[str, Any]:
        """The latest picture, a copy the caller may keep: `{account, paper, base_currency, updated_at,
        totals, exchange_rates, holdings, pnl, pnl_at}`, each holding with its `daily_pnl`."""
        ...

    @property
    def lost(self) -> BaseException | None:
        """Set, once, when the connection closes under the watch; the picture stays the last one."""
        ...

    def on_lost(self, listener: Callable[[BaseException], None]) -> None: ...

    async def stop(self) -> None:
        """The cancels, then the unsubscribe; idempotent; returns when sent."""
        ...


@dataclass(frozen=True)
class AccountWatched:
    """The watch, its first complete picture in, its id already masked (ADR 0031, #477)."""

    watch: AccountWatch


@dataclass(frozen=True)
class AccountUnreachable:
    """No session with IB Gateway at all (the library's `IbkrUnreachable`), in the connect's own words —
    a refused connection, a handshake that never finished, or a session the gateway refused ("IB Gateway
    refused the session: 326 …", a client id already in use)."""

    words: str


@dataclass(frozen=True)
class AccountRefused:
    """The library would not choose an account (`IbkrAccountRefused`) — several on the login and
    `IBKR_ACCOUNT` unset, or naming none of them — in its words, every id masked."""

    words: str


@dataclass(frozen=True)
class AccountFailed:
    """Connected, and the first picture did not come: its deadline passed, or the connection closed
    before it, in the library's words."""

    words: str


#: What starting a watch on the IBKR account came to (ADR 0031, #477), sorted by what the owner must do
#: about it — which is what tells the route its status.
#:
#: **Where the Python differs, and why.** The TypeScript's union of object shapes (`{ watch }`,
#: `{ unreachable }`, ...) is a union of four small classes here, told apart by `isinstance`.
type AccountWatching = AccountWatched | AccountUnreachable | AccountRefused | AccountFailed


@runtime_checkable
class AccountSource(Protocol):
    """IB Gateway's account, as the service may hold it (ADR 0031, #477). Only IB Gateway's client has
    one (`VendorClient.account` in the TypeScript, an optional member; `IbkrProvider.account_source`
    here, since the library's client already has a method named `account`)."""

    async def watch(self, wanted: str | None) -> AccountWatching:
        """Start a watch on the account `wanted` names in full, or the login's only one where it is None,
        returning once its first picture is complete. Never raises: every way it can end is an
        `AccountWatching`."""
        ...

    def on_answered(self, listener: Callable[[], None]) -> None:
        """Call `listener` each time the client answers anything else — a price read that worked. While a
        watch is lost, that is the connection back, and the hold's chance to watch again."""
        ...


@dataclass(frozen=True)
class GradeRead:
    """A grade a Provider read: moomoo's own name for it as the SDK gives it (`LV1`, `BMP`, `N/A`, ...),
    whether that means real-time (the library's `is_realtime`; None for Unknow), and when it was read.
    An anonymous object type in the TypeScript (`QuoteGradeReading["read"]`), named here."""

    us_option: str
    realtime: bool | None
    at: datetime


@dataclass(frozen=True)
class QuoteGradeReading:
    """What a Provider last read of the account's quote grade for US options (#464): whether the option
    prices it serves are real-time. moomoo grades the ACCOUNT, by level, and never a quote; its client
    reads it once per connection episode (and a failed read again at most every 30 minutes) and keeps
    it, so asking for this asks OpenD nothing — `/health` reads it, and must never cause a read."""

    #: the last grade read, or None while no read has answered
    read: GradeRead | None
    #: OpenD's words for why the latest read failed, or None. A failure leaves `read` as it was.
    failure: str | None


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

    def quote_grade(self) -> QuoteGradeReading | None:
        """The account's quote grade as last read, or None for a Provider that reports none — IB Gateway
        grades each request rather than the account, and that is not this (#464)."""
        ...


async def verify_contracts(codes: list[str], fetch: QuoteFetcher) -> str | None:
    """An error message unless every code is a verified, existing contract. The library's
    `quotes.verifyContracts`, awaited.

    Strict on purpose: creation is gated by a live probe, and it rejects while the Provider is down
    (CLAUDE.md). A monitor created against a contract that does not exist would quarantine itself on the
    first sweep, which is a worse way to find out.

    Both verdicts are the library's and cased: a raise and an answer are two different refusals, and the
    raised one used to claim an outage about a Provider that had answered perfectly well and declined the
    security (ADR 0018).
    """
    try:
        batch = await fetch(codes)
    except Exception as err:  # noqa: BLE001 — refused on ANY failure, with what went wrong: strictness
        return unverifiable_verdict(str(err))
    # everything but the fetch and the catch is `optionality.quote.verify_verdict`, which is cased
    return verify_verdict(codes, batch)


#: A GET of the app's own (ADR 0026): the path, and the caller's Authorization header, passed on so the
#: one token governs both — answering the status and the body. `app.py` builds it and hands it to the MCP
#: door, its whole reach. The method is not a parameter, which is what makes that door read-only by
#: construction. Here because two surfaces speak it and neither may import the other.
type Read = Callable[[str, str | None], Awaitable[tuple[int, str]]]

#: A write of the app's own (ADR 0028): the method, the path, the JSON body, and the caller's Authorization
#: header passed on as `Read` passes it — answering the status and the body. `app.py` builds it as it builds
#: `Read`, and hands both to the MCP door, whose `allowed_write` (`writes.py`) lets through only the method
#: and path pairs `schema/mcp/server.json` lists for a write tool.
type Write = Callable[[str, str, Any, str | None], Awaitable[tuple[int, str]]]

#: Telling the owner, as a surface is handed it: `notify.py`'s `delivery`, which says whether the message was
#: sent, not sent because Telegram is not configured, or refused — and never raises. Here because the MCP
#: door may import nothing that runs.
type Notify = Callable[[str], Awaitable[Literal["sent", "unconfigured", "failed"]]]
