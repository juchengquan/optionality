"""`/references` — the Securities kept on the page to read the market by (ADR 0018, 0019). Port of
backend/src/entrypoints/http/routes/references.ts.

Three doors and no more. There is no PATCH: a Reference is a code, a label and a source, and changing
any of them is a different Reference — the figure would be about something else. There is no "disable":
a Reference never alarms, so there is nothing to mute, and it is never auto-disabled, notified or
deleted. Removing one stays the owner's decision, which is what DELETE is.

GET declares no failure status, which is deliberate and is the point of `references.py`: this is the one
surface on the dashboard that cannot fail, because the page it decorates must still draw. A Provider
that is wholly down leaves every row a dash with its own sentence beside it.

**Where the Python differs, and why.** The answers are shaped by `response_model`, under the settings
that make pydantic refuse what zod refuses (`routes/positions.py` says why, at length): a figure, a
change or a minute count that is not a finite number is a 500 here, as zod's parse failing inside
`reply` is in the TypeScript. A Reference's `created_at` is answered as STORED, in UTC — the
TypeScript's `out` copies the column, where `/positions` converts its own to DISPLAY_TZ. DELETE answers
Hono's `c.body(null, 204)`: no body and no Content-Type, which a FastAPI route returning None would not.
"""

from dataclasses import asdict
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Path, Response
from optionality.timefmt import display_time
from pydantic import BaseModel, ConfigDict

from ....db.queries import delete_reference_row, find_reference, find_reference_by_code, insert_reference
from ....db.rows import ReferenceRow
from ....db.time import to_sql_datetime
from ....db.values import new_id
from ....ports import verify_contracts
from ....references import no_client, reference_readings
from ....schemas.reference import ReferenceIn
from ..deps import Deps
from ..errors import http_error, not_found
from ..validate import valid

#: zod's refusals: no coercion between types, and no number that is not finite
_AS_ZOD = ConfigDict(strict=True, allow_inf_nan=False)


class ReferenceOut(BaseModel):
    """One Reference as it is STORED, which is what a write answers with: the live figure belongs to the
    list, where it costs one bounded call for all of them at once."""

    model_config = _AS_ZOD

    id: str
    code: str
    label: str | None
    #: the vendor that answers for this code, which the strip shows (ADR 0019)
    source: str
    created_at: str


class ReadingOut(BaseModel):
    """One Reference with its live figure — everything needed to draw it, and the reason when there is
    nothing to draw. `ReferenceOut` less `created_at`, extended, as the TypeScript derives it."""

    model_config = _AS_ZOD

    id: str
    code: str
    label: str | None
    source: str
    #: the Security's own name as the Provider gives it, None where no quote arrived
    name: str | None
    figure: float | None
    #: "mid_price" or "last_price": which number this is, so it can be checked against a broker screen.
    #: The mid leads because a last trade can be a session old (`optionality.reference`).
    field: str | None
    #: the day's move as a FRACTION of the previous close
    change: float | None
    #: why there is no figure, or None. A dash on the page and nothing more.
    error: str | None
    #: the vendor's own claim about freshness, or None where it made none — moomoo reports no grade, and
    #: False would read as "it told us this is live" (ADR 0019)
    delayed: bool | None
    last_known: bool | None
    #: minutes, where the vendor states them: Yahoo does, IBKR does not
    delayed_by_minutes: float | None
    #: when the service's call for it ANSWERED, in DISPLAY_TZ (#371): outside the session the dashboard
    #: reads the strip once and draws no figure without this time, so a frozen figure cannot be taken for
    #: a live one (ADR 0018, ADR 0023 amended 2026-11-13). The time of the READ, not of the figure: no
    #: vendor here says when its last trade was. In the zone and the format of `/positions/values`'
    #: `fetched_at`, but not the same moment: that one is read when its call is ASKED, so the two can
    #: differ by a call's length (up to a source's timeout).
    fetched_at: str


def reference_routes(deps: Deps) -> APIRouter:
    db = deps.db

    def out(row: ReferenceRow) -> dict[str, Any]:
        return {
            "id": row["id"],
            "code": row["code"],
            "label": row["label"],
            "source": row["source"],
            "created_at": row["created_at"],
        }

    # The vendors this build can reach, by name — assembled once by the vendor door, the Provider among
    # them. A source is reachable when a client for it EXISTS: handing a Reference a fetcher belonging to
    # another vendor is the mutation that survived until the registry made the difference observable.
    sources = deps.sources

    router = APIRouter()

    @router.get("", summary="Live figures for every Reference", response_model=list[ReadingOut])
    async def list_() -> list[dict[str, Any]]:
        readings = await reference_readings(db, sources)
        # after the call, not before it, unlike `/positions/values`: a source that takes its whole timeout
        # was read when it answered (`test_references.py` holds which)
        fetched = display_time(deps.now(), deps.settings.display_tz)
        return [{**asdict(entry), "fetched_at": fetched} for entry in readings]

    @router.post("", summary="Keep a Security on the page", status_code=201, response_model=ReferenceOut)
    async def create(given: Annotated[ReferenceIn, Depends(valid("json", ReferenceIn))]) -> dict[str, Any]:
        code, label, source = given.code, given.label, given.source
        # the database before the Provider, as `create_monitor.py` does and for the same reason:
        # everything free comes before anything that costs a bounded call
        if find_reference_by_code(db, code) is not None:
            raise http_error(409, f"{code} is already kept on the page")
        # the same strict live probe that gates monitor creation: a Reference on a code nothing can quote
        # is a permanent dash, and finding that out at creation is better than on the page. Both of its
        # refusals are a 422 — "does not exist" and "the Provider did not confirm it", which since ADR
        # 0018 no longer claims an outage about a Provider that declined the security. That is exactly
        # what `US..SPX` gets.
        # the probe goes to the NAMED vendor, not to the Provider: a code IBKR knows and moomoo refuses
        # is exactly why a Reference may name its own source (ADR 0019)
        fetch = sources.get(source)
        # the same sentence `references.py` puts on the strip for a configured source this build cannot
        # reach, from one definition rather than two that can drift apart
        if fetch is None:
            raise http_error(422, no_client(source))
        why = await verify_contracts([code], fetch)
        if why is not None:
            raise http_error(422, why)
        row: ReferenceRow = {
            "id": (deps.new_id or new_id)(),
            "code": code,
            "label": label,
            "source": source,
            "created_at": to_sql_datetime(deps.now()),
        }
        return out(insert_reference(db, row))

    @router.delete("/{id}", summary="Stop keeping a Security on the page", status_code=204)
    async def remove(id_: Annotated[str, Path(alias="id")]) -> Response:
        if find_reference(db, id_) is None:
            raise not_found("reference")
        # nothing links to a Reference — no rule reads one, and nothing is derived from one — so there is
        # no link table to clear first and no transaction to wrap this in
        delete_reference_row(db, id_)
        return Response(status_code=204)

    return router
