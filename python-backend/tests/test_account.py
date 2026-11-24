"""The IBKR account behind `GET /account` (ADR 0031, #477): what a start comes to, the answer from the
watch's picture, and the hold — started by the first read, renewed by every read, released
`ACCOUNT_HELD_FOR_MS` (90 s) after the last, and watched again after its connection is lost. Port of
backend/src/account.test.ts.

What only the Python can get wrong is at the end: a caller giving up, which must not cancel the start
under the others.
"""

import asyncio
import copy
import logging
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from optionality_backend.account import (
    ACCOUNT_FAILED_FOR_MS,
    ACCOUNT_HELD_FOR_MS,
    LOST,
    NOT_ANSWERING,
    NOT_CONFIGURED,
    AccountBook,
    AccountDeps,
    AccountFault,
    AccountResult,
)
from optionality_backend.ports import (
    AccountFailed,
    AccountRefused,
    AccountSource,
    AccountUnreachable,
    AccountWatched,
    AccountWatching,
)

#: The hold, stated rather than imported, so the number itself is held: 90 s, the owner's decision on
#: #477 — the page's slowest refresh is a minute, so every refresh keeps it.
HELD_MS = 90_000
#: How long a failed start is remembered, stated for the same reason: 5 s, the owner's decision on #477 —
#: at most one try in that time while IB Gateway is down, whoever asks.
FAILED_MS = 5_000

NOW = datetime(2026, 11, 23, 15, 0, tzinfo=UTC)
_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)

#: the library's words for a gateway nothing listens for (`ibkr.py`, on this machine)
DOWN = "could not reach IB Gateway at 127.0.0.1:4001: [Errno 61] Connect call failed ('127.0.0.1', 4001)"
#: the library's words for its `client-id-in-use` recording
REFUSED = (
    "IB Gateway refused the session: 326 Unable to connect as the client id is already in use. "
    "Retry with a unique client id."
)


def holding(**over: Any) -> dict[str, Any]:
    return {
        "sec_type": "STK",
        "symbol": "ACME",
        "currency": "USD",
        "expiry": None,
        "strike": None,
        "right": None,
        "multiplier": None,
        "position": 100,
        "market_price": 41.25,
        "market_value": 4125,
        "average_cost": 38.5,
        "unrealized_pnl": 275,
        "realized_pnl": 0,
        "daily_pnl": 62.5,
        **over,
    }


STOCK = holding()
OPTION = holding(
    sec_type="OPT",
    expiry="20261218",
    strike=45,
    right="C",
    multiplier=100,
    position=-2,
    market_price=1.5,
    market_value=-300,
    average_cost=2.25,
    daily_pnl=None,
)
FUTURE = holding(sec_type="FUT", symbol="ES", expiry="20261218", multiplier=50, position=1, market_value=0)
CASH = holding(sec_type="CASH", symbol="EUR.USD", currency="USD", position=1200, market_value=1290)

TOTALS = {"net_liquidation": 184523.17, "total_cash": 61230.55, "unrealized_pnl": 2071.4, "realized_pnl": -412.8}
PNL = {"daily_pnl": 318.25, "unrealized_pnl": 2104.6, "realized_pnl": -398.15}


def ms_of(when: datetime) -> int:
    return (when - _EPOCH) // timedelta(milliseconds=1)


#: A picture whose P&L stream has not spoken yet.
QUIET: dict[str, Any] = {
    "account": "masked-by-the-library",
    "paper": False,
    "base_currency": "USD",
    "updated_at": "14:32",
    "totals": TOTALS,
    "exchange_rates": {"USD": 1, "EUR": 1.075},
    "holdings": [STOCK, FUTURE, OPTION, CASH],
    "pnl": None,
    "pnl_at": None,
}
#: The same, the P&L stream having spoken 4 s before NOW.
LIVE: dict[str, Any] = {**QUIET, "pnl": PNL, "pnl_at": ms_of(NOW) - 4000}


class FakeWatch:
    """A watch the test controls: its picture, its loss, and whether it was stopped."""

    def __init__(self, account: dict[str, Any]) -> None:
        self.account = account
        self.lost: BaseException | None = None
        self.stopped = 0
        self._listeners: list[Callable[[BaseException], None]] = []

    def picture(self) -> dict[str, Any]:
        return copy.deepcopy(self.account)

    def on_lost(self, listener: Callable[[BaseException], None]) -> None:
        self._listeners.append(listener)

    async def stop(self) -> None:
        self.stopped += 1

    def lose(self, words: str = "IB Gateway closed the connection") -> None:
        self.lost = ConnectionError(words)
        for listener in self._listeners:
            listener(self.lost)


type Answer = dict[str, Any] | AccountUnreachable | AccountRefused | AccountFailed


class Source:
    """A source answering each start with the next of `answers` (the last repeating) — a picture is a
    new watch on it — counting what it was asked, settling when told to."""

    def __init__(self, *answers: Answer) -> None:
        self.answers = answers or (LIVE,)
        self.asked: list[str | None] = []
        self.watches: list[FakeWatch] = []
        self.gate: asyncio.Event | None = None
        self._answered: list[Callable[[], None]] = []

    def holding(self) -> None:
        self.gate = asyncio.Event()

    def release(self) -> None:
        assert self.gate is not None
        gate, self.gate = self.gate, None
        gate.set()

    def answered(self) -> None:
        """The client answered something else: a price read that worked."""
        for listener in self._answered:
            listener()

    async def watch(self, wanted: str | None) -> AccountWatching:
        n = len(self.asked)
        self.asked.append(wanted)
        if self.gate is not None:
            await self.gate.wait()
        a = self.answers[min(n, len(self.answers) - 1)]
        if not isinstance(a, dict):
            return a
        w = FakeWatch(a)
        self.watches.append(w)
        return AccountWatched(w)

    def on_answered(self, listener: Callable[[], None]) -> None:
        self._answered.append(listener)


class Clock:
    def __init__(self) -> None:
        self.now = NOW

    def __call__(self) -> datetime:
        return self.now


class Timers:
    """Timers the test fires by hand."""

    def __init__(self) -> None:
        self.set: list[list[Any]] = []

    def wake(self, ms: int, fn: Callable[[], None]) -> Callable[[], None]:
        t: list[Any] = [ms, fn, True]
        self.set.append(t)

        def cancel() -> None:
            t[2] = False

        return cancel

    def fire(self) -> None:
        """Fire every timer still set."""
        fired, self.set = self.set, []
        for _ms, fn, live in fired:
            if live:
                fn()

    def live(self) -> list[int]:
        return [t[0] for t in self.set if t[2]]


def book(source: AccountSource | None, wanted: str = "") -> tuple[AccountBook, Clock, Timers]:
    clock = Clock()
    timers = Timers()
    deps = AccountDeps(source=source, wanted=wanted, now=clock, display_tz="Asia/Singapore", wake=timers.wake)
    return AccountBook(deps), clock, timers


def at(ms: int) -> datetime:
    return NOW + timedelta(milliseconds=ms)


async def settle() -> None:
    for _ in range(3):
        await asyncio.sleep(0)


# --- the answer, from the watch's picture -----------------------------------------------------------


async def test_answers_the_account_stocks_and_options_apart_pnl_from_the_stream_and_when_it_last_spoke() -> None:
    result = await book(Source(LIVE))[0].read()
    assert result == AccountResult(
        answer={
            "account": "masked-by-the-library",
            "paper": False,
            "base_currency": "USD",
            "updated_at": "14:32",
            "read_at": "2026-11-23 23:00:00+08:00",
            # the P&L stream's once it has spoken; net liquidation and cash the account updates'
            "totals": {
                "net_liquidation": 184523.17,
                "total_cash": 61230.55,
                "unrealized_pnl": 2104.6,
                "realized_pnl": -398.15,
                "daily_pnl": 318.25,
            },
            "exchange_rates": {"USD": 1, "EUR": 1.075},
            "stocks": [STOCK],
            "options": [OPTION],
            "other": [
                {"sec_type": "FUT", "symbol": "ES", "position": 1, "market_value": 0, "currency": "USD"},
                {"sec_type": "CASH", "symbol": "EUR.USD", "position": 1200, "market_value": 1290, "currency": "USD"},
            ],
            "live": {"updated_at": "2026-11-23 22:59:56+08:00"},
        }
    )


async def test_takes_the_totals_pnl_from_the_account_updates_until_the_stream_has_spoken() -> None:
    result = await book(Source(QUIET))[0].read()
    assert result.answer is not None
    assert result.answer["totals"] == {**TOTALS, "daily_pnl": None}
    assert result.answer["live"] is None


async def test_takes_a_total_the_stream_sent_unset_from_the_account_update_null_only_where_neither_has_one() -> None:
    # the owner's decision on #480, as a holding's unset figure is the account update's (#476)
    unset = {
        **LIVE,
        "totals": {**TOTALS, "realized_pnl": None},
        "pnl": {"daily_pnl": None, "unrealized_pnl": None, "realized_pnl": None},
    }
    result = await book(Source(unset))[0].read()
    assert result.answer is not None
    assert result.answer["totals"] == {
        "net_liquidation": 184523.17,
        "total_cash": 61230.55,
        "unrealized_pnl": 2071.4,
        "realized_pnl": None,
        # the account updates carry no daily figure
        "daily_pnl": None,
    }


async def test_answers_the_picture_as_it_stands_at_each_read() -> None:
    s = Source(LIVE)
    b, clock, _ = book(s)
    await b.read()
    s.watches[0].account = {**LIVE, "pnl": {**PNL, "daily_pnl": 400}, "pnl_at": ms_of(at(2000))}
    clock.now = at(3000)
    result = await b.read()
    assert result.answer is not None
    assert result.answer["read_at"] == "2026-11-23 23:00:03+08:00"
    assert result.answer["totals"]["daily_pnl"] == 400
    assert result.answer["live"] == {"updated_at": "2026-11-23 23:00:02+08:00"}


# --- what a start comes to --------------------------------------------------------------------------


async def test_asks_for_the_logins_only_account_where_ibkr_account_is_blank_or_spaces() -> None:
    s = Source()
    await book(s, wanted="  ")[0].read()
    assert s.asked == [None]


async def test_asks_for_the_account_ibkr_account_names_trimmed() -> None:
    s = Source()
    await book(s, wanted=" U0000001 ")[0].read()
    assert s.asked == ["U0000001"]


async def test_trims_ibkr_account_as_javascript_does_so_a_control_character_is_asked_for() -> None:
    # `str.strip()` would take the unit separator too, and read the login's only account
    s = Source()
    await book(s, wanted="\x1f")[0].read()
    assert s.asked == ["\x1f"]


async def test_is_a_503_where_ib_gateway_is_not_configured_and_starts_nothing() -> None:
    assert await book(None)[0].read() == AccountResult(fault=AccountFault(503, NOT_CONFIGURED))
    assert NOT_CONFIGURED == "IB Gateway is not configured"


async def test_is_a_502_in_the_issues_words_where_the_gateway_does_not_answer_the_connects_words_logged(
    caplog: pytest.LogCaptureFixture,
) -> None:
    with caplog.at_level(logging.ERROR, logger="optionality_backend.account"):
        result = await book(Source(AccountUnreachable(DOWN)))[0].read()
    assert result == AccountResult(fault=AccountFault(502, NOT_ANSWERING))
    assert NOT_ANSWERING == "IB Gateway did not answer — is it running and logged in?"
    assert [r.getMessage() for r in caplog.records] == [f"IBKR account: {DOWN}"]


async def test_is_a_502_in_the_gateways_own_words_where_it_refused_the_session() -> None:
    assert await book(Source(AccountUnreachable(REFUSED)))[0].read() == AccountResult(fault=AccountFault(502, REFUSED))


async def test_is_a_502_in_the_librarys_words_where_the_first_picture_did_not_come() -> None:
    words = "IB Gateway did not finish sending the account within 8000ms"
    assert await book(Source(AccountFailed(words)))[0].read() == AccountResult(fault=AccountFault(502, words))


async def test_is_a_422_in_the_librarys_words_where_it_would_not_choose_an_account() -> None:
    words = "several accounts on this login; set IBKR_ACCOUNT to one of <the masked ids>"
    assert await book(Source(AccountRefused(words)))[0].read() == AccountResult(fault=AccountFault(422, words))


async def test_holds_nothing_after_a_start_that_failed_the_first_read_5s_on_starts_afresh() -> None:
    s = Source(AccountFailed("did not finish"), LIVE)
    b, clock, timers = book(s)
    await b.read()
    assert timers.live() == []
    clock.now = at(FAILED_MS)
    assert (await b.read()).answer is not None
    assert len(s.asked) == 2


async def test_remembers_a_failed_start_for_5s_every_read_inside_them_told_the_same_nothing_started() -> None:
    s = Source(AccountUnreachable("connect ECONNREFUSED"), LIVE)
    b, clock, _ = book(s)
    first = await b.read()
    assert first == AccountResult(fault=AccountFault(502, NOT_ANSWERING))
    clock.now = at(FAILED_MS - 1)
    assert await b.read() == first
    assert len(s.asked) == 1
    assert ACCOUNT_FAILED_FOR_MS == FAILED_MS


async def test_counts_the_5s_from_when_the_failed_start_came_back_not_from_when_it_was_asked() -> None:
    s = Source(AccountFailed("did not finish"), LIVE)
    s.holding()
    b, clock, _ = book(s)
    first = asyncio.ensure_future(b.read())
    await asyncio.sleep(0)
    clock.now = at(3000)
    s.release()
    await first
    clock.now = at(3000 + FAILED_MS - 1)
    await b.read()
    assert len(s.asked) == 1
    clock.now = at(3000 + FAILED_MS)
    assert (await b.read()).answer is not None
    assert len(s.asked) == 2


async def test_remembers_a_refusal_the_same_way_in_its_words() -> None:
    words = "several accounts on this login; set IBKR_ACCOUNT to one of <the masked ids>"
    s = Source(AccountRefused(words))
    b, clock, _ = book(s)
    await b.read()
    clock.now = at(1000)
    assert await b.read() == AccountResult(fault=AccountFault(422, words))
    assert len(s.asked) == 1


async def test_trusts_no_failure_it_remembers_when_the_clock_has_gone_back() -> None:
    s = Source(AccountFailed("did not finish"), LIVE)
    b, clock, _ = book(s)
    await b.read()
    clock.now = at(-1)
    assert (await b.read()).answer is not None
    assert len(s.asked) == 2


async def test_starts_afresh_after_a_source_that_raised_rather_than_holding_it_for_ever() -> None:
    calls = 0

    class Raising(Source):
        async def watch(self, wanted: str | None) -> AccountWatching:
            nonlocal calls
            calls += 1
            if calls == 1:
                raise RuntimeError("a bug")
            return AccountWatched(FakeWatch(LIVE))

    b, _, _ = book(Raising())
    with pytest.raises(RuntimeError, match="a bug"):
        await b.read()
    assert (await b.read()).answer is not None


# --- the hold ---------------------------------------------------------------------------------------


async def test_answers_every_read_inside_the_hold_from_the_one_watch_with_no_start() -> None:
    s = Source(LIVE)
    b, clock, _ = book(s)
    await b.read()
    clock.now = at(HELD_MS - 1)
    assert (await b.read()).answer is not None
    assert len(s.asked) == 1
    assert ACCOUNT_HELD_FOR_MS == HELD_MS


async def test_is_renewed_by_every_read_90s_after_the_last_read_not_the_first() -> None:
    s = Source(LIVE)
    b, clock, _ = book(s)
    await b.read()
    clock.now = at(60_000)
    await b.read()
    clock.now = at(60_000 + HELD_MS - 1)
    await b.read()
    assert len(s.asked) == 1
    assert s.watches[0].stopped == 0


async def test_joins_a_start_in_flight_rather_than_starting_twice() -> None:
    s = Source(LIVE)
    s.holding()
    b, _, _ = book(s)
    both = asyncio.gather(b.read(), b.read())
    await asyncio.sleep(0)
    s.release()
    one, two = await both
    assert one == two
    assert one.answer is not None
    assert len(s.asked) == 1


async def test_joins_a_failed_start_too_logging_its_words_once(caplog: pytest.LogCaptureFixture) -> None:
    s = Source(AccountUnreachable("connect ECONNREFUSED"))
    s.holding()
    b, _, _ = book(s)
    with caplog.at_level(logging.ERROR, logger="optionality_backend.account"):
        both = asyncio.gather(b.read(), b.read())
        await asyncio.sleep(0)
        s.release()
        results = await both
    assert results == [AccountResult(fault=AccountFault(502, NOT_ANSWERING))] * 2
    assert len(s.asked) == 1
    assert len(caplog.records) == 1


async def test_is_released_90s_after_the_last_read_the_watch_stopped_and_nothing_kept() -> None:
    s = Source(LIVE)
    b, clock, timers = book(s)
    await b.read()
    assert timers.live() == [HELD_MS]
    clock.now = at(HELD_MS)
    timers.fire()
    await settle()
    assert s.watches[0].stopped == 1
    assert timers.live() == []
    # a read after the release starts afresh
    await b.read()
    assert len(s.asked) == 2


async def test_when_its_timer_wakes_before_the_90s_are_up_it_sleeps_the_rest() -> None:
    s = Source(LIVE)
    b, clock, timers = book(s)
    await b.read()
    clock.now = at(30_000)
    await b.read()
    clock.now = at(HELD_MS)
    timers.fire()
    await settle()
    assert s.watches[0].stopped == 0
    assert timers.live() == [30_000]
    clock.now = at(30_000 + HELD_MS)
    timers.fire()
    await settle()
    assert s.watches[0].stopped == 1


async def test_releases_at_a_read_that_finds_the_90s_passed_should_the_timer_not_have_woken() -> None:
    s = Source(LIVE)
    b, clock, _ = book(s)
    await b.read()
    clock.now = at(HELD_MS)
    await b.read()
    assert s.watches[0].stopped == 1
    assert len(s.asked) == 2
    assert s.watches[1].stopped == 0


async def test_takes_a_clock_that_went_back_as_a_read_now_not_as_a_hold_expired() -> None:
    s = Source(LIVE)
    b, clock, _ = book(s)
    await b.read()
    clock.now = at(-5000)
    await b.read()
    assert len(s.asked) == 1


async def test_stops_a_watch_whose_start_ends_after_the_hold_was_released() -> None:
    s = Source(LIVE)
    s.holding()
    b, clock, timers = book(s)
    first = asyncio.ensure_future(b.read())
    await asyncio.sleep(0)
    clock.now = at(HELD_MS)
    timers.fire()
    s.release()
    await first
    await settle()
    assert s.watches[0].stopped == 1


# --- a lost connection ------------------------------------------------------------------------------


async def test_answers_502_in_words_while_the_watch_is_lost_and_watches_again_at_that_read(
    caplog: pytest.LogCaptureFixture,
) -> None:
    s = Source(LIVE)
    b, _, _ = book(s)
    await b.read()
    with caplog.at_level(logging.ERROR, logger="optionality_backend.account"):
        s.watches[0].lose("IB Gateway closed the connection")
    assert [r.getMessage() for r in caplog.records] == [
        "IBKR account: the watch was lost: IB Gateway closed the connection"
    ]
    s.holding()
    assert await b.read() == AccountResult(fault=AccountFault(502, LOST))
    assert LOST == "The connection to IB Gateway was lost"
    assert len(s.asked) == 2
    # a read while that start is in flight is the same 502, and starts nothing more
    assert await b.read() == AccountResult(fault=AccountFault(502, LOST))
    assert len(s.asked) == 2
    s.release()
    await settle()
    result = await b.read()
    assert result.answer is not None
    assert result.answer["account"] == "masked-by-the-library"
    assert len(s.asked) == 2


async def test_never_stops_a_lost_watch_the_loss_has_already_ended_it() -> None:
    s = Source(LIVE)
    b, clock, timers = book(s)
    await b.read()
    s.watches[0].lose()
    await b.read()
    await settle()
    assert s.watches[0].stopped == 0
    s.watches[1].lose()
    clock.now = at(HELD_MS + 10)
    timers.fire()
    await settle()
    assert s.watches[1].stopped == 0


async def test_is_the_same_502_after_a_watch_again_that_failed_and_the_next_read_tries_again(
    caplog: pytest.LogCaptureFixture,
) -> None:
    unreachable = AccountUnreachable("connect ECONNREFUSED")
    s = Source(LIVE, unreachable, unreachable, LIVE)
    b, clock, _ = book(s)
    await b.read()
    s.watches[0].lose()
    with caplog.at_level(logging.ERROR, logger="optionality_backend.account"):
        assert await b.read() == AccountResult(fault=AccountFault(502, LOST))
        await settle()
    assert "IBKR account: watching again failed: connect ECONNREFUSED" in [r.getMessage() for r in caplog.records]
    # not again inside the 5 s, at a read or when the client answers
    clock.now = at(FAILED_MS - 1)
    assert await b.read() == AccountResult(fault=AccountFault(502, LOST))
    s.answered()
    assert len(s.asked) == 2
    clock.now = at(FAILED_MS)
    assert await b.read() == AccountResult(fault=AccountFault(502, LOST))
    await settle()
    assert len(s.asked) == 3
    clock.now = at(2 * FAILED_MS)
    assert await b.read() == AccountResult(fault=AccountFault(502, LOST))
    await settle()
    assert (await b.read()).answer is not None
    assert len(s.asked) == 4


async def test_watches_again_when_the_client_answers_something_else_while_the_hold_is_up() -> None:
    s = Source(LIVE)
    b, _, _ = book(s)
    await b.read()
    s.watches[0].lose()
    s.answered()
    assert len(s.asked) == 2
    await settle()
    assert (await b.read()).answer is not None
    assert len(s.asked) == 2


async def test_starts_nothing_when_the_client_answers_while_the_watch_is_well_or_nothing_is_held() -> None:
    s = Source(LIVE)
    b, clock, _ = book(s)
    s.answered()
    await b.read()
    s.answered()
    assert len(s.asked) == 1
    # held no more: the client answering is not a read
    s.watches[0].lose()
    clock.now = at(HELD_MS)
    s.answered()
    assert len(s.asked) == 1


async def test_stops_a_watch_that_came_back_after_the_hold_was_released() -> None:
    s = Source(LIVE)
    b, clock, timers = book(s)
    await b.read()
    s.watches[0].lose()
    s.holding()
    await b.read()
    clock.now = at(HELD_MS)
    timers.fire()
    s.release()
    await settle()
    assert s.watches[1].stopped == 1


# --- what only the Python can get wrong -------------------------------------------------------------


async def test_a_caller_giving_up_does_not_cancel_the_start_under_the_others() -> None:
    s = Source(LIVE)
    s.holding()
    b, _, _ = book(s)
    impatient = asyncio.ensure_future(b.read())
    patient = asyncio.ensure_future(b.read())
    await asyncio.sleep(0)
    impatient.cancel()
    s.release()
    assert (await patient).answer is not None
    assert len(s.asked) == 1


async def test_the_only_caller_cancelled_during_the_start_leaves_the_start_running_for_the_next_read() -> None:
    # a request given up — a client that disconnected, a timeout around the route — cancels its own wait,
    # never the start: the watch it brings is held, and the next read is answered from it
    s = Source(LIVE)
    s.holding()
    b, _, _ = book(s)
    gone = asyncio.ensure_future(b.read())
    await asyncio.sleep(0)
    gone.cancel()
    with pytest.raises(asyncio.CancelledError):
        await gone
    s.release()
    await settle()
    assert len(s.watches) == 1
    assert (await b.read()).answer is not None
    assert len(s.asked) == 1
    assert s.watches[0].stopped == 0


async def test_a_start_cancelled_under_the_hold_holds_nothing_and_the_next_read_starts_afresh() -> None:
    # no caller can cancel the start (the shield), but the loop's shutdown can, and the library then
    # abandons it: the hold must not be left joined to a start that will never answer
    s = Source(LIVE)
    s.holding()
    b, _, _ = book(s)
    waiting = asyncio.ensure_future(b.read())
    await asyncio.sleep(0)
    assert b._hold is not None and b._hold.first is not None
    b._hold.first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiting
    assert b._hold is None
    s.release()
    assert (await b.read()).answer is not None
    assert len(s.asked) == 2


async def test_the_real_timer_is_the_loops_own() -> None:
    # no injected timer: the loop's `call_later`, cancelled with the hold
    s = Source(LIVE)
    clock = Clock()
    b = AccountBook(AccountDeps(source=s, wanted="", now=clock, display_tz="UTC"))
    await b.read()
    clock.now = at(HELD_MS)
    await b.read()
    assert s.watches[0].stopped == 1
