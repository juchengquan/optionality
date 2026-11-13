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
  `PaceExplained` keeps it as `from_` with `from` as its alias, and `VolOut` likewise.
- **A sample's map is checked for its shape before the library sees it**, as the TypeScript's is, and
  here it is also what keeps the request alive: the library's `PacedSample` takes a map or None and
  refuses anything else, where the TypeScript's `paceExplained` would read an array as a map of
  nothing and answer null.
- **Hydrating validates** (`hydrate.py`, issue #266): a stored holding whose legs parse but are not legs
  is refused where it is read, so `/values` answers it with its 502 (`holdings.py` says why), and a
  POST or DELETE whose re-adoption reads it — whenever a rule is orphaned
  (`monitors.adopt_orphan_monitors`) — fails and rolls back where the TypeScript would cast the row and
  carry on. No door scenario holds a row like that.
- **The probe's codes are sorted as JavaScript sorts**, by UTF-16 code unit, as `holdings.py`'s are.
"""

import math
import sqlite3
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Path, Response
from optionality.contract import build_spx_code
from optionality.exit import dte_at_open, exit_levels, on_pace
from optionality.expiry import market_date, sample_timing
from optionality.monitor import monitor_leg_codes
from optionality.payoff import payoff_at_expiry
from optionality.position import (
    POSITION_GREEK_FIELDS,
    Leg,
    Position,
    contract_size,
    leg_readings,
    position_greek,
    position_leg_codes,
    realized_points,
)
from optionality.quote import derived_spx, strike_distances
from optionality.timefmt import display_time
from optionality.vol import PacedSample, pace_explained
from pydantic import BaseModel, ConfigDict, Field

from ....correct_legs import Fault, before_correction, correct_quantities, corrected_legs
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
    monitors_watching,
    open_positions,
    update_monitor_fields,
    update_position_fields,
)
from ....db.rows import MonitorRow, PositionRow
from ....db.time import display_stored, to_sql_datetime
from ....db.values import from_sqlite_json, new_id, to_sqlite_bool, to_sqlite_json
from ....holdings import _exit_policy, holding_values
from ....hydrate import to_monitor, to_position
from ....monitors import adopt_orphan_monitors
from ....ports import verify_contracts
from ....schemas.monitor import DisabledReason
from ....schemas.position import (
    DEFAULT_CONTRACTS,
    ClosePositionIn,
    PayoffIn,
    PositionIn,
    PositionPatch,
    stored_qty,
)
from ..deps import Deps
from ..errors import http_error, not_found, provider_failed
from ..validate import valid
from .monitors import StrikeDistanceOut

#: zod's refusals: no coercion between types, and no number that is not finite
_AS_ZOD = ConfigDict(strict=True, allow_inf_nan=False)


class LegOut(BaseModel):
    """`side` as the two values, not a string: a stored leg that still said "sold" would otherwise be
    served as though nothing were wrong, and the dashboard would read it as long (ADR 0013)."""

    model_config = _AS_ZOD

    side: Literal["short", "long"]
    option_type: str
    strike: float
    #: how many of the Contract one of the holding holds; absent is 1 (#351), and absent is left out,
    #: as zod leaves out an optional key that is not there
    qty: float | None = Field(default=None, exclude_if=lambda v: v is None)


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
    #: the New York market day it was closed, or None while it is held (ADR 0022)
    closed_on: str | None
    #: what was paid to close it, per contract, in points; None where nobody said
    exit: float | None
    #: Entry less Exit across the contracts held, in POINTS — not P&L, which is money and needs a contract
    #: size only a Quote carries, while a closed holding is no longer quoted. None while it is held, and
    #: wherever either side is unknown (`realized_points`).
    realized_points: float | None


class DisabledMonitor(BaseModel):
    model_config = _AS_ZOD

    id: str
    code: str


class ClosedOut(PositionOut):
    """A close, answered: the holding as it now stands, and the rules the close switched off, so the page
    can say which without a second request."""

    disabled_monitors: list[DisabledMonitor]


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
    #: the share of the credit's Entry captured so far, (Entry − Cost to close) / Entry, unrounded: 1 is
    #: all of it kept and below 0 costs more to close than was taken in. None for a debit, which has no
    #: credit to keep and no Target, and wherever either side is unknown (ADR 0023).
    captured: float | None
    contract_size: float | None
    #: SPX's price as this response's one batch implies it, from its options' premiums (ADR 0024): the
    #: same on every holding, as `contract_size` is. None where the batch cannot give it, never a
    #: Reference's figure.
    spx: float | None
    #: why `spx` is None, in words; None when there is a figure
    spx_reason: str | None
    greeks: dict[str, float | None]
    #: each leg's OWN delta, contract code -> delta, from the same batch: what a short leg's Δ is read
    #: from, which `greeks` (a signed sum over the legs) cannot give. None when any leg's delta is
    #: missing, as the daily sample's map is (`leg_readings`, #318).
    legs_delta: dict[str, float] | None
    #: each SHORT leg placed against `spx`, in points and sigma, with its own delta (#297): what the strike
    #: strip draws. The strikes and deltas are there without an SPX; only the distances are None, and
    #: `spx_reason` says why.
    short_strikes: list[StrikeDistanceOut]
    fetched_at: str | None
    #: days left where the option trades, the same reckoning the dashboard's column uses
    dte: float
    schedule: ScheduleOut | None


class VolOut(BaseModel):
    """What of a pace gap vol accounts for, measured over this holding's own samples — the first four
    None together where the chain is not whole enough to say (ADR 0011) — and the gap it splits, at
    the close it runs to (`pace_explained`, #333)."""

    model_config = _AS_ZOD

    vol: float | None
    from_: str | None = Field(alias="from")
    to: str | None
    days: float | None
    reason: str | None
    at: str | None
    timing: Literal["close", "in-hours", "before-open", "after-close", "unrecorded"] | None
    gap: float | None
    gap_reason: str | None
    rest: float | None
    vega: float | None
    cover: float | None
    cover_reason: str | None


class SampleOut(BaseModel):
    """One Daily sample as stored (ADR 0011), with the day's On-pace beside it."""

    model_config = _AS_ZOD

    #: the New York market day it is that day's row for
    observed_on: str
    #: the instant it was observed, in DISPLAY_TZ; None on rows written before migration 0009, and where the
    #: stored stamp cannot be read (`timing` is then `unrecorded`)
    observed_at: str | None
    #: whether it is the day's close, and if not why (`sample_timing`): what the chart marks
    timing: Literal["close", "before-open", "after-close", "unrecorded"]
    dte: float
    cost_to_close: float
    #: what Cost to close would be at this DTE if only time had passed (`on_pace`); None without a schedule
    on_pace: float | None
    #: each leg's reading, contract code -> figure: None where the sweep withheld the map, and where a stored
    #: one cannot be read — a corrupt map costs its own figure, never the request
    legs_iv: dict[str, float] | None
    legs_vega: dict[str, float] | None
    legs_delta: dict[str, float] | None
    #: SPX's price as the writing sweep's batch implied it (ADR 0024), or None
    spx: float | None
    #: summed under quantities since corrected (#359): its Cost to close is the old structure's, kept as it
    #: was because nothing stored can re-sum it. Its IV, vega and delta are one contract's readings and stay
    #: true.
    before_correction: bool


class SampleLevelsOut(BaseModel):
    model_config = _AS_ZOD

    dte_at_open: float
    #: None for a debit, which has no credit to keep a fraction of
    target: float | None
    stop: float | None
    target_dte: float | None
    manage_by_dte: float


class PlanPointOut(BaseModel):
    model_config = _AS_ZOD

    dte: float
    on_pace: float


class SamplesOut(BaseModel):
    """A holding's recorded history, for the burndown and the IV chart (#295): every Daily sample to the day
    it closed, the Levels it is held against, and the planned decay at every DTE from the open to expiry —
    the service's figures, so no curve is computed in the browser."""

    model_config = _AS_ZOD

    #: None where Opened was never recorded: no schedule is inferred (ADR 0011)
    levels: SampleLevelsOut | None
    #: On-pace at each DTE from the open down to 0; empty without a schedule or an Entry
    plan: list[PlanPointOut]
    #: oldest first, none after the day it closed (ADR 0022)
    samples: list[SampleOut]
    #: when a held leg's quantity was last corrected, in DISPLAY_TZ, or None if never (#359)
    qty_corrected_at: str | None


class PayoffAtOut(BaseModel):
    model_config = _AS_ZOD

    spx: float
    pnl: float


class PayoffOut(BaseModel):
    """The payoff at expiry, in POINTS across the contracts (`payoff_at_expiry`, #291): the P&L at each
    strike and the slope beyond the outer two, its breakevens and its maximums. At expiry only (ADR 0023):
    no T+0 curve and no probability, because there is no pricing model to draw them with."""

    model_config = _AS_ZOD

    at_strikes: list[PayoffAtOut]
    slope_below: float
    slope_above: float
    breakevens: list[float]
    #: the highest P&L, or None where it has no ceiling
    max_profit: float | None
    #: the LOWEST P&L, signed (a loss is negative), or None where it has no floor
    max_loss: float | None


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
    # fixed in the library's vol measurement, which requires every reading to be a finite number — and a value check
    # here as well was unobservable: a mutation sweep removed it and nothing failed, because the domain
    # guard catches the same values. One gate, where the rule lives, rather than two where only one is
    # tested.
    return parsed if isinstance(parsed, dict) else None


def _leg_map(text: str | None) -> dict[str, Any] | None:
    """A stored map whose every reading is a finite number, or None: the chart draws each leg's figure, and
    one that is not a number would fail the answer's own schema. A boolean is no number, as `typeof` says."""
    parsed = _parse_map(text)
    if parsed is None:
        return None
    try:
        numbers = all(
            isinstance(v, int | float) and not isinstance(v, bool) and math.isfinite(v) for v in parsed.values()
        )
    except OverflowError:
        # an integer too long for a double, which JSON.parse reads as Infinity: not finite either
        return None
    return parsed if numbers else None


def _realized(row: PositionRow) -> float | None:
    """What a closed holding made, from the row's own figures. The legs play no part in it, so they are
    not parsed for it — a row this listing could always serve must not start failing because it was
    closed (`hydrate.py` validates where the TypeScript casts)."""
    held = Position(
        name=row["name"], strike_date=row["strike_date"], contracts=row["contracts"], entry=row["entry"], legs=()
    )
    return realized_points(held, row["exit"])


def _closed_on_fault(row: PositionRow, closed_on: str, opened_at: str | None, today: str) -> str | None:
    """Why a holding cannot have closed on this day, or None. Three bounds, the same for the close and for
    correcting one afterwards: not before it was opened, not after its expiry — nothing is held past one —
    and not after today in New York, since a close that has not happened yet is a plan. ISO dates compare
    as text."""
    if opened_at is not None and closed_on < opened_at:
        return f"closed on {closed_on}, before it was opened on {opened_at}"
    if closed_on > row["strike_date"]:
        return f"closed on {closed_on}, after its expiry on {row['strike_date']}"
    if closed_on > today:
        return f"closed on {closed_on}, after today ({today} in New York)"
    return None


def _held_codes(db: sqlite3.Connection) -> set[str]:
    """Every contract some OPEN holding holds."""
    return {code for p in open_positions(db) for code in position_leg_codes(to_position(p))}


def _still_held(monitor: MonitorRow, held: set[str]) -> bool:
    """Whether every contract a rule names is still held by something open. A row that cannot be read names
    nothing anyone can vouch for, so it reads as not held — the sweep would quarantine it anyway."""
    try:
        return all(code in held for code in monitor_leg_codes(to_monitor(monitor)))
    except Exception:  # noqa: BLE001 — the TypeScript's bare `catch`: whatever hydrating refuses with
        return False


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
            "closed_on": row["closed_on"],
            "exit": row["exit"],
            # only for a closed holding: an open one's result is its live P&L, which is /values' to say
            "realized_points": None if row["closed_on"] is None else _realized(row),
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
        spx = derived_spx(list(by_code.values()))
        return [
            {
                **out(v.row),
                "cost_to_close": v.cost,
                "pnl": v.pnl,
                "captured": v.captured,
                "contract_size": contract_size(by_code),
                "spx": spx.price,
                "spx_reason": spx.reason,
                "greeks": {f: position_greek(v.position, by_code, f) for f in POSITION_GREEK_FIELDS},
                "legs_delta": leg_readings(v.position, by_code, "option_delta"),
                "short_strikes": [
                    s.model_dump()
                    for s in strike_distances(
                        [
                            build_spx_code(v.position.strike_date, leg.option_type, leg.strike)
                            for leg in v.position.legs
                            if leg.side == "short"
                        ],
                        by_code,
                        spx.price,
                        v.dte,
                    )
                ],
                "fetched_at": fetched,
                "dte": v.dte,
                "schedule": v.schedule,
            }
            for v in held
        ]

    @router.get("/{id}/vol", summary="How much of the pace gap vol accounts for", response_model=VolOut)
    async def vol(id_: Annotated[str, Path(alias="id")]) -> dict[str, Any]:
        """What of this holding's pace gap vol accounts for (ADR 0011).

        One of the two routes that read history, with `/samples` (#295) — every other figure in this
        service comes from one live batch. Separate from `/quotes` on purpose: the dashboard polls that every 15 seconds per open
        tab and this changes once a market day, so the detail sheet asks for it when opened.

        The remainder IS returned since #333, with the gap it is the remainder of: both at the close
        the vol part runs to, so the three are measured at one instant and the dashboard computes none
        of them.
        """
        row = find_position(db, id_)
        if row is None:
            raise not_found("position")
        stored = list_position_samples(db, id_)
        samples = [
            PacedSample(
                observed_on=s["observed_on"],
                dte=s["dte"],
                cost_to_close=s["cost_to_close"],
                observed_at=s["observed_at"],
                # a corrupt map costs the figure, never the request: the whole sheet would fail to load
                legs_iv=_parse_map(s["legs_iv"]),
                legs_vega=_parse_map(s["legs_vega"]),
            )
            for s in stored
        ]
        explained = pace_explained(samples, to_position(row), deps.now()).model_dump(by_alias=True)
        # The vol part is re-measured under the legs as they now are, from per-contract readings, so a
        # correction leaves it true (#359). The gap is not: it is read off the last sample's stored Cost to
        # close, which a sample from before the correction summed under the old quantities.
        last = stored[-1] if stored else None
        if (
            explained["gap"] is None
            or last is None
            or not before_correction(last["observed_at"], row["qty_corrected_at"])
        ):
            return explained
        why = f"the Cost to close of {last['observed_on']} was summed before a leg's quantity was corrected"
        return {**explained, "gap": None, "gap_reason": why, "rest": None, "cover": None, "cover_reason": why}

    @router.get(
        "/{id}/samples",
        summary="A holding's daily samples, with its on-pace and its levels",
        response_model=SamplesOut,
    )
    async def samples(id_: Annotated[str, Path(alias="id")]) -> dict[str, Any]:
        """A holding's daily samples, open or closed (#295): what REVIEW's burndown and IV chart draw.

        Stored history, so no Provider call, and asked for once when REVIEW opens a holding, never polled.
        On-pace is `on_pace` at each sample's DTE and at every DTE to expiry, the same figure
        `/positions/values` serves today: the plan is the service's, never redrawn in the browser. A
        backdated close hides the later rows (`list_position_samples`, ADR 0022)."""
        row = find_position(db, id_)
        if row is None:
            raise not_found("position")
        opened_dte = None if row["opened_at"] is None else dte_at_open(row["strike_date"], row["opened_at"])
        levels = (
            None if opened_dte is None else exit_levels(row["entry"], opened_dte, opened_dte, _exit_policy(settings))
        )
        plan = []
        for dte in range(opened_dte if opened_dte is not None else -1, -1, -1):
            pace = on_pace(row["entry"], opened_dte, dte)
            if pace is not None:
                plan.append({"dte": dte, "on_pace": pace})
        return {
            "levels": None
            if levels is None or opened_dte is None
            else {
                "dte_at_open": opened_dte,
                "target": levels.target,
                "stop": levels.stop,
                "target_dte": levels.target_dte,
                "manage_by_dte": levels.manage_by_dte,
            },
            "plan": plan,
            "samples": [
                {
                    "observed_on": s["observed_on"],
                    # a stamp `sample_timing` cannot read is no instant to convert: it costs its own time,
                    # never the request (#295)
                    "observed_at": None if timing == "unrecorded" else display_stored(s["observed_at"], tz),
                    "timing": timing,
                    "dte": s["dte"],
                    "cost_to_close": s["cost_to_close"],
                    "on_pace": on_pace(row["entry"], opened_dte, s["dte"]),
                    "legs_iv": _leg_map(s["legs_iv"]),
                    "legs_vega": _leg_map(s["legs_vega"]),
                    "legs_delta": _leg_map(s["legs_delta"]),
                    "spx": s["spx"],
                    "before_correction": before_correction(s["observed_at"], row["qty_corrected_at"]),
                }
                for s in list_position_samples(db, id_)
                for timing in [sample_timing(s["observed_at"])]
            ],
            "qty_corrected_at": display_stored(row["qty_corrected_at"], tz),
        }

    @router.get("/{id}/payoff", summary="A holding's payoff at expiry", response_model=PayoffOut)
    async def payoff(id_: Annotated[str, Path(alias="id")]) -> dict[str, Any]:
        """A holding's payoff at expiry, from its legs, its Entry and its count — and nothing else: no
        quote, so no Provider call, and a closed holding answers as well as an open one."""
        row = find_position(db, id_)
        if row is None:
            raise not_found("position")
        # a curve is drawn at a credit; without one there is nothing honest to draw
        if row["entry"] is None:
            raise http_error(422, f"position '{row['name']}' has no entry: record what was taken in to draw its payoff")
        position = to_position(row)
        return payoff_at_expiry(list(position.legs), row["entry"], row["contracts"]).model_dump()

    @router.post(
        "/payoff",
        summary="The payoff at expiry of draft legs, saving nothing and asking no Provider",
        response_model=PayoffOut,
    )
    async def draft(p: Annotated[PayoffIn, Depends(valid("json", PayoffIn))]) -> dict[str, Any]:
        """The payoff at expiry of legs nobody holds yet (#291): the add form's preview and a watched
        spread drawn at its current value. A POST only because legs do not fit a query string: it writes
        NOTHING and asks the Provider NOTHING."""
        legs = [Leg(**leg.model_dump(exclude_none=True)) for leg in p.legs]
        contracts = p.contracts if p.contracts is not None else DEFAULT_CONTRACTS
        return payoff_at_expiry(legs, p.entry, contracts).model_dump()

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
            "legs": to_sqlite_json(
                [
                    {"side": leg.side, "option_type": leg.option_type, "strike": leg.strike, **stored_qty(leg.qty)}
                    for leg in p.legs
                ]
            ),
            "created_at": to_sql_datetime(deps.now()),
            "opened_at": p.opened_at,
            "manage_notified_at": None,
            # recorded as held; closing it later is a state of this row, not its removal (ADR 0022)
            "closed_on": None,
            "exit": None,
            "qty_corrected_at": None,
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
        row = find_position(db, id_)
        if row is None:
            raise not_found("position")
        # An exit and a close day belong to a closed holding, and are corrected here — a mistyped close is
        # otherwise fixable only by deleting, which loses the samples (ADR 0022). On a holding still held
        # they would half-close it, so they are refused.
        if row["closed_on"] is None and ("exit" in given.model_fields_set or given.closed_on is not None):
            raise http_error(422, f"position '{row['name']}' is not closed: close it first")
        # A quantity typed wrong is corrected on a holding still HELD; a closed one's legs are the record it
        # closed with, and its rules are no longer linked to follow it (#359)
        if row["closed_on"] is not None and given.legs is not None:
            raise http_error(
                422, f"position '{row['name']}' is closed: a leg's quantity is corrected only while it is held"
            )
        correction = None if given.legs is None else corrected_legs(row["name"], to_position(row).legs, given.legs)
        if isinstance(correction, Fault):
            raise http_error(422, correction.fault)
        if row["closed_on"] is not None:
            # the close's own bounds, against whatever this request leaves Opened at
            fault = _closed_on_fault(
                row,
                given.closed_on or row["closed_on"],
                given.opened_at or row["opened_at"],
                market_date(deps.now()),
            )
            if fault:
                raise http_error(422, fault)
        changes: dict[str, Any] = {}
        if given.entry is not None:
            changes["entry"] = given.entry
        if given.contracts is not None:
            changes["contracts"] = given.contracts
        if given.strategy is not None:
            changes["strategy"] = given.strategy
        if given.opened_at is not None:
            changes["opened_at"] = given.opened_at
        if "exit" in given.model_fields_set:  # a null clears it, so sent is not the same as not None
            changes["exit"] = given.exit
        if given.closed_on is not None:
            changes["closed_on"] = given.closed_on
        at = deps.now()

        def save() -> PositionRow:
            # one transaction: the legs, the rules that follow them, and the rest of the patch
            if correction is not None and correction.changed:
                correct_quantities(db, row, correction.legs, at)
            return update_position_fields(db, id_, changes)

        return out(await atomic(db, save))

    @router.post("/{id}/close", summary="Close a position, keeping it and its history", response_model=ClosedOut)
    async def close(
        id_: Annotated[str, Path(alias="id")],
        given: Annotated[ClosePositionIn, Depends(valid("json", ClosePositionIn))],
    ) -> dict[str, Any]:
        """Close a holding: it is no longer held, and it is KEPT (ADR 0022).

        Until this existed the only way off the dashboard was DELETE, which takes the daily samples with
        it — and a closed trade's history is exactly what a review of past trades reads. So a close is a
        state of the row: the legs, the entry and the samples stay, and everything live stops looking at
        it (`open_positions`).

        No market call. The exit is the owner's to say — the dashboard prefills it from the Cost to close
        it is already showing — and a close after the expiry could not be priced anyway.
        """
        row = find_position(db, id_)
        if row is None:
            raise not_found("position")
        if row["closed_on"] is not None:
            raise http_error(409, f"position '{row['name']}' is already closed")

        # Today in the market's reckoning, as Opened is — or the expiry, if that came first: nothing is
        # held past one, so an iron condor that expired worthless last week and is only told to the app
        # today was closed on its expiry, not today. ISO dates compare as text.
        today = market_date(deps.now())
        closed_on = given.closed_on or min(today, row["strike_date"])
        fault = _closed_on_fault(row, closed_on, row["opened_at"], today)
        if fault:
            raise http_error(422, fault)

        def shut() -> list[dict[str, str]]:
            watchers = monitors_watching(db, id_)
            update_position_fields(db, id_, {"closed_on": closed_on, "exit": given.exit})
            # The rules stop claiming the holding, exactly as a DELETE leaves them: nothing alive is ever
            # valued against a closed holding, because nothing alive is ever linked to one. A rule spanning
            # two holdings keeps its link to the one still held.
            clear_position_links(db, id_)
            # ...then the delete path's two steps, for the delete path's reason: a rule this orphaned may
            # watch a contract ANOTHER holding still holds — a roll leaves the old and the new sharing a
            # strike — and it is handed to that one; one that cannot be placed stops claiming a scope.
            # Adoption looks only at OPEN holdings, so never back onto this one.
            adopt_orphan_monitors(db)
            clear_scope_of_orphans(db)

            # Only THEN is it decided which rules go off. Deciding first was a bug a review found: a rule
            # switched off here and then adopted by the rolled holding was the new trade's alarm, silenced
            # as "holding-closed" with no notice. So a rule goes off when something it names is no longer
            # held by anything open: a leg rule on the closed holding alone, and a rule spanning two
            # holdings when either closes, since its figure would now include legs nobody holds (ADR 0004,
            # ADR 0022). One already off keeps its own reason — the owner's "manual", or the engine's
            # quarantine — so the close neither claims it nor hides why.
            held = _held_codes(db)
            taken: list[dict[str, str]] = []
            reason: DisabledReason = "holding-closed"
            for monitor in watchers:
                if not monitor["enabled"] or _still_held(monitor, held):
                    continue
                update_monitor_fields(db, monitor["id"], {"enabled": to_sqlite_bool(False), "disabled_reason": reason})
                taken.append({"id": monitor["id"], "code": monitor["code"]})
            return taken

        disabled = await atomic(db, shut)
        closed = find_position(db, id_)
        assert closed is not None  # written inside the transaction above
        return {**out(closed), "disabled_monitors": disabled}

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
