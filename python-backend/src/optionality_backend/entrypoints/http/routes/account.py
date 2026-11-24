"""`/account` — the IBKR account, as IBKR marks it (ADR 0030, #470): its totals and every holding, stocks
and options apart. Read-only and stored nowhere; held while asked and answered from memory, released
`ACCOUNT_HELD_FOR_MS` after the last read (ADR 0031, #477). What it decides is `account.py`'s. Port of
backend/src/entrypoints/http/routes/account.ts.

**Where the Python differs, and why.** The answer is shaped by `response_model`, under the settings that
make pydantic refuse what zod refuses (`routes/positions.py` says why); the numbers are `float`, zod's
`z.number()`.
"""

from typing import Any, Literal

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict

from ....account import AccountBook, AccountDeps
from ..deps import Deps
from ..errors import http_error

#: zod's refusals: no coercion between types, and no number that is not finite
_AS_ZOD = ConfigDict(strict=True, allow_inf_nan=False)


class HoldingOut(BaseModel):
    """A stock or an option as the library maps IBKR's PORTFOLIO_VALUE row, in its own currency."""

    model_config = _AS_ZOD

    #: IB's security type as sent: `STK` or `OPT` here
    sec_type: str
    symbol: str
    currency: str
    #: an option's expiry as IB sends it (`20261218`); None for a stock
    expiry: str | None
    #: an option's strike; None for a stock
    strike: float | None
    #: an option's side; None for a stock
    right: Literal["C", "P"] | None
    #: None where IB sends none, as for a stock
    multiplier: float | None
    #: signed: a short position is negative
    position: float | None
    #: IBKR's own mark, per share: the position's P&L stream's value / (position × multiplier) once it
    #: has spoken
    market_price: float | None
    #: the position's value at that mark, in `currency`: its P&L stream's once it has spoken
    market_value: float | None
    #: per share: IB's average cost divided by the multiplier
    average_cost: float | None
    #: its P&L stream's once it has spoken
    unrealized_pnl: float | None
    realized_pnl: float | None
    #: today's, from its P&L stream; None before it speaks, or where IB sent it unset
    daily_pnl: float | None


class OtherOut(BaseModel):
    """A holding that is neither a stock nor an option — a future, a bond, a forex balance."""

    model_config = _AS_ZOD

    sec_type: str
    symbol: str
    position: float | None
    market_value: float | None
    currency: str


class TotalsOut(BaseModel):
    """In the base currency; each None where the gateway sent none. The P&L is the account's P&L stream's
    once it has spoken, the account updates' until then; `daily_pnl` the stream's alone."""

    model_config = _AS_ZOD

    net_liquidation: float | None
    total_cash: float | None
    unrealized_pnl: float | None
    realized_pnl: float | None
    daily_pnl: float | None


class LiveOut(BaseModel):
    model_config = _AS_ZOD

    updated_at: str


class AccountOut(BaseModel):
    model_config = _AS_ZOD

    #: the account id, masked
    account: str
    #: an IBKR paper account
    paper: bool
    #: the currency the totals are in; None where the gateway did not say
    base_currency: str | None
    #: the gateway's account update time as it sent it: a time of day, no date; None where none came
    updated_at: str | None
    #: when the service answered, in the display zone
    read_at: str
    totals: TotalsOut
    #: IBKR's exchange rates, by currency code: units of the base currency per ONE unit of it, the base
    #: currency itself 1
    exchange_rates: dict[str, float]
    #: security type STK
    stocks: list[HoldingOut]
    #: security type OPT
    options: list[HoldingOut]
    #: anything else
    other: list[OtherOut]
    #: when the account's P&L stream last spoke, in the display zone; None before it first speaks
    live: LiveOut | None


def account_routes(deps: Deps) -> APIRouter:
    # one per app, so every caller reads the one hold
    book = AccountBook(
        AccountDeps(
            source=deps.account,
            wanted=deps.settings.ibkr_account,
            now=deps.now,
            display_tz=deps.settings.display_tz,
        )
    )
    router = APIRouter()

    @router.get(
        "",
        summary="The IBKR account as IBKR marks it: totals, stocks, options and anything else; held while asked, "
        "released 90s after the last read",
        response_model=AccountOut,
    )
    async def read() -> dict[str, Any]:
        result = await book.read()
        if result.fault is not None:
            raise http_error(result.fault.status, result.fault.message)
        assert result.answer is not None
        return result.answer

    return router
