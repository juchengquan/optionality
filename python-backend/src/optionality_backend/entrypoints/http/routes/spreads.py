"""`/spreads` — a spread and its Monitors added in one step, all or nothing (#293, ADR 0023). Port of
backend/src/entrypoints/http/routes/spreads.ts.

Not a resource of its own: what it writes are Positions and Monitors, which their own routes list, edit
and delete. It exists because a condor and the rules that watch it are one decision for the owner and
were four requests for the dashboard, and a refusal half way through left half a condor behind. What it
decides, and in what order, is `create_spread.py`'s.

**Where the Python differs, and why.** The answer is shaped by `response_model`, under the settings that
make pydantic refuse what zod refuses (`routes/positions.py` says why).
"""

from dataclasses import asdict
from typing import Annotated, Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict

from ....create_spread import SpreadDeps, create_spreads, is_spread_fault
from ....schemas.spread import SpreadsIn
from ..deps import Deps
from ..errors import http_error
from ..validate import valid

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


def spread_routes(deps: Deps) -> APIRouter:
    adding = SpreadDeps(db=deps.db, fetch_quotes=deps.provider.fetch_quotes, now=deps.now, new_id=deps.new_id)
    router = APIRouter()

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
