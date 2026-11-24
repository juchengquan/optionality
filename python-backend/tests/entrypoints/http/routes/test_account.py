"""`GET /account`: the IBKR account, through the app (ADR 0030, #470). Port of
backend/src/entrypoints/http/routes/account.test.ts.

What each read comes to and how one is shared are `test_account.py`'s; this holds the door — the token,
the shape, the statuses, and one book per app.
"""

from typing import Any

from optionality_backend.ports import AccountRead, AccountReading, AccountRefused, AccountUnreachable

#: the library's words for a gateway nothing listens for (`ibkr.py`, on this machine)
DOWN = "could not reach IB Gateway at 127.0.0.1:4001: [Errno 61] Connect call failed ('127.0.0.1', 4001)"

ACCOUNT: dict[str, Any] = {
    "account": "masked-by-the-library",
    "paper": True,
    "base_currency": "USD",
    "updated_at": "09:41",
    "totals": {"net_liquidation": 1000, "total_cash": 1000, "unrealized_pnl": 0, "realized_pnl": 0},
    "exchange_rates": {"USD": 1},
    "holdings": [],
}


class Reading:
    def __init__(self, answer: AccountReading) -> None:
        self.answer = answer
        self.asked: list[str | None] = []

    async def __call__(self, wanted: str | None) -> AccountReading:
        self.asked.append(wanted)
        return self.answer


class TestGetAccount:
    async def test_is_behind_the_token_and_reads_nothing_for_a_caller_without_one(self, start):
        r = Reading(AccountRead(ACCOUNT))
        h = start(account=r)
        resp = await h.call("/account", anonymous=True)
        assert resp.status_code == 401
        assert r.asked == []

    async def test_answers_the_account_in_the_routes_shape_ibkr_account_handed_to_the_read(self, start):
        r = Reading(AccountRead(ACCOUNT))
        h = start(account=r, settings={"ibkr_account": "DU0000000"})
        resp = await h.call("/account")
        assert resp.status_code == 200
        assert resp.json() == {
            "account": "masked-by-the-library",
            "paper": True,
            "base_currency": "USD",
            "updated_at": "09:41",
            "read_at": "2026-10-02 13:26:06+08:00",
            "totals": ACCOUNT["totals"],
            "exchange_rates": {"USD": 1},
            "stocks": [],
            "options": [],
            "other": [],
        }
        assert r.asked == ["DU0000000"]

    async def test_shares_one_read_between_two_requests_to_the_same_app(self, start):
        r = Reading(AccountRead(ACCOUNT))
        h = start(account=r)
        await h.call("/account")
        await h.call("/account")
        assert len(r.asked) == 1

    async def test_is_a_503_where_ib_gateway_is_not_configured(self, start):
        resp = await start().call("/account")
        assert resp.status_code == 503
        assert resp.json() == {"detail": "IB Gateway is not configured"}

    async def test_is_a_502_where_the_gateway_does_not_answer_and_a_422_where_the_account_is_refused(self, start):
        down = AccountUnreachable(DOWN)
        assert (await start(account=Reading(down)).call("/account")).status_code == 502
        resp = await start(account=Reading(AccountRefused("several accounts on this login"))).call("/account")
        assert resp.status_code == 422
        assert resp.json() == {"detail": "several accounts on this login"}
