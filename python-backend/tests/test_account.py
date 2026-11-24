"""The IBKR account behind `GET /account` (ADR 0030, #470): what each read comes to, and one read shared
by every caller for `ACCOUNT_SHARED_FOR_MS` (10 s), a read in flight joined, a failure too. Port of
backend/src/account.test.ts.

What only the Python can get wrong is at the end: a reader that answers without suspending, which an
eagerly started task runs to the end before the line that would hold it.
"""

import asyncio
import logging
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from optionality_backend.account import (
    NOT_ANSWERING,
    NOT_CONFIGURED,
    AccountBook,
    AccountDeps,
    AccountFault,
    AccountResult,
)
from optionality_backend.ports import (
    AccountFailed,
    AccountRead,
    AccountReading,
    AccountRefused,
    AccountUnreachable,
    ReadAccount,
)

NOW = datetime(2026, 11, 23, 15, 0, tzinfo=UTC)

#: The window, stated rather than imported, so the number itself is held: 10 s, the owner's decision on
#: #470 — under the page's 15 s refresh, so each refresh reads afresh.
WINDOW_MS = 10_000

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
)
FUTURE = holding(sec_type="FUT", symbol="ES", expiry="20261218", multiplier=50, position=1, market_value=0)
CASH = holding(sec_type="CASH", symbol="EUR.USD", currency="USD", position=1200, market_value=1290)

TOTALS = {"net_liquidation": 184523.17, "total_cash": 61230.55, "unrealized_pnl": 2071.4, "realized_pnl": -412.8}
ACCOUNT: Any = {
    "account": "masked-by-the-library",
    "paper": False,
    "base_currency": "USD",
    "updated_at": "14:32",
    "totals": TOTALS,
    "exchange_rates": {"USD": 1, "EUR": 1.075},
    "holdings": [STOCK, FUTURE, OPTION, CASH],
}


class Reader:
    """A reader that answers `reading` and counts what it was asked, settling when told to."""

    def __init__(self, reading: AccountReading | None = None) -> None:
        self.reading = reading if reading is not None else AccountRead(ACCOUNT)
        self.asked: list[str | None] = []
        self.gate: asyncio.Event | None = None

    def holding(self) -> None:
        self.gate = asyncio.Event()

    def release(self) -> None:
        assert self.gate is not None
        self.gate.set()

    async def __call__(self, wanted: str | None) -> AccountReading:
        self.asked.append(wanted)
        if self.gate is not None:
            await self.gate.wait()
        return self.reading


class Clock:
    def __init__(self) -> None:
        self.now = NOW

    def __call__(self) -> datetime:
        return self.now


def book(read: ReadAccount | None, wanted: str = "") -> tuple[AccountBook, Clock]:
    clock = Clock()
    return AccountBook(AccountDeps(read=read, wanted=wanted, now=clock, display_tz="Asia/Singapore")), clock


def ms(n: int) -> timedelta:
    return timedelta(milliseconds=n)


# --- what a read comes to ---------------------------------------------------------------------------


async def test_answers_the_account_stocks_and_options_apart_and_everything_else_under_other() -> None:
    result = await book(Reader())[0].read()
    assert result == AccountResult(
        answer={
            "account": "masked-by-the-library",
            "paper": False,
            "base_currency": "USD",
            "updated_at": "14:32",
            "read_at": "2026-11-23 23:00:00+08:00",
            "totals": TOTALS,
            # IBKR's own, passed through: base units per one unit of each currency
            "exchange_rates": {"USD": 1, "EUR": 1.075},
            "stocks": [STOCK],
            "options": [OPTION],
            # with only what the page lists of them, in the order IBKR sent them
            "other": [
                {"sec_type": "FUT", "symbol": "ES", "position": 1, "market_value": 0, "currency": "USD"},
                {"sec_type": "CASH", "symbol": "EUR.USD", "position": 1200, "market_value": 1290, "currency": "USD"},
            ],
        }
    )


async def test_asks_for_the_logins_only_account_where_ibkr_account_is_blank_or_spaces() -> None:
    r = Reader()
    await book(r, wanted="  ")[0].read()
    assert r.asked == [None]


async def test_asks_for_the_account_ibkr_account_names_trimmed() -> None:
    r = Reader()
    await book(r, wanted=" U0000001 ")[0].read()
    assert r.asked == ["U0000001"]


async def test_trims_ibkr_account_as_javascript_does_so_a_control_character_is_asked_for() -> None:
    # `str.strip()` would take the unit separator too, and read the login's only account
    r = Reader()
    await book(r, wanted="\x1f")[0].read()
    assert r.asked == ["\x1f"]


async def test_is_a_503_where_ib_gateway_is_not_configured_and_reads_nothing() -> None:
    assert await book(None)[0].read() == AccountResult(fault=AccountFault(503, NOT_CONFIGURED))
    assert NOT_CONFIGURED == "IB Gateway is not configured"


async def test_is_a_502_in_the_issues_words_where_the_gateway_does_not_answer() -> None:
    # the library's words for a gateway that is down, or at its login screen with its API port shut
    r = Reader(AccountUnreachable(DOWN))
    assert await book(r)[0].read() == AccountResult(fault=AccountFault(502, NOT_ANSWERING))
    assert NOT_ANSWERING == "IB Gateway did not answer — is it running and logged in?"


async def test_logs_the_connects_own_words_where_no_session_was_had(caplog: pytest.LogCaptureFixture) -> None:
    # the page is told only that the gateway did not answer; the log says why
    with caplog.at_level(logging.ERROR, logger="optionality_backend.account"):
        await book(Reader(AccountUnreachable(DOWN)))[0].read()
    assert [(r.name, r.levelno, r.getMessage()) for r in caplog.records] == [
        ("optionality_backend.account", logging.ERROR, f"IBKR account: {DOWN}")
    ]


async def test_is_a_502_in_the_gateways_own_words_where_it_refused_the_session() -> None:
    # the library's words for `client-id-in-use`: not a gateway that is down, and not told as one
    assert await book(Reader(AccountUnreachable(REFUSED)))[0].read() == AccountResult(fault=AccountFault(502, REFUSED))


async def test_is_a_502_in_the_librarys_words_where_the_read_did_not_finish() -> None:
    words = "IB Gateway did not finish sending the account within 8000ms"
    assert await book(Reader(AccountFailed(words)))[0].read() == AccountResult(fault=AccountFault(502, words))


async def test_is_a_422_in_the_librarys_words_where_it_would_not_choose_an_account() -> None:
    words = "several accounts on this login; set IBKR_ACCOUNT to one of <the masked ids>"
    assert await book(Reader(AccountRefused(words)))[0].read() == AccountResult(fault=AccountFault(422, words))


# --- one read, shared -------------------------------------------------------------------------------


async def test_serves_every_caller_inside_the_window_from_the_first_read() -> None:
    r = Reader()
    b, clock = book(r)
    first = await b.read()
    clock.now = NOW + ms(WINDOW_MS - 1)
    assert await b.read() == first
    assert len(r.asked) == 1


async def test_reads_afresh_once_the_window_has_passed() -> None:
    r = Reader()
    b, clock = book(r)
    await b.read()
    clock.now = NOW + ms(WINDOW_MS)
    again = await b.read()
    assert len(r.asked) == 2
    assert again.answer is not None
    assert again.answer["read_at"] == "2026-11-23 23:00:10+08:00"


async def test_counts_the_window_from_when_the_read_came_back() -> None:
    r = Reader()
    r.holding()
    b, clock = book(r)
    first = asyncio.ensure_future(b.read())
    await asyncio.sleep(0)
    clock.now = NOW + ms(8000)
    r.release()
    answered = await first
    assert answered.answer is not None
    assert answered.answer["read_at"] == "2026-11-23 23:00:08+08:00"
    clock.now = NOW + ms(8000 + WINDOW_MS - 1)
    await b.read()
    assert len(r.asked) == 1


async def test_joins_a_read_in_flight_rather_than_asking_twice() -> None:
    r = Reader()
    r.holding()
    b, _ = book(r)
    both = asyncio.gather(b.read(), b.read())
    await asyncio.sleep(0)
    r.release()
    one, two = await both
    assert one == two
    assert len(r.asked) == 1


async def test_shares_a_failure_for_the_same_window() -> None:
    r = Reader(AccountUnreachable(DOWN))
    b, clock = book(r)
    await b.read()
    clock.now = NOW + ms(WINDOW_MS - 1)
    assert await b.read() == AccountResult(fault=AccountFault(502, NOT_ANSWERING))
    assert len(r.asked) == 1


async def test_trusts_nothing_it_read_when_the_clock_has_gone_back() -> None:
    r = Reader()
    b, clock = book(r)
    await b.read()
    clock.now = NOW - ms(1)
    await b.read()
    assert len(r.asked) == 2


async def test_reads_afresh_after_a_reader_that_raised() -> None:
    calls = 0

    async def read(_wanted: str | None) -> AccountReading:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("a bug")
        return AccountRead(ACCOUNT)

    b, _ = book(read)
    with pytest.raises(RuntimeError, match="a bug"):
        await b.read()
    assert (await b.read()).answer is not None


# --- what only the Python can get wrong -------------------------------------------------------------


async def test_a_caller_giving_up_does_not_cancel_the_read_under_the_others() -> None:
    r = Reader()
    r.holding()
    b, _ = book(r)
    impatient = asyncio.ensure_future(b.read())
    patient = asyncio.ensure_future(b.read())
    await asyncio.sleep(0)
    impatient.cancel()
    r.release()
    assert (await patient).answer is not None
    assert len(r.asked) == 1
