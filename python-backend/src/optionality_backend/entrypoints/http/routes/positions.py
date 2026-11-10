"""`/positions` — what is actually held, as distinct from what is watched (ADR 0009, phase 5). Port of
backend/src/entrypoints/http/routes/positions.ts.

A Position is a holding: it exists whether or not anything watches it, and deleting an alarm must
never delete the record of what you own (ADR 0001). That asymmetry is the whole reason legs live here
and not on a Monitor.

**Where the Python differs, and why.**

- **An answer is shaped by the route's `response_model`**, which is how FastAPI validates what a route
  returns — the TypeScript's `documented(...).reply`, which parses every answer through the very schema
  it documents. Two settings make pydantic refuse what zod refuses instead of coercing it, and both
  matter because the answer is built from stored rows nothing else vouches for: `strict`, so a strike
  stored as the text "8050" or as `true` is refused rather than read as a number, and
  `allow_inf_nan=False`, because zod 4's `z.number()` refuses an infinity that SQLite's REAL can hold.
  A refused answer is a 500 `{"detail": "internal error"}`, as a zod parse failing inside `reply` is.
  The JSON may spell a number differently from `JSON.stringify` (`8050.0` for `8050`); it is the same
  double, and the door scenarios compare values. The stored legs are read by
  `db.values.from_sqlite_json`, which is `JSON.parse` — Python's own `json` reads a bare `NaN`.
- **PATCH reads "absent" as None.** zod omits an absent key from what it parsed and refuses an explicit
  null, and so does `PositionPatch` (`schemas/zod.py`), so None here can only mean "not sent" — which is
  what the TypeScript's `!== undefined` asks.
- **The vol figure is answered under `from`**, a word Python cannot name a field: the library's
  `VolAttribution` keeps it as `from_` with `from` as its alias, and `VolOut` likewise.
- **A sample's map is checked for its shape before the library sees it**, as the TypeScript's is, and
  here it is also what keeps the request alive: the library's `VolSample` takes a map or None and
  refuses anything else, where the TypeScript's `volAttribution` would read an array as a map of
  nothing and answer null.
- **Hydrating validates** (`hydrate.py`, issue #266): a stored holding whose legs parse but are not legs
  is refused where it is read, so `/values` answers it with its 502 (`holdings.py` says why), and a
  POST or DELETE whose re-adoption reads it — whenever a rule is orphaned
  (`monitors.adopt_orphan_monitors`) — fails and rolls back where the TypeScript would cast the row and
  carry on. No door scenario holds a row like that.
- **The probe's codes are sorted as JavaScript sorts**, by UTF-16 code unit, as `holdings.py`'s are.
"""

from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Path, Response
from optionality.position import POSITION_GREEK_FIELDS, contract_size, position_greek, position_leg_codes
from optionality.timefmt import display_time
from optionality.vol import VolSample, vol_attribution
from pydantic import BaseModel, ConfigDict, Field

from ....db.open import atomic
from ....db.queries import (
    clear_position_links,
    clear_position_samples,
    clear_scope_of_orphans,
    delete_position_row,
    find_position,
    find_position_by_name,
    insert_position,
    list_position_samples,
    list_positions,
    update_position_fields,
)
from ....db.rows import PositionRow
from ....db.time import display_stored, to_sql_datetime
from ....db.values import from_sqlite_json, new_id, to_sqlite_json
from ....holdings import holding_values
from ....hydrate import to_position
from ....monitors import adopt_orphan_monitors
from ....ports import verify_contracts
from ....schemas.position import DEFAULT_CONTRACTS, PositionIn, PositionPatch
from ..deps import Deps
from ..errors import http_error, not_found, provider_failed
from ..validate import valid

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


class ScheduleOut(BaseModel):
    """The exit schedule, or None for a Position whose Opened nobody has declared — which is the opt-in,
    because nothing is inferred from created_at (ADR 0011)."""

    model_config = _AS_ZOD

    dte_at_open: float
    on_pace: float | None
    pace_gap: float | None
    target: float | None
    stop: float | None
    target_dte: float | None
    manage_by_dte: float
    #: which Level the Cost to close has reached, None for neither (CONTEXT.md: Level)
    reached: Literal["target", "stop"] | None
    manage_by_due: bool


class PositionValues(PositionOut):
    cost_to_close: float | None
    pnl: float | None
    contract_size: float | None
    greeks: dict[str, float | None]
    fetched_at: str | None
    #: days left where the option trades, the same reckoning the dashboard's column uses
    dte: float
    schedule: ScheduleOut | None


class VolOut(BaseModel):
    """What of a pace gap vol accounts for, measured over this holding's own samples — every field None
    together where the chain is not whole enough to say (ADR 0011)."""

    model_config = _AS_ZOD

    vol: float | None
    from_: str | None = Field(alias="from")
    to: str | None
    days: float | None


def _js_sorted(codes: set[str]) -> list[str]:
    """`[...codes].sort()`: by UTF-16 code unit, which is how JavaScript compares two strings."""
    return sorted(codes, key=lambda code: code.encode("utf-16-be", "surrogatepass"))


def _parse_map(text: str | None) -> dict[str, Any] | None:
    """A stored JSON map, or None — including when it will not parse. Written by the sweeper and read
    here, so the two are the only places that know the encoding."""
    if text is None:
        return None
    try:
        parsed = from_sqlite_json(text)
    except Exception:  # noqa: BLE001 — the TypeScript's bare `catch`: a corrupt map costs the figure
        return None
    # SHAPE only. A map holding a non-numeric reading used to give vol: NaN, which zod rejects, so the
    # route answered 500 where its own comment promises the figure costs nothing but itself. That is
    # fixed in vol_attribution, which requires every reading to be a finite number — and a value check
    # here as well was unobservable: a mutation sweep removed it and nothing failed, because the domain
    # guard catches the same values. One gate, where the rule lives, rather than two where only one is
    # tested.
    return parsed if isinstance(parsed, dict) else None


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

    @router.get(
        "/values", summary="Live value, P&L and exit schedule of every position", response_model=list[PositionValues]
    )
    async def values() -> list[dict[str, Any]]:
        """Live cost to close, exposure and P&L for every position.

        One bounded live call for every leg of every position, deduped. `Holdings.tsx` polls this while
        the panel is open, so it is a live call on the dashboard's path like `/quotes` — and CLAUDE.md's
        Provider invariant names it alongside the sweep, `/quotes` and the creation probes. It was a
        fifth exception in the code and a fourth in that sentence until 2026-10-17, when the list was
        corrected rather than the route; `/spx/quote` left the list in #199, which took the route with
        it."""
        now = deps.now()
        try:
            valued = await holding_values(db, deps.provider.fetch_quotes, now, deps.settings, tz)
        except Exception as err:
            raise provider_failed(deps.provider.name, err) from err
        by_code, held = valued.by_code, valued.values
        if not held:
            return []
        fetched = display_time(now, tz)
        return [
            {
                **out(v.row),
                "cost_to_close": v.cost,
                "pnl": v.pnl,
                "contract_size": contract_size(by_code),
                "greeks": {f: position_greek(v.position, by_code, f) for f in POSITION_GREEK_FIELDS},
                "fetched_at": fetched,
                "dte": v.dte,
                "schedule": v.schedule,
            }
            for v in held
        ]

    @router.get("/{id}/vol", summary="How much of the pace gap vol accounts for", response_model=VolOut)
    async def vol(id_: Annotated[str, Path(alias="id")]) -> dict[str, Any]:
        """What of this holding's pace gap vol accounts for (ADR 0011).

        The ONLY route that reads history — every other figure in this service comes from one live
        batch. Separate from `/quotes` on purpose: the dashboard polls that every 15 seconds per open
        tab and this changes once a market day, so the detail sheet asks for it when opened.

        The remainder is NOT returned, because it is not ours to compute: a caller subtracts this from
        the gap it is showing, which keeps the gap and the vol part from being measured against two
        different instants (ADR 0010).
        """
        row = find_position(db, id_)
        if row is None:
            raise not_found("position")
        samples = [
            VolSample(
                observed_on=s["observed_on"],
                dte=s["dte"],
                # a corrupt map costs the figure, never the request: the whole sheet would fail to load
                legs_iv=_parse_map(s["legs_iv"]),
                legs_vega=_parse_map(s["legs_vega"]),
            )
            for s in list_position_samples(db, id_)
        ]
        a = vol_attribution(samples, to_position(row))
        if a is None:
            return {"vol": None, "from": None, "to": None, "days": None}
        return a.model_dump(by_alias=True)

    @router.post("", summary="Create a position", status_code=201, response_model=PositionOut)
    async def create(p: Annotated[PositionIn, Depends(valid("json", PositionIn))]) -> dict[str, Any]:
        if find_position_by_name(db, p.name) is not None:
            raise http_error(409, f"position '{p.name}' already exists")
        row: PositionRow = {
            "id": (deps.new_id or new_id)(),
            "name": p.name,
            "strategy": p.strategy,
            "strike_date": p.strike_date,
            "contracts": p.contracts if p.contracts is not None else DEFAULT_CONTRACTS,
            "entry": p.entry,
            "legs": to_sqlite_json([leg.model_dump() for leg in p.legs]),
            "created_at": to_sql_datetime(deps.now()),
            "opened_at": p.opened_at,
            "manage_notified_at": None,
        }
        # strict gate, as for monitors: nothing enters the table unverified
        codes = _js_sorted(set(position_leg_codes(to_position(row))))
        error = await verify_contracts(codes, deps.provider.fetch_quotes)
        if error:
            raise http_error(422, error)

        def save() -> PositionRow:
            inserted = insert_position(db, row)
            # a holding you have just recorded may be the one an existing rule was already watching
            adopt_orphan_monitors(db)
            return inserted

        return out(await atomic(db, save))

    @router.patch("/{id}", summary="Update a position", response_model=PositionOut)
    async def update(
        id_: Annotated[str, Path(alias="id")],
        given: Annotated[PositionPatch, Depends(valid("json", PositionPatch))],
    ) -> dict[str, Any]:
        """Record what was taken in, after the fact."""
        if not given.model_fields_set:
            raise http_error(422, "nothing to update")
        if find_position(db, id_) is None:
            raise not_found("position")
        changes: dict[str, Any] = {}
        if given.entry is not None:
            changes["entry"] = given.entry
        if given.contracts is not None:
            changes["contracts"] = given.contracts
        if given.strategy is not None:
            changes["strategy"] = given.strategy
        if given.opened_at is not None:
            changes["opened_at"] = given.opened_at
        return out(update_position_fields(db, id_, changes))

    @router.delete("/{id}", summary="Delete a position", status_code=204)
    async def remove(id_: Annotated[str, Path(alias="id")]) -> Response:
        if find_position(db, id_) is None:
            raise not_found("position")

        # the same foreign-key fault the monitor side had: monitor_positions is a plain table, so the
        # links must go first or the DELETE is refused. Every Position in the live database is linked,
        # so this was broken for all of them (#71).
        #
        # `position_samples` is the THIRD time this key has bitten — #71 here, #81 in the sweep's expiry
        # path, and then ADR 0011 added a child table without touching this line, which made DELETE
        # refuse for every Position the moment the first sweep gave each of them a sample. Adding a
        # table that references this one means coming back here.
        #
        # The Monitors survive — nothing here deletes a rule as a side effect. They simply stop knowing
        # what they were watching, and would be adopted again if the holding came back. The samples do
        # NOT: they describe this holding and mean nothing without it.
        #
        # ...and then the rules this delete just orphaned get a chance at whatever is LEFT. A link is
        # otherwise only ever worked out when something is created, so a rule that lost its holding here
        # stayed orphaned for ever — reported from the live dashboard as `409 position '1120_BS_7100'
        # already exists`, on a rule showing no positions beside a holding that had an entry and an
        # opened date and covered its contracts exactly. The dashboard offered to create the holding it
        # already had, because nothing told it one was there.
        #
        # Safe by adopt_orphan_monitors's own design: it looks only at monitors with no link and only
        # ever adds. "What you already have cannot be taken away by something you subsequently hold" —
        # nor by something you subsequently drop. Inside the transaction, so a rule is never left
        # pointing at a row that is half gone.
        def clear() -> None:
            clear_position_links(db, id_)
            clear_position_samples(db, id_)
            delete_position_row(db, id_)
            adopt_orphan_monitors(db)
            # ...and whatever adoption could not place stops claiming a scope it has no holding for.
            #
            # The ORDER does not matter, though the first spelling of this comment claimed it did — a
            # mutation sweep swapped the two lines and nothing failed, which is how the claim was found.
            # It cannot matter: clearing skips anything with a link, and adoption always sets a scope
            # explicitly on what it places, so each line only ever touches rows the other leaves alone.
            # The link guard is the load-bearing part, not the sequence.
            clear_scope_of_orphans(db)

        await atomic(db, clear)
        return Response(status_code=204)

    return router
