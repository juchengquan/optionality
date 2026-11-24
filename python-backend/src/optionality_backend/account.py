"""The IBKR account, held while it is asked (ADR 0031, #477): the service behind `GET /account`, paired
with `routes/account.py`. Port of backend/src/account.ts.

The watch itself is the library's (`IbkrClient.watch_account`), reached through the IB vendor's
descriptor as an `AccountSource`, which has already sorted every way a start can end. What is decided
here is the rest:

- **which account**: `.env`'s `IBKR_ACCOUNT`, blank meaning unset, handed to the library as its
  `wanted` — the library chooses, and refuses where it cannot, every id masked;
- **the hold**: the first read starts the watch and waits for its first picture, every caller meanwhile
  joining that wait; every read renews the hold, which is released `ACCOUNT_HELD_FOR_MS` after the last
  — the watch stopped and nothing kept — and a read after that starts afresh. A read is answered from
  the picture in memory, asking IB Gateway nothing. Never started by the service and never read by the
  sweep, the bot or the MCP door: a request is the only thing that holds it. A start that fails holds
  nothing, and is remembered for `ACCOUNT_FAILED_FOR_MS`: no start is tried in that time, whoever asks,
  and a read is told what the last one came to;
- **a lost connection**: while held, a watch whose connection closed is a 502 in words until it is
  back. It is watched again at the next read, and whenever the client answers anything else (its
  connection back), never at the moment it is lost; a lost watch is dropped, never stopped, because its
  connection is gone and a stop now would go down the one replacing it;
- **the answer**: the picture, stocks (`STK`) and options (`OPT`) apart and everything else under
  `other` with only what the page lists of it (the owner's decision on #470); the totals' P&L from the
  account's P&L stream once it has spoken, the account updates' until then; when that stream last spoke
  (`live`), and when the service answered (`read_at`);
- **the status** each failure is: a vendor not configured 503 (the owner's decision on #473), a vendor
  down, refusing the session or lost 502, a refusal to choose an account 422.

Nothing is stored: the picture lives in the library's watch for the hold and is gone.

**Where the Python differs, and why.** Each start is an asyncio task, started eagerly as the
TypeScript's promise starts — so a start is asked for before the read that caused it goes on — and the
first is awaited through `asyncio.shield` so that one caller giving up does not cancel it under the
others. A stop is a task of its own, eager for the same reason, kept until it ends. The release's timer
is the loop's `call_later` unless a test injects one. The picture is a mapping (`ports.AccountWatch`).
`IBKR_ACCOUNT` is trimmed with `JS_WHITESPACE`, as `trim()` trims: `str.strip()` also takes the C0
separators (`\\x1c`–`\\x1f`), so a value JavaScript asks for would have read as blank here.
"""

import asyncio
import logging
from collections.abc import Callable, Coroutine, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

from optionality.timefmt import display_time

from .ports import (
    AccountFailed,
    AccountRefused,
    AccountSource,
    AccountUnreachable,
    AccountWatch,
    AccountWatched,
    AccountWatching,
)
from .schemas.zod import JS_WHITESPACE

log = logging.getLogger(__name__)

#: How long the account is held after the last read: 90 s, the owner's decision on #477 — the page's
#: slowest refresh is a minute, so every refresh keeps it.
ACCOUNT_HELD_FOR_MS = 90_000

#: How long a start that failed is remembered, from when it came back: 5 s, the owner's decision on #477
#: — while IB Gateway is down or logged out the service tries to start the watch at most once in that
#: time, whoever asks, and every read meanwhile is told what the last try came to.
ACCOUNT_FAILED_FOR_MS = 5_000

#: The words for a build with no IB Gateway (`IBKR_HOST` blank).
NOT_CONFIGURED = "IB Gateway is not configured"
#: The words for a gateway that could not be reached: down, or at its login screen, where its API port
#: is shut. The connect's own words go to the log, not to the page.
NOT_ANSWERING = "IB Gateway did not answer — is it running and logged in?"
#: How the library begins the words for a session the gateway refused (`socket.ts`, `ibkr.py`): it
#: answered, and said why — a client id already in use is the one met — so the page is told that, in
#: those words, rather than to start a gateway that is running. Held to the library's own words by the
#: TypeScript's `vendors/ibkr/vendor.test.ts`, against its `client-id-in-use` recording, and to the
#: Python library's by its own suite against the same recording.
REFUSED_SESSION = "IB Gateway refused the session:"
#: The words for a held watch whose connection closed, until it is back — and for a watch again that
#: failed, whatever its own words, which go to the log.
LOST = "The connection to IB Gateway was lost"

_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)

#: Wake `fn` in `ms`, returning how to cancel it.
type Wake = Callable[[int, Callable[[], None]], Callable[[], None]]


def _ms(when: datetime) -> int:
    """`Date.getTime`: whole milliseconds since the epoch."""
    return (when - _EPOCH) // timedelta(milliseconds=1)


def _real_wake(ms: int, fn: Callable[[], None]) -> Callable[[], None]:
    """The loop's own timer."""
    return asyncio.get_running_loop().call_later(ms / 1000, fn).cancel


@dataclass(frozen=True)
class AccountFault:
    status: Literal[422, 502, 503]
    message: str


@dataclass(frozen=True)
class AccountResult:
    """`{ answer }` or `{ fault }`: exactly one is set."""

    answer: dict[str, Any] | None = None
    fault: AccountFault | None = None


@dataclass(frozen=True)
class AccountDeps:
    #: None where IB Gateway is not configured
    source: AccountSource | None
    #: `.env`'s `IBKR_ACCOUNT`, as written: blank is unset
    wanted: str
    now: Callable[[], datetime]
    display_tz: str
    #: the release's timer; the loop's unless a test says otherwise. It only WAKES the hold, which asks
    #: `now` whether the 90 s are up, so the clock stays the one injected.
    wake: Wake | None = None


def account_answer(picture: Mapping[str, Any], at: datetime, display_tz: str) -> dict[str, Any]:
    """The picture as the route serves it, answered at `at`."""
    holdings = picture["holdings"]
    pnl = picture["pnl"]
    totals = picture["totals"]
    pnl_at = picture["pnl_at"]
    return {
        "account": picture["account"],
        "paper": picture["paper"],
        "base_currency": picture["base_currency"],
        "updated_at": picture["updated_at"],
        "read_at": display_time(at, display_tz),
        "totals": {
            "net_liquidation": totals["net_liquidation"],
            "total_cash": totals["total_cash"],
            # the P&L stream's once it has spoken — an unset figure there is none, not the update's
            "unrealized_pnl": totals["unrealized_pnl"] if pnl is None else pnl["unrealized_pnl"],
            "realized_pnl": totals["realized_pnl"] if pnl is None else pnl["realized_pnl"],
            "daily_pnl": None if pnl is None else pnl["daily_pnl"],
        },
        "exchange_rates": picture["exchange_rates"],
        "stocks": [h for h in holdings if h["sec_type"] == "STK"],
        "options": [h for h in holdings if h["sec_type"] == "OPT"],
        "other": [
            {
                "sec_type": h["sec_type"],
                "symbol": h["symbol"],
                "position": h["position"],
                "market_value": h["market_value"],
                "currency": h["currency"],
            }
            for h in holdings
            if h["sec_type"] not in ("STK", "OPT")
        ],
        "live": None
        if pnl_at is None
        else {"updated_at": display_time(_EPOCH + timedelta(milliseconds=pnl_at), display_tz)},
    }


def _fault_of(started: AccountWatching) -> AccountFault:
    """What a start that is not a watch says, and with which status: the page is told a refused session
    in the gateway's words and anything else unreachable as a gateway that did not answer — the
    connect's own words are the log's. Neither carries an account id: none is known before a session."""
    if isinstance(started, AccountUnreachable):
        refused = started.words.startswith(REFUSED_SESSION)
        return AccountFault(502, started.words if refused else NOT_ANSWERING)
    if isinstance(started, AccountRefused):
        return AccountFault(422, started.words)
    assert isinstance(started, AccountFailed)
    return AccountFault(502, started.words)


@dataclass(frozen=True)
class _Failed:
    """The last start that failed — a first start or a watch again — and when it came back."""

    fault: AccountFault
    at: int


@dataclass
class _Hold:
    """The account held now."""

    #: the last read, by `now`
    last_read: int
    #: the first start, which every read before it ends joins: the watch, or what the page is told
    first: "asyncio.Task[AccountWatch | AccountFault] | None" = None
    #: the watch, once the first start has given one; replaced by each watch again that works
    watch: AccountWatch | None = None
    #: whether a watch again is in flight
    again: bool = False
    cancel_wake: Callable[[], None] = field(default=lambda: None)


def _eager[T](coro: Coroutine[Any, Any, T]) -> "asyncio.Task[T]":
    return asyncio.Task(coro, loop=asyncio.get_running_loop(), eager_start=True)


@dataclass
class AccountBook:
    """One per app, so every caller — today the page alone — reads the one hold.

    The library refuses a SECOND watch on one client with a plain `RuntimeError` ("this client already
    holds a watch of …; stop it first"), which the descriptor sorts as a start that failed: a 502 in the
    library's words, remembered like any failed start — never a 500. The hold almost never meets it,
    because it never starts a watch while the library holds one: a release stops its watch first, and a
    stop forgets the watch at once, before anything is sent (the stop's task is eager); a watch again
    starts only once the held watch is lost, which the library has forgotten too. The one window is a
    release while a start is still in flight, followed at once by a read: that read's start is refused as
    above, and the start in flight, when it ends, finds the hold gone and is stopped. The library's other
    plain refusal — the account read finding a watch of another account — cannot reach here: the service
    reads the account only through the watch, and `IBKR_ACCOUNT` is fixed for the life of the process.

    Nothing a caller does cancels a start: the first is a task of the hold's own, awaited through
    `asyncio.shield`, so a request given up — a client that disconnected, a timeout around the route —
    leaves it running for the next read; a watch again and a stop are tasks of their own, awaited by no
    caller. The hold has no deadline of its own around a start: the library's is the only one."""

    deps: AccountDeps
    _hold: _Hold | None = field(default=None)
    _failed: _Failed | None = field(default=None)
    #: stops and watches again still running, kept so the loop does not lose them
    _tasks: set["asyncio.Task[None]"] = field(default_factory=set)

    def __post_init__(self) -> None:
        if self.deps.source is not None:
            self.deps.source.on_answered(self._client_answered)

    async def read(self) -> AccountResult:
        deps = self.deps
        if deps.source is None:
            return AccountResult(fault=AccountFault(503, NOT_CONFIGURED))
        t = _ms(deps.now())
        hold = self._hold
        if hold is not None and self._expired(hold, t):
            self._release(hold)
            hold = None
        if hold is None:
            remembered = self._recently_failed(t)
            if remembered is not None:
                return AccountResult(fault=remembered)
            hold = self._begin(deps.source, t)
        else:
            hold.last_read = t

        watch = hold.watch
        if watch is None:
            assert hold.first is not None
            first = await asyncio.shield(hold.first)
            if isinstance(first, AccountFault):
                return AccountResult(fault=first)
            watch = first
        if watch.lost is not None:
            self._watch_again(hold)
            return AccountResult(fault=AccountFault(502, LOST))
        return AccountResult(answer=account_answer(watch.picture(), deps.now(), deps.display_tz))

    def _wanted(self) -> str | None:
        return self.deps.wanted.strip(JS_WHITESPACE) or None

    def _recently_failed(self, t: int) -> AccountFault | None:
        """What the last start that failed came to, while it is under `ACCOUNT_FAILED_FOR_MS` old; a clock
        that went back trusts nothing old."""
        failed = self._failed
        if failed is None:
            return None
        age = t - failed.at
        if 0 <= age < ACCOUNT_FAILED_FOR_MS:
            return failed.fault
        self._failed = None
        return None

    def _remember(self, started: AccountWatching, prefix: str) -> AccountFault:
        """A start that failed, remembered from now; the connect's own words to the log."""
        assert not isinstance(started, AccountWatched)
        log.error("IBKR account: %s%s", prefix, started.words)
        fault = _fault_of(started)
        self._failed = _Failed(fault, _ms(self.deps.now()))
        return fault

    @staticmethod
    def _expired(hold: _Hold, t: int) -> bool:
        """90 s since the last read; a clock that went back is a read now, never a hold expired."""
        return t - hold.last_read >= ACCOUNT_HELD_FOR_MS

    def _begin(self, source: AccountSource, t: int) -> _Hold:
        """The hold, from now: held BEFORE its start runs, because an eager task can finish — and drop
        the hold — before the line that would otherwise hold it."""
        hold = _Hold(last_read=t)
        self._hold = hold

        async def first() -> AccountWatch | AccountFault:
            try:
                started = await source.watch(self._wanted())
            except Exception:
                # a source that raises breaks its own promise (`AccountSource`): that is a bug, a 500, and
                # never held — the next caller starts again
                self._drop(hold)
                raise
            if not isinstance(started, AccountWatched):
                # a start that failed holds nothing, and is remembered: the next read after
                # `ACCOUNT_FAILED_FOR_MS` starts afresh
                self._drop(hold)
                return self._remember(started, "")
            self._failed = None
            self._took(hold, started.watch)
            return started.watch

        self._sleep(hold, ACCOUNT_HELD_FOR_MS)
        hold.first = _eager(first())
        # retrieved here, since a caller may never come back for it
        hold.first.add_done_callback(lambda done: None if done.cancelled() else done.exception())
        return hold

    def _took(self, hold: _Hold, watch: AccountWatch) -> None:
        """A watch a start gave `hold`: kept while the hold is, stopped where it was released meanwhile."""
        if self._hold is not hold:
            self._stop(watch)
            return
        hold.watch = watch
        watch.on_lost(lambda err: log.error("IBKR account: the watch was lost: %s", err))

    def _watch_again(self, hold: _Hold) -> None:
        """Start the watch again, under a hold whose watch was lost: one at a time, and not within
        `ACCOUNT_FAILED_FOR_MS` of a start that failed."""
        source = self.deps.source
        if hold.again or source is None or self._recently_failed(_ms(self.deps.now())) is not None:
            return
        hold.again = True

        async def again() -> None:
            try:
                started = await source.watch(self._wanted())
            except Exception as err:  # noqa: BLE001 — a bug in the source, logged as the TypeScript's is
                log.error("IBKR account: watching again failed: %s", err)
                return
            finally:
                hold.again = False
            if not isinstance(started, AccountWatched):
                self._remember(started, "watching again failed: ")
                return
            self._failed = None
            self._took(hold, started.watch)

        self._keep(_eager(again()))

    def _client_answered(self) -> None:
        """The client answered something else: while the held watch is lost, its connection is back."""
        hold = self._hold
        if hold is None or hold.watch is None or hold.watch.lost is None:
            return
        if self._expired(hold, _ms(self.deps.now())):
            self._release(hold)
            return
        self._watch_again(hold)

    def _sleep(self, hold: _Hold, ms: int) -> None:
        """Wake in `ms` and release the hold if the 90 s are up by then, else sleep the rest."""
        wake = self.deps.wake or _real_wake

        def woke() -> None:
            if self._hold is not hold:
                return
            age = _ms(self.deps.now()) - hold.last_read
            if age >= ACCOUNT_HELD_FOR_MS:
                self._release(hold)
            else:
                self._sleep(hold, ACCOUNT_HELD_FOR_MS - max(age, 0))

        hold.cancel_wake = wake(ms, woke)

    def _release(self, hold: _Hold) -> None:
        """Let it all go: the watch stopped, unless it was lost, and nothing kept. A start still in flight
        finds the hold gone and stops what it brings."""
        self._drop(hold)
        if hold.watch is not None and hold.watch.lost is None:
            self._stop(hold.watch)

    def _drop(self, hold: _Hold) -> None:
        if self._hold is hold:
            self._hold = None
        hold.cancel_wake()

    def _stop(self, watch: AccountWatch) -> None:
        async def stop() -> None:
            try:
                await watch.stop()
            except Exception as err:  # noqa: BLE001 — a stop that failed is logged, as the TypeScript's is
                log.error("IBKR account: stopping the watch failed: %s", err)

        self._keep(_eager(stop()))

    def _keep(self, task: "asyncio.Task[None]") -> None:
        if task.done():
            return
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
