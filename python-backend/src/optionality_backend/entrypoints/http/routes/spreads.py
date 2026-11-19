"""`/spreads` — a spread and its Monitors added in one step, all or nothing (#293, ADR 0023); and
`/spreads/quote`, any SPX structure priced live in one bounded call (#452, ADR 0027). Port of
backend/src/entrypoints/http/routes/spreads.ts.

Not a resource of its own: what it writes are Positions and Monitors, which their own routes list, edit
and delete. It exists because a condor and the rules that watch it are one decision for the owner and
were four requests for the dashboard, and a refusal half way through left half a condor behind. What it
decides, and in what order, is `create_spread.py`'s.

**Where the Python differs, and why.** The answer is shaped by `response_model`, under the settings that
make pydantic refuse what zod refuses (`routes/positions.py` says why). `spread` is read from the query
as Starlette parsed it — every value of the key, in order, a `+` decoded as a space as Hono decodes it —
rather than declared as a FastAPI parameter, whose refusals would be its own: the grammar's words are
`price_spreads.py`'s, in both backends.
"""

from dataclasses import asdict
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, ConfigDict

from ....create_spread import SpreadDeps, create_spreads, is_spread_fault
from ....price_spreads import PricerDeps, SpreadPricer
from ....schemas.spread import SpreadsIn
from ..deps import Deps
from ..errors import http_error, provider_failed
from ..validate import valid
from .monitors import LastCloseOut, StrikeDistanceOut
from .positions import PayoffAtOut

#: zod's refusals: no coercion between types, and no number that is not finite
_AS_ZOD = ConfigDict(strict=True, allow_inf_nan=False)


class _AddedPosition(BaseModel):
    model_config = _AS_ZOD

    id: str
    name: str


class _AddedMonitor(BaseModel):
    model_config = _AS_ZOD

    id: str
    code: str
    field: str


class AddedOut(BaseModel):
    """What was added, by id and name: the page reads the book afresh rather than an echo of it."""

    model_config = _AS_ZOD

    positions: list[_AddedPosition]
    monitors: list[_AddedMonitor]
    #: the watch rules a held spread replaced: deleted, with the holding's own made in their place
    replaced: list[_AddedMonitor]


class _LegQuoteOut(BaseModel):
    """One leg as priced: as asked, the quote's figures, its mid by `mid_price`'s one rule, why it has none,
    and its last stored regular-session close beside it — never summed into anything."""

    model_config = _AS_ZOD

    side: Literal["short", "long"]
    option_type: Literal["CALL", "PUT"]
    strike: float
    qty: float
    code: str
    bid_price: float | None
    ask_price: float | None
    mid_price: float | None
    option_implied_volatility: float | None
    option_delta: float | None
    option_gamma: float | None
    option_theta: float | None
    option_vega: float | None
    option_contract_size: float | None
    fetched_at: str | None
    #: unknown contract, no quote returned, or no two-sided quote; None where the leg has a mid
    error: str | None
    last_known: LastCloseOut | None


class _NaturalOut(BaseModel):
    model_config = _AS_ZOD

    bid: float
    ask: float


class _GreeksOut(BaseModel):
    model_config = _AS_ZOD

    option_delta: float | None
    option_gamma: float | None
    option_theta: float | None
    option_vega: float | None


class _ServedPayoffOut(BaseModel):
    """`PayoffOut`, with the three figures a shape cannot have nullable."""

    model_config = _AS_ZOD

    at_strikes: list[PayoffAtOut]
    slope_below: float
    slope_above: float
    breakevens: list[float] | None
    max_profit: float | None
    max_loss: float | None


class _StructureQuoteOut(BaseModel):
    """One structure, priced from the request's one batch (ADR 0027)."""

    model_config = _AS_ZOD

    expiry: str
    dte: float
    #: the Entry given, points per contract, a credit positive; None where none was
    entry: float | None
    legs: list[_LegQuoteOut]
    #: the signed mid sum under the legs' signs and quantities; None where any leg has no mid
    value: float | None
    #: the worst fill each way, signed as `value`: `ask` to open, `bid` to close
    natural: _NaturalOut | None
    #: signed sums, never IV; each None where any leg lacks it
    greeks: _GreeksOut
    spx: float | None
    spx_reason: str | None
    short_strikes: list[StrikeDistanceOut]
    payoff: _ServedPayoffOut | None
    payoff_basis: Literal["entry", "mid", "shape"] | None
    #: why the structure has no figures: a contract the Provider does not know
    error: str | None


class SpreadsQuoteOut(BaseModel):
    model_config = _AS_ZOD

    phase: Literal["regular", "curb", "overnight", "closed"]
    fetched_at: str | None
    spreads: list[_StructureQuoteOut]


def spread_routes(deps: Deps) -> APIRouter:
    adding = SpreadDeps(db=deps.db, fetch_quotes=deps.provider.fetch_quotes, now=deps.now, new_id=deps.new_id)
    # one per app, so every caller — an agent's GET, the MCP door's — shares its batches and its cap
    # (ADR 0027)
    pricer = SpreadPricer(
        PricerDeps(
            db=deps.db,
            fetch_quotes=deps.provider.fetch_quotes,
            now=deps.now,
            display_tz=deps.settings.display_tz,
            calls_per_30s=deps.settings.spread_quote_calls_per_30s,
        )
    )
    router = APIRouter()

    @router.get(
        "/quote",
        summary="Price any SPX structures live, in one bounded Provider call, capped service-wide",
        response_model=SpreadsQuoteOut,
    )
    async def quote(request: Request) -> dict[str, Any]:
        priced = await pricer.price(request.query_params.getlist("spread"))
        if priced.refused is not None:
            raise http_error(priced.refused.status, priced.refused.message)
        if priced.failed is not None:
            raise provider_failed(deps.provider.name, priced.failed)
        assert priced.answer is not None
        return priced.answer

    @router.post(
        "",
        summary="Add spreads, each held or watched, with their Monitors: all of it or none",
        status_code=201,
        response_model=AddedOut,
    )
    async def create(given: Annotated[SpreadsIn, Depends(valid("json", SpreadsIn))]) -> dict[str, Any]:
        result = await create_spreads(adding, given)
        if is_spread_fault(result):
            raise http_error(result.status, result.message)
        return asdict(result)

    return router
