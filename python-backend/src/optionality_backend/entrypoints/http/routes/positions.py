"""`/positions` — what is actually held, as distinct from what is watched (ADR 0009, phase 5). Port
of backend/src/entrypoints/http/routes/positions.ts — PARTLY: see the last paragraph.

A Position is a holding: it exists whether or not anything watches it, and deleting an alarm must
never delete the record of what you own (ADR 0001). That asymmetry is the whole reason legs live here
and not on a Monitor.

**Where the Python differs, and why.** An answer is shaped by the route's `response_model`, which is
how FastAPI validates what a route returns — the TypeScript's `documented(...).reply`, which parses
every answer through the very schema it documents. Two settings make pydantic refuse what zod refuses
instead of coercing it, and both matter because the answer is built from stored rows nothing else
vouches for: `strict`, so a strike stored as the text "8050" or as `true` is refused rather than read
as a number, and `allow_inf_nan=False`, because zod 4's `z.number()` refuses an infinity that SQLite's
REAL can hold. A refused answer is a 500 `{"detail": "internal error"}`, as a zod parse failing inside
`reply` is. The JSON may spell a number differently from `JSON.stringify` (`8050.0` for `8050`); it is
the same double, and the door scenarios compare values. The stored legs are read by
`db.values.from_sqlite_json`, which is `JSON.parse` — Python's own `json` reads a bare `NaN`.

**Partly ported** (ADR 0021, phase 3, the tracer): only `GET /positions`. `/values`, `/:id/vol`,
`POST`, `PATCH /:id` and `DELETE /:id` need modules still on the module map's backlog — `holdings`,
`hydrate`, `monitors`, `schemas/position`, `validate`, `openapi` and the other tables' queries — and
are ABSENT rather than stubbed, so the app answers each with its 404 and every scenario that asks for
one fails until its route lands. `tests/entrypoints/http/test_app.py`'s `NOT_YET` names them.
"""

from typing import Any, Literal

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict

from ....db.queries import list_positions
from ....db.rows import PositionRow
from ....db.time import display_stored
from ....db.values import from_sqlite_json
from ..deps import Deps

#: zod's refusals: no coercion between types, and no number that is not finite
_AS_ZOD = ConfigDict(strict=True, allow_inf_nan=False)


class LegOut(BaseModel):
    """`side` as the two values, not a string: a stored leg that still said "sold" would otherwise be
    served as though nothing were wrong, and the dashboard would read it as long (ADR 0013)."""

    model_config = _AS_ZOD

    side: Literal["short", "long"]
    option_type: str
    strike: float


class PositionOut(BaseModel):
    model_config = _AS_ZOD

    id: str
    name: str
    strategy: str | None
    strike_date: str
    contracts: float
    entry: float | None
    legs: list[LegOut]
    created_at: str | None
    #: the day it was PUT ON, which created_at is not. None until declared (ADR 0011).
    opened_at: str | None


def position_routes(deps: Deps) -> APIRouter:
    db, settings = deps.db, deps.settings
    tz = settings.display_tz

    def out(row: PositionRow) -> dict[str, Any]:
        return {
            "id": row["id"],
            "name": row["name"],
            "strategy": row["strategy"],
            "strike_date": row["strike_date"],
            "contracts": row["contracts"],
            "entry": row["entry"],
            "legs": from_sqlite_json(row["legs"]),
            "created_at": display_stored(row["created_at"], tz),
            # a plain date, NOT display_stored: created_at is an instant and converts to DISPLAY_TZ,
            # while Opened is the calendar day a trade was put on and has no time to convert
            "opened_at": row["opened_at"],
        }

    router = APIRouter()

    # `async def`, as every route here must be: a plain `def` runs in FastAPI's threadpool, off the
    # one loop, and the database refuses a thread that did not open it (db/open.py)
    @router.get("", summary="List positions", response_model=list[PositionOut])
    async def list_() -> list[dict[str, Any]]:
        return [out(r) for r in list_positions(db)]

    return router
