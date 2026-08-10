from typing import Annotated, Literal

import pandas as pd
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from optionality.apis.aux import build_spx_code, normalize_strike_date
from optionality.notification import full_html_document
from optionality.service.deps import get_session, get_session_factory, get_settings, get_sweeper
from optionality.service.models import Monitor, utcnow
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
    threshold: float = Field(gt=0)  # abs-comparison: non-positive thresholds never/always fire
    direction: Literal["above", "below"] = "above"
    enabled: bool = True

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
    threshold: float = Field(gt=0)
    direction: Literal["above", "below"] = "above"
    enabled: bool = True

    @field_validator("strike_date")
    @classmethod
    def _normalize_date(cls, value: str) -> str:
        try:
            return normalize_strike_date(value)
        except ValueError as err:
            raise ValueError(f"invalid strike_date '{value}': use YYYY-MM-DD or YYYYMMDD") from err


class MonitorPatch(BaseModel):
    threshold: float | None = Field(default=None, gt=0)
    direction: Literal["above", "below"] | None = None
    field: str | None = None
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
        return watchlist_quotes(session_factory, settings, sweeper.fetcher)
    except Exception as err:
        raise HTTPException(status_code=502, detail=f"OpenD call failed: {err}") from err


@quotes_router.get("/quotes.html")
def get_watchlist_quotes_html(
    session_factory: Annotated[object, Depends(get_session_factory)],
    settings: Annotated[Settings, Depends(get_settings)],
    sweeper: Annotated[object, Depends(get_sweeper)],
):
    try:
        quotes = watchlist_quotes(session_factory, settings, sweeper.fetcher, include_combos=True)
    except Exception as err:
        raise HTTPException(status_code=502, detail=f"OpenD call failed: {err}") from err

    heading = f"<h2>Watchlist quotes</h2><p>as of {display_time(utcnow(), settings.display_tz)}</p>"
    if not quotes:
        return HTMLResponse(full_html_document(heading + "<p>Watchlist is empty.</p>"))

    field_column = {
        "option_delta": "delta",
        "option_gamma": "gamma",
        "option_theta": "theta",
        "option_vega": "vega",
        "option_implied_volatility": "IV",
        "mid_price": "mid",
    }
    rows = []
    for q in quotes:
        snap = q["snapshot"] or {}
        sign = "≤" if q["direction"] == "below" else "≥"
        row = {
            "contract": snap.get("name") or q["code"],
            "alarm": f"{q['field']} {sign} {q['threshold']}" + (" 🔔" if q["triggered"] else ""),
            "delta": snap.get("option_delta"),
            "gamma": snap.get("option_gamma"),
            "theta": snap.get("option_theta"),
            "vega": snap.get("option_vega"),
            "IV": snap.get("option_implied_volatility"),
            "mid": snap.get("mid_price"),
            "bid": snap.get("bid_price"),
            "ask": snap.get("ask_price"),
            "last trade": snap.get("update_time"),
        }
        if "legs" in q:
            # combo: only its own signed sum is honest — other columns would be
            # sign-convention-dependent aggregates masquerading as position greeks
            column = field_column.get(q["field"])
            if column and q["combo_value"] is not None:
                row[column] = q["combo_value"]
        rows.append(row)
    table = pd.DataFrame(rows).to_html(index=False, na_rep="—", float_format=lambda v: f"{v:.4g}")
    return HTMLResponse(full_html_document(heading + table))


@router.post("", status_code=201)
def create_monitor(payload: MonitorIn | ComboMonitorIn, session: SessionDep, settings: SettingsDep):
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
