from typing import Annotated, Literal

from fastapi import APIRouter, Body, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from optionality.apis.aux import build_spx_code, normalize_strike_date
from optionality.service.deps import get_session, get_session_factory, get_settings, get_sweeper
from optionality.service.models import Monitor
from optionality.service.monitor import WATCHLIST_ORDER, watchlist_quotes
from optionality.service.settings import Settings
from optionality.service.timefmt import display_time

router = APIRouter(prefix="/monitors", tags=["monitors"])
quotes_router = APIRouter(tags=["quotes"])

SessionDep = Annotated[Session, Depends(get_session)]
SettingsDep = Annotated[Settings, Depends(get_settings)]


class MonitorIn(BaseModel):
    strike_date: str
    option_type: Literal["CALL", "PUT"]
    strike: float
    field: str = "option_delta"
    threshold: float
    direction: Literal["above", "below"] = "above"
    compare: Literal["abs", "signed"] = "abs"
    enabled: bool = True

    @model_validator(mode="after")
    def _check_threshold(self):
        if self.compare == "abs" and self.threshold <= 0:
            raise ValueError("threshold must be positive when compare='abs' (values are compared as absolutes)")
        if self.compare == "signed" and self.threshold == 0:
            raise ValueError("signed threshold cannot be 0 (zero-width hysteresis band); use e.g. ±0.01")
        return self

    @field_validator("strike_date")
    @classmethod
    def _normalize_date(cls, value: str) -> str:
        try:
            return normalize_strike_date(value)
        except ValueError as err:
            raise ValueError(f"invalid strike_date '{value}': use YYYY-MM-DD or YYYYMMDD") from err


class ComboLegIn(BaseModel):
    sign: Literal[1, -1]
    option_type: Literal["CALL", "PUT"]
    strike: float


class ComboMonitorIn(BaseModel):
    name: str
    strike_date: str
    legs: list[ComboLegIn] = Field(min_length=2)
    field: str = "mid_price"
    threshold: float
    direction: Literal["above", "below"] = "above"
    compare: Literal["abs", "signed"] = "abs"
    enabled: bool = True

    @model_validator(mode="after")
    def _check_threshold(self):
        if self.compare == "abs" and self.threshold <= 0:
            raise ValueError("threshold must be positive when compare='abs' (values are compared as absolutes)")
        if self.compare == "signed" and self.threshold == 0:
            raise ValueError("signed threshold cannot be 0 (zero-width hysteresis band); use e.g. ±0.01")
        return self

    @field_validator("strike_date")
    @classmethod
    def _normalize_date(cls, value: str) -> str:
        try:
            return normalize_strike_date(value)
        except ValueError as err:
            raise ValueError(f"invalid strike_date '{value}': use YYYY-MM-DD or YYYYMMDD") from err


class MonitorPatch(BaseModel):
    threshold: float | None = None
    direction: Literal["above", "below"] | None = None
    field: str | None = None
    compare: Literal["abs", "signed"] | None = None
    enabled: bool | None = None


def _build_code(payload: MonitorIn) -> str:
    try:
        return build_spx_code(payload.strike_date, payload.option_type, payload.strike)
    except ValueError as err:
        raise HTTPException(status_code=422, detail=f"invalid strike_date: {err}") from err


def _to_dict(row: Monitor, tz: str) -> dict:
    return {
        "id": row.id,
        "code": row.code,
        "strike_date": row.strike_date,
        "option_type": row.option_type,
        "strike": row.strike,
        "field": row.field,
        "threshold": row.threshold,
        "direction": row.direction,
        "compare": row.compare,
        "legs": row.legs,
        "enabled": row.enabled,
        "triggered": row.triggered,
        "last_value": row.last_value,
        "last_checked_at": display_time(row.last_checked_at, tz),
        "created_at": display_time(row.created_at, tz),
    }


@router.get("")
def list_monitors(session: SessionDep, settings: SettingsDep):
    rows = session.scalars(select(Monitor).order_by(*WATCHLIST_ORDER)).all()
    return [_to_dict(r, settings.display_tz) for r in rows]


@quotes_router.get("/quotes")
def get_watchlist_quotes(
    session_factory: Annotated[object, Depends(get_session_factory)],
    settings: Annotated[object, Depends(get_settings)],
    sweeper: Annotated[object, Depends(get_sweeper)],
):
    try:
        return watchlist_quotes(session_factory, settings, sweeper.fetcher, include_combos=True)
    except Exception as err:
        raise HTTPException(status_code=502, detail=f"OpenD call failed: {err}") from err


_MONITOR_EXAMPLES = {
    "single-leg": {
        "summary": "Single-leg monitor",
        "description": "Watch one contract's field against a threshold.",
        "value": {
            "strike_date": "2026-09-18",
            "option_type": "CALL",
            "strike": 8100,
            "field": "option_delta",
            "threshold": 0.6,
            "direction": "above",
        },
    },
    "combo": {
        "summary": "Combo monitor (e.g. iron condor)",
        "description": "Signed sum over legs; + on sold legs and - on bought legs watches the cost to close.",
        "value": {
            "name": "sep-condor",
            "strike_date": "2026-09-18",
            "legs": [
                {"sign": 1, "option_type": "CALL", "strike": 8100},
                {"sign": -1, "option_type": "CALL", "strike": 8150},
                {"sign": 1, "option_type": "PUT", "strike": 7800},
                {"sign": -1, "option_type": "PUT", "strike": 7750},
            ],
            "field": "mid_price",
            "threshold": 30,
            "direction": "below",
        },
    },
}


@router.post("", status_code=201)
def create_monitor(
    payload: Annotated[MonitorIn | ComboMonitorIn, Body(openapi_examples=_MONITOR_EXAMPLES)],
    session: SessionDep,
    settings: SettingsDep,
):
    """Create a monitor — the payload shape decides: single-leg (option_type + strike) or combo (name + legs)."""
    if isinstance(payload, ComboMonitorIn):
        return _create_combo(payload, session, settings)
    code = _build_code(payload)
    if session.scalar(select(Monitor).where(Monitor.code == code, Monitor.field == payload.field)):
        raise HTTPException(status_code=409, detail=f"monitor for ({code}, {payload.field}) already exists")
    row = Monitor(
        code=code,
        strike_date=payload.strike_date,
        option_type=payload.option_type,
        strike=payload.strike,
        field=payload.field,
        threshold=payload.threshold,
        direction=payload.direction,
        compare=payload.compare,
        enabled=payload.enabled,
    )
    session.add(row)
    session.commit()
    return _to_dict(row, settings.display_tz)


def _create_combo(payload: ComboMonitorIn, session: Session, settings: Settings):
    if session.scalar(select(Monitor).where(Monitor.code == payload.name, Monitor.field == payload.field)):
        raise HTTPException(status_code=409, detail=f"monitor for ({payload.name}, {payload.field}) already exists")
    row = Monitor(
        code=payload.name,
        strike_date=payload.strike_date,
        option_type="CMB",
        strike=0.0,
        field=payload.field,
        threshold=payload.threshold,
        direction=payload.direction,
        compare=payload.compare,
        legs=[leg.model_dump() for leg in payload.legs],
        enabled=payload.enabled,
    )
    session.add(row)
    session.commit()
    return _to_dict(row, settings.display_tz)


@router.put("/{monitor_id}")
def update_monitor(monitor_id: str, payload: MonitorIn, session: SessionDep, settings: SettingsDep):
    row = session.get(Monitor, monitor_id)
    if row is None:
        raise HTTPException(status_code=404, detail="monitor not found")
    if row.legs:
        raise HTTPException(status_code=422, detail="combo monitors cannot be edited in place; delete and recreate")
    code = _build_code(payload)
    conflict = session.scalar(
        select(Monitor).where(Monitor.code == code, Monitor.field == payload.field, Monitor.id != monitor_id)
    )
    if conflict:
        raise HTTPException(status_code=409, detail=f"monitor for ({code}, {payload.field}) already exists")
    row.code = code
    row.strike_date = payload.strike_date
    row.option_type = payload.option_type
    row.strike = payload.strike
    row.field = payload.field
    row.threshold = payload.threshold
    row.direction = payload.direction
    row.compare = payload.compare
    row.enabled = payload.enabled
    session.commit()
    return _to_dict(row, settings.display_tz)


@router.patch("/{monitor_id}")
def patch_monitor(monitor_id: str, payload: MonitorPatch, session: SessionDep, settings: SettingsDep):
    changes = payload.model_dump(exclude_none=True)
    if not changes:
        raise HTTPException(status_code=422, detail="nothing to update")
    row = session.get(Monitor, monitor_id)
    if row is None:
        raise HTTPException(status_code=404, detail="monitor not found")
    new_compare = changes.get("compare", row.compare)
    new_threshold = changes.get("threshold", row.threshold)
    if new_compare == "abs" and new_threshold <= 0:
        raise HTTPException(status_code=422, detail="threshold must be positive when compare='abs'")
    if new_compare == "signed" and new_threshold == 0:
        raise HTTPException(status_code=422, detail="signed threshold cannot be 0; use e.g. ±0.01")
    new_field = changes.get("field", row.field)
    if new_field != row.field:
        conflict = session.scalar(
            select(Monitor).where(Monitor.code == row.code, Monitor.field == new_field, Monitor.id != monitor_id)
        )
        if conflict:
            raise HTTPException(status_code=409, detail=f"monitor for ({row.code}, {new_field}) already exists")
    for key, value in changes.items():
        setattr(row, key, value)
    session.commit()
    return _to_dict(row, settings.display_tz)


@router.delete("/{monitor_id}", status_code=204)
def delete_monitor(monitor_id: str, session: SessionDep):
    row = session.get(Monitor, monitor_id)
    if row is None:
        raise HTTPException(status_code=404, detail="monitor not found")
    session.delete(row)
    session.commit()
