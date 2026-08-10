from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, field_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from optionality.apis.aux import build_spx_code, normalize_strike_date
from optionality.service.deps import get_session, get_session_factory, get_settings, get_sweeper
from optionality.service.models import Monitor
from optionality.service.monitor import watchlist_quotes

router = APIRouter(prefix="/monitors", tags=["monitors"])

SessionDep = Annotated[Session, Depends(get_session)]


class MonitorIn(BaseModel):
    strike_date: str
    option_type: Literal["CALL", "PUT"]
    strike: float
    field: str = "option_delta"
    threshold: float
    enabled: bool = True

    @field_validator("strike_date")
    @classmethod
    def _normalize_date(cls, value: str) -> str:
        try:
            return normalize_strike_date(value)
        except ValueError as err:
            raise ValueError(f"invalid strike_date '{value}': use YYYY-MM-DD or YYYYMMDD") from err


def _build_code(payload: MonitorIn) -> str:
    try:
        return build_spx_code(payload.strike_date, payload.option_type, payload.strike)
    except ValueError as err:
        raise HTTPException(status_code=422, detail=f"invalid strike_date: {err}") from err


def _to_dict(row: Monitor) -> dict:
    return {
        "id": row.id,
        "code": row.code,
        "strike_date": row.strike_date,
        "option_type": row.option_type,
        "strike": row.strike,
        "field": row.field,
        "threshold": row.threshold,
        "enabled": row.enabled,
        "triggered": row.triggered,
        "last_value": row.last_value,
        "last_checked_at": str(row.last_checked_at) if row.last_checked_at else None,
        "created_at": str(row.created_at),
    }


@router.get("")
def list_monitors(session: SessionDep):
    return [_to_dict(r) for r in session.scalars(select(Monitor).order_by(Monitor.id)).all()]


@router.get("/quotes")
def get_watchlist_quotes(
    session_factory: Annotated[object, Depends(get_session_factory)],
    settings: Annotated[object, Depends(get_settings)],
    sweeper: Annotated[object, Depends(get_sweeper)],
):
    try:
        return watchlist_quotes(session_factory, settings, sweeper.fetcher)
    except Exception as err:
        raise HTTPException(status_code=502, detail=f"OpenD call failed: {err}") from err


@router.post("", status_code=201)
def create_monitor(payload: MonitorIn, session: SessionDep):
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
        enabled=payload.enabled,
    )
    session.add(row)
    session.commit()
    return _to_dict(row)


@router.put("/{monitor_id}")
def update_monitor(monitor_id: str, payload: MonitorIn, session: SessionDep):
    row = session.get(Monitor, monitor_id)
    if row is None:
        raise HTTPException(status_code=404, detail="monitor not found")
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
    row.enabled = payload.enabled
    session.commit()
    return _to_dict(row)


@router.delete("/{monitor_id}", status_code=204)
def delete_monitor(monitor_id: str, session: SessionDep):
    row = session.get(Monitor, monitor_id)
    if row is None:
        raise HTTPException(status_code=404, detail="monitor not found")
    session.delete(row)
    session.commit()
