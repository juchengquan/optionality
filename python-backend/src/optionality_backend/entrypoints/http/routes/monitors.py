"""`/monitors` and `/quotes` (ADR 0009, phase 5). Port of backend/src/entrypoints/http/routes/monitors.ts.

A Monitor exists to warn, never to record what you own (CONTEXT.md). That is why creating one links it
to whatever Position already holds its contracts rather than bringing a Position into being, and why
deleting one leaves the Position alone.

**Where the Python differs, and why.**

- **An answer goes through the route's `response_model`**, strict as zod is (`routes/positions.py`
  says why), and a refused one is the 500 a zod parse failing inside `reply` is — except on `/quotes`,
  whose TypeScript parses its reply INSIDE the `try` that turns a failure into the Provider's 502.
  So that route validates its answer itself, inside its own `try`, and a quote figure zod would refuse
  is a 502 here too — whose `detail` after "<provider> call failed: " is pydantic's account of the
  refusal rather than zod's.
- **zod's `.optional()` leaves an absent key absent**, and a model sets every field it declares: a
  watchlist row answered `"legs": null` on every single-leg rule. `/quotes` answers with
  `response_model_exclude_unset`, so what the entry did not carry stays out — and the quote is a
  LOOSE object (`extra="allow"`), whose named fields are typed and whose others pass through, as
  `z.looseObject` does.
- **PATCH reads "absent" as None.** zod omits an absent key from what it parsed and refuses an
  explicit null, and so does `MonitorPatch` (`schemas/zod.py`), so None here can only mean "not sent" —
  which is what the TypeScript's `!== undefined` asks.
- **The exit policy is read here** from Settings, as `engine/health.py` reads its two: the library's
  `exitPolicy` reader takes the service's Settings and the Python library leaves it out.
- A number is answered as a double, so `8050` may be spelled `8050.0`; the door scenarios compare
  values (`routes/positions.py`).
"""

from typing import Annotated, Any, Literal, cast

from fastapi import APIRouter, Depends, Path, Response
from optionality.exit import ExitPolicy
from pydantic import BaseModel, ConfigDict, TypeAdapter

from ....create_monitor import (
    ComboInput,
    ComboLeg,
    CreateDeps,
    CreateFault,
    SingleInput,
    create_combo_monitor,
    create_single_monitor,
    is_fault,
)
from ....db.open import atomic
from ....db.queries import (
    clear_monitor_links,
    delete_monitor_row,
    find_monitor,
    find_monitor_by_code_field,
    list_monitors,
    positions_for_monitors,
    update_monitor_fields,
)
from ....db.rows import MonitorRow, PositionRow
from ....db.time import display_stored
from ....db.values import from_sqlite_bool, from_sqlite_json, to_sqlite_bool
from ....env import Settings
from ....monitors import apply_total_entry, watchlist_quotes
from ....schemas.monitor import (
    ComboMonitorIn,
    MonitorCreateIn,
    MonitorIn,
    MonitorPatch,
    TotalEntryIn,
    is_combo,
    monitor_create_member,
    patch_threshold_error,
    threshold_error,
)
from ....watchlist import WatchlistEntry
from ..deps import Deps
from ..errors import http_error, not_found, provider_failed
from ..validate import valid

#: zod's refusals: no coercion between types, and no number that is not finite
_AS_ZOD = ConfigDict(strict=True, allow_inf_nan=False)


class LegOut(BaseModel):
    model_config = _AS_ZOD

    sign: float
    option_type: str
    strike: float


class PositionRefOut(BaseModel):
    model_config = _AS_ZOD

    id: str
    name: str


class MonitorOut(BaseModel):
    model_config = _AS_ZOD

    id: str
    code: str
    strike_date: str
    option_type: str
    strike: float
    field: str
    threshold: float
    direction: str
    compare: str
    legs: list[LegOut] | None
    enabled: bool
    scope: str | None
    positions: list[PositionRefOut]
    disabled_reason: str | None
    triggered: bool
    last_value: float | None
    last_checked_at: str | None
    created_at: str | None


class TotalEntryOut(BaseModel):
    model_config = _AS_ZOD

    ok: Literal[True]


def _exit_policy(settings: Settings) -> ExitPolicy:
    """The library's `exitPolicy`, which reads Settings: the three knobs, from `.env`."""
    return ExitPolicy(
        take_fraction=settings.exit_take_fraction,
        stop_multiple=settings.exit_stop_multiple,
        manage_by_dte=settings.exit_manage_by_dte,
    )


def monitor_routes(deps: Deps) -> APIRouter:
    db, settings = deps.db, deps.settings
    tz = settings.display_tz

    def out(row: MonitorRow, owned: dict[str, list[PositionRow]] | None = None) -> dict[str, Any]:
        return {
            "id": row["id"],
            "code": row["code"],
            "strike_date": row["strike_date"],
            "option_type": row["option_type"],
            "strike": row["strike"],
            "field": row["field"],
            "threshold": row["threshold"],
            "direction": row["direction"],
            "compare": row["compare"],
            "legs": None if row["legs"] is None else from_sqlite_json(row["legs"]),
            "enabled": from_sqlite_bool(row["enabled"]),
            "scope": row["scope"],
            "positions": [{"id": p["id"], "name": p["name"]} for p in (owned or {}).get(row["id"], [])],
            "disabled_reason": row["disabled_reason"],
            "triggered": from_sqlite_bool(row["triggered"]),
            "last_value": row["last_value"],
            "last_checked_at": display_stored(row["last_checked_at"], tz),
            "created_at": display_stored(row["created_at"], tz),
        }

    def one(row: MonitorRow) -> dict[str, Any]:
        """One row, with the holdings linked to it READ BACK rather than assumed.

        Every write answers through this. `out` alone defaults the map to empty, which is right for a
        batch — the list route reads all the links in one query — and wrong for a single reply: it
        answered `positions: []` beside the `scope: "all"` the same transaction had just set, so the
        reply contradicted itself and a client re-rendering a row from it lost the holding's name and
        its leg badge. One extra query per write, on the id that was just written.
        """
        return out(row, positions_for_monitors(db, [row["id"]]))

    #: What create_monitor.py needs, which is the database, one Provider, a clock and the ids.
    creating = CreateDeps(db=db, fetch_quotes=deps.provider.fetch_quotes, now=deps.now, new_id=deps.new_id)

    router = APIRouter()

    # `async def`, as every route here must be: a plain `def` runs in FastAPI's threadpool, off the one
    # loop, and the database refuses a thread that did not open it (db/open.py)
    @router.get("", summary="List monitors", response_model=list[MonitorOut])
    async def list_() -> list[dict[str, Any]]:
        rows = list_monitors(db)
        owned = positions_for_monitors(db, [r["id"] for r in rows])
        return [out(r, owned) for r in rows]

    @router.post("", summary="Create a monitor, single or combo", status_code=201, response_model=MonitorOut)
    async def create(
        payload: Annotated[ComboMonitorIn | MonitorIn, Depends(valid("json", MonitorCreateIn, monitor_create_member))],
    ) -> dict[str, Any]:
        # the payload shape decides: single-leg (option_type + strike) or combo (name + legs).
        # `monitor_create_member` put the same question before validating, so a refusal is the chosen
        # shape's own rather than the union's "Invalid input"
        if is_combo(payload):
            c = cast(ComboMonitorIn, payload)
            result = await create_combo_monitor(
                creating,
                ComboInput(
                    name=c.name,
                    strike_date=c.strike_date,
                    legs=[ComboLeg(sign=leg.sign, option_type=leg.option_type, strike=leg.strike) for leg in c.legs],
                    field=c.field,
                    threshold=c.threshold,
                    direction=c.direction,
                    compare=c.compare,
                    enabled=c.enabled,
                ),
            )
        else:
            p = cast(MonitorIn, payload)
            result = await create_single_monitor(
                creating,
                SingleInput(
                    strike_date=p.strike_date,
                    option_type=p.option_type,
                    strike=p.strike,
                    field=p.field,
                    threshold=p.threshold,
                    direction=p.direction,
                    compare=p.compare,
                    enabled=p.enabled,
                ),
            )
        return reply(result)

    def reply(result: MonitorRow | CreateFault) -> dict[str, Any]:
        """Both faults and the row come back as values (create_monitor.py); this is where they become
        statuses. 422 for anything the rule itself is wrong about, 409 for a rule that is already there
        — the wording is the API's, as the bot's is the bot's."""
        if not is_fault(result):
            return one(cast(MonitorRow, result))
        if result.kind == "duplicate":
            raise http_error(409, f"monitor for ({result.code}, {result.field}) already exists")
        if result.kind == "threshold":
            # never None: create_monitor refused this threshold by the same rule
            raise http_error(422, cast(str, threshold_error(result.compare, result.threshold)))
        raise http_error(422, result.message)

    @router.patch("/{id}", summary="Update a monitor", response_model=MonitorOut)
    async def update(
        id_: Annotated[str, Path(alias="id")],
        given: Annotated[MonitorPatch, Depends(valid("json", MonitorPatch))],
    ) -> dict[str, Any]:
        # An absent key means "leave it", not "set it to None". zod omits an absent key from the parsed
        # object altogether, and rejects an explicit null outright, so what arrives is exactly what was
        # sent — and `MonitorPatch` refuses a null as zod does, so None below is only ever "not sent".
        if not given.model_fields_set:
            raise http_error(422, "nothing to update")
        row = find_monitor(db, id_)
        if row is None:
            raise not_found("monitor")

        changes: dict[str, Any] = {}
        if given.name is not None:
            if row["legs"] is None:
                raise http_error(
                    422, "only combo monitors can be renamed; a single-leg code is derived from its contract"
                )
            if given.name != row["code"] and find_monitor_by_code_field(db, given.name, row["field"], id_):
                raise http_error(409, f"monitor for ({given.name}, {row['field']}) already exists")
            changes["code"] = given.name
        compare = given.compare if given.compare is not None else row["compare"]
        threshold = given.threshold if given.threshold is not None else row["threshold"]
        why = patch_threshold_error(compare, threshold)
        if why:
            raise http_error(422, why)
        field = given.field if given.field is not None else row["field"]
        code = changes.get("code", row["code"])
        if field != row["field"] and find_monitor_by_code_field(db, code, field, id_):
            raise http_error(409, f"monitor for ({code}, {field}) already exists")
        if given.threshold is not None:
            changes["threshold"] = given.threshold
        if given.direction is not None:
            changes["direction"] = given.direction
        if given.field is not None:
            changes["field"] = given.field
        if given.compare is not None:
            changes["compare"] = given.compare
        if given.enabled is not None:
            changes["enabled"] = to_sqlite_bool(given.enabled)
            # re-enabling clears the reason; disabling by hand records that it was by hand, so the
            # sweeper's own quarantine and expiry notices are not overwritten by a manual toggle
            changes["disabled_reason"] = None if given.enabled else "manual"
        return one(update_monitor_fields(db, id_, changes))

    @router.post("/{id}/total-entry", summary="Spread a total entry across the holding", response_model=TotalEntryOut)
    async def total_entry(
        id_: Annotated[str, Path(alias="id")],
        given: Annotated[TotalEntryIn, Depends(valid("json", TotalEntryIn))],
    ) -> dict[str, Any]:
        if find_monitor(db, id_) is None:
            raise not_found("monitor")
        why = await apply_total_entry(db, id_, given.entry)
        if why:
            raise http_error(422, why)
        return {"ok": True}

    @router.delete("/{id}", summary="Delete a monitor", status_code=204)
    async def remove(id_: Annotated[str, Path(alias="id")]) -> Response:
        if find_monitor(db, id_) is None:
            raise not_found("monitor")

        # monitor_positions is a plain table SQLAlchemy never managed, and it is not managed here
        # either: the links must go first or the foreign key refuses the delete. Every row in the live
        # database is linked, so this is not a rare path (#70).
        #
        # The Position itself stays. It is a holding: it exists whether or not anything watches it, and
        # nothing in this service deletes one as a side effect (ADR 0001).
        def clear() -> None:
            clear_monitor_links(db, id_)
            delete_monitor_row(db, id_)

        await atomic(db, clear)
        return Response(status_code=204)

    return router


class QuoteOut(BaseModel):
    """The contract's live figures, as a watchlist row carries them.

    A loose object: the fields named here are the ones the dashboard and the bot read, and they are
    typed because the service KNOWS they are numbers — each Provider maps its own vendor's figures onto
    these names. Whatever else the Provider returns passes through untouched, for a human reading
    JSON.

    Declared at all because of what phase 8 found: the frontend used to declare `mid_price?: number`
    while the service promised nothing of the kind, so the hand-written interface was a claim rather
    than a fact."""

    model_config = ConfigDict(strict=True, allow_inf_nan=False, extra="allow")

    code: str | None = None
    name: str | None = None
    update_time: str | None = None
    fetched_at: str | None = None
    mid_price: float | None = None
    bid_price: float | None = None
    ask_price: float | None = None
    last_price: float | None = None
    option_delta: float | None = None
    option_gamma: float | None = None
    option_theta: float | None = None
    option_vega: float | None = None
    option_implied_volatility: float | None = None
    option_contract_size: float | None = None


class ScheduleOut(BaseModel):
    """The exit schedule, None where there is no single declared holding to schedule (ADR 0011)."""

    model_config = _AS_ZOD

    dte_at_open: float
    #: the holding this schedule is FOR, so a client never has to infer it from `positions`
    position_id: str
    on_pace: float | None
    pace_gap: float | None
    target: float | None
    stop: float | None
    target_dte: float | None
    manage_by_dte: float
    #: which Level the Cost to close has reached, None for neither (CONTEXT.md: Level)
    reached: Literal["target", "stop"] | None
    manage_by_due: bool


class EntryOut(BaseModel):
    """One watchlist row: everything needed to draw it, with no arithmetic left for the client.

    `option_type` is CALL or PUT, and CMB for a combo — named here as well as on the entry because the
    model DROPS what it does not list: a field computed in the service and left out of the schema
    vanishes between the two with nothing failing. `triggered` is breaching NOW, by the figures in this
    same row; the engine's own verdict and its last value live on /monitors, which is what that
    endpoint is for (ADR 0010)."""

    model_config = _AS_ZOD

    id: str
    code: str
    strike_date: str
    option_type: str
    field: str
    threshold: float
    direction: str
    compare: str
    triggered: bool
    quote: QuoteOut | None
    legs: list[LegOut] | None = None
    combo_value: float | None = None
    combo_greeks: dict[str, float | None] | None = None
    error: str | None = None
    dte: float
    scope: str | None
    positions: list[PositionRefOut]
    #: the ids of the combos in this watchlist whose legs include this row's Contract, sorted; empty on a
    #: combo's row. DISCOVERED from the legs each combo names, as `positions` is from what is held, and
    #: recorded nowhere: it is what sits a short leg's rule under its spread (ADR 0023).
    in_combos: list[str]
    cost_to_close: float | None
    schedule: ScheduleOut | None
    entry: float | None
    pnl: float | None
    fill: float | None
    #: the figure this row is about: the one reading `fill` and `triggered` are drawn from, raw and SIGNED —
    #: under compare "abs" those measure its magnitude. None where it was not priced, or where JSON cannot
    #: write it; an infinite reading still rings.
    watched: float | None
    #: how far `watched` has still to move to breach, in the field's own units: wherever it is a number, at
    #: or below zero exactly when `triggered`, and negative by how far past. None wherever `watched` is,
    #: which says nothing about the bell.
    distance: float | None


_ENTRIES = TypeAdapter(list[EntryOut])


def _as_json(entry: WatchlistEntry) -> dict[str, Any]:
    """An entry as the JSON the schema reads: its legs are the library's models."""
    if "legs" not in entry:
        return dict(entry)
    return {**entry, "legs": [leg.model_dump() for leg in entry["legs"]]}


def quote_routes(deps: Deps) -> APIRouter:
    """`/quotes` — a live call for the whole watchlist, and the DASHBOARD is its main caller: one batch
    per poll per open tab, which is what makes polling faster cost something (ADR 0010). The bot's
    `/quotes`, `/greeks` and `/vol` answer the same question but go straight to `watchlist_quotes`
    rather than through this route."""
    router = APIRouter()

    @router.get(
        "/quotes",
        summary="Live quotes for the whole watchlist",
        response_model=list[EntryOut],
        response_model_exclude_unset=True,
    )
    async def quotes() -> list[EntryOut]:
        try:
            entries = await watchlist_quotes(
                deps.db,
                deps.settings.display_tz,
                deps.provider.fetch_quotes,
                include_combos=True,
                now=deps.now(),
                policy=_exit_policy(deps.settings),
            )
            # the reply's parse, inside the try as the TypeScript's is (see the module's doc)
            return _ENTRIES.validate_python([_as_json(e) for e in entries])
        except Exception as err:
            raise provider_failed(deps.provider.name, err) from err

    return router
