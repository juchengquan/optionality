"""`GET /account`: the IBKR account, through the app (ADR 0031, #477). Port of
backend/src/entrypoints/http/routes/account.test.ts.

What a start comes to and how the hold is kept are `test_account.py`'s; this holds the door — the token,
the shape, the statuses, and one hold per app.
"""

import copy
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any

from optionality_backend.ports import (
    AccountRefused,
    AccountUnreachable,
    AccountWatched,
    AccountWatching,
)

#: the library's words for a gateway nothing listens for (`ibkr.py`, on this machine)
DOWN = "could not reach IB Gateway at 127.0.0.1:4001: [Errno 61] Connect call failed ('127.0.0.1', 4001)"

OPTION: dict[str, Any] = {
    "sec_type": "OPT",
    "symbol": "ACME",
    "currency": "USD",
    "expiry": "20261218",
    "strike": 45,
    "right": "C",
    "multiplier": 100,
    "position": 1,
    "market_price": 1.5,
    "market_value": 150,
    "average_cost": 1.25,
    "unrealized_pnl": 25,
    "realized_pnl": 0,
    "daily_pnl": -5,
}

ACCOUNT: dict[str, Any] = {
    "account": "masked-by-the-library",
    "paper": True,
    "base_currency": "USD",
    "updated_at": "09:41",
    "totals": {"net_liquidation": 1000, "total_cash": 1000, "unrealized_pnl": 0, "realized_pnl": 0},
    "exchange_rates": {"USD": 1},
    "holdings": [OPTION],
    "pnl": {"daily_pnl": -5, "unrealized_pnl": 25, "realized_pnl": None},
    "pnl_at": (datetime(2026, 10, 2, 5, 26, 1, tzinfo=UTC) - datetime(1970, 1, 1, tzinfo=UTC))
    // timedelta(milliseconds=1),
}


class _Watch:
    lost = None

    def picture(self) -> dict[str, Any]:
        return copy.deepcopy(ACCOUNT)

    def on_lost(self, listener: Callable[[BaseException], None]) -> None:
        pass

    async def stop(self) -> None:
        pass


class Watching:
    def __init__(self, answer: AccountWatching | None = None) -> None:
        self.answer = answer if answer is not None else AccountWatched(_Watch())
        self.asked: list[str | None] = []

    async def watch(self, wanted: str | None) -> AccountWatching:
        self.asked.append(wanted)
        return self.answer

    def on_answered(self, listener: Callable[[], None]) -> None:
        pass


class TestGetAccount:
    async def test_is_behind_the_token_and_starts_nothing_for_a_caller_without_one(self, start):
        w = Watching()
        h = start(account=w)
        resp = await h.call("/account", anonymous=True)
        assert resp.status_code == 401
        assert w.asked == []

    async def test_answers_the_account_in_the_routes_shape_ibkr_account_handed_to_the_watch(self, start):
        w = Watching()
        h = start(account=w, settings={"ibkr_account": "DU0000000"})
        resp = await h.call("/account")
        assert resp.status_code == 200
        assert resp.json() == {
            "account": "masked-by-the-library",
            "paper": True,
            "base_currency": "USD",
            "updated_at": "09:41",
            "read_at": "2026-10-02 13:26:06+08:00",
            "totals": {
                "net_liquidation": 1000,
                "total_cash": 1000,
                "unrealized_pnl": 25,
                "realized_pnl": None,
                "daily_pnl": -5,
            },
            "exchange_rates": {"USD": 1},
            "stocks": [],
            "options": [OPTION],
            "other": [],
            "live": {"updated_at": "2026-10-02 13:26:01+08:00"},
        }
        assert w.asked == ["DU0000000"]

    async def test_holds_one_watch_for_two_requests_to_the_same_app(self, start):
        w = Watching()
        h = start(account=w)
        await h.call("/account")
        await h.call("/account")
        assert len(w.asked) == 1

    async def test_is_a_503_where_ib_gateway_is_not_configured(self, start):
        resp = await start().call("/account")
        assert resp.status_code == 503
        assert resp.json() == {"detail": "IB Gateway is not configured"}

    async def test_is_a_502_where_the_gateway_does_not_answer_and_a_422_where_the_account_is_refused(self, start):
        down = AccountUnreachable(DOWN)
        assert (await start(account=Watching(down)).call("/account")).status_code == 502
        resp = await start(account=Watching(AccountRefused("several accounts on this login"))).call("/account")
        assert resp.status_code == 422
        assert resp.json() == {"detail": "several accounts on this login"}
