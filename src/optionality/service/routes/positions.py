from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from optionality.apis.aux import normalize_strike_date
from optionality.service.deps import get_session, get_settings, get_sweeper
from optionality.service.models import Position, utcnow
from optionality.service.monitor import fetch_resilient, verify_contracts
from optionality.service.position import (
    contract_size,
    cost_to_close,
    position_greek,
    position_leg_codes,
    position_pnl,
)
from optionality.service.settings import Settings
from optionality.service.timefmt import display_time

router = APIRouter(prefix="/positions", tags=["positions"])

SessionDep = Annotated[Session, Depends(get_session)]
SettingsDep = Annotated[Settings, Depends(get_settings)]
SweeperDep = Annotated[object, Depends(get_sweeper)]

# greeks are linear in the legs, so an exposure-signed sum is the greek OF the position.
# IV is intensive and never summed — the same rule combos hold to.
POSITION_GREEK_FIELDS = ("option_delta", "option_gamma", "option_theta", "option_vega")

POSITION_ORDER = (Position.strike_date, Position.name)


class LegIn(BaseModel):
    side: Literal["sold", "bought"]
    option_type: Literal["CALL", "PUT"]
    strike: float


class PositionIn(BaseModel):
    name: str
    strike_date: str
    legs: list[LegIn] = Field(min_length=1)  # a single held option is a position too
    entry: float
    contracts: int = Field(default=1, ge=1)
    strategy: str | None = None

    @field_validator("strike_date")
    @classmethod
    def _normalize_date(cls, value: str) -> str:
        try:
            return normalize_strike_date(value)
        except ValueError as err:
            raise ValueError(f"invalid strike_date '{value}': use YYYY-MM-DD or YYYYMMDD") from err


def _to_dict(row: Position, tz: str) -> dict:
    return {
        "id": row.id,
        "name": row.name,
        "strategy": row.strategy,
        "strike_date": row.strike_date,
        "contracts": row.contracts,
        "entry": row.entry,
        "legs": row.legs,
        "created_at": display_time(row.created_at, tz),
    }


@router.get("")
def list_positions(session: SessionDep, settings: SettingsDep):
    rows = session.scalars(select(Position).order_by(*POSITION_ORDER)).all()
    return [_to_dict(r, settings.display_tz) for r in rows]


@router.get("/values")
def position_values(session: SessionDep, settings: SettingsDep, sweeper: SweeperDep):
    """Live cost to close, exposure and P&L for every position.

    One bounded snapshot call for every leg of every position, deduped — a documented
    live-call exception, like /quotes.
    """
    rows = session.scalars(select(Position).order_by(*POSITION_ORDER)).all()
    if not rows:
        return []
    codes = sorted({code for r in rows for code in position_leg_codes(r)})
    try:
        records, _bad = fetch_resilient(codes, settings, sweeper.fetcher)
    except Exception as err:
        raise HTTPException(status_code=502, detail=f"OpenD call failed: {err}") from err
    by_code = {r.get("code"): r for r in records}
    fetched = display_time(utcnow(), settings.display_tz)
    return [
        {
            **_to_dict(r, settings.display_tz),
            "cost_to_close": cost_to_close(r, by_code),
            "pnl": position_pnl(r, by_code),
            "contract_size": contract_size(by_code),
            "greeks": {f: position_greek(r, by_code, f) for f in POSITION_GREEK_FIELDS},
            "fetched_at": fetched,
        }
        for r in rows
    ]


@router.post("", status_code=201)
def create_position(payload: PositionIn, session: SessionDep, settings: SettingsDep, sweeper: SweeperDep):
    if session.scalar(select(Position).where(Position.name == payload.name)):
        raise HTTPException(status_code=409, detail=f"position '{payload.name}' already exists")
    row = Position(
        name=payload.name,
        strategy=payload.strategy,
        strike_date=payload.strike_date,
        contracts=payload.contracts,
        entry=payload.entry,
        legs=[leg.model_dump() for leg in payload.legs],
    )
    # strict gate, as for monitors: nothing enters the table unverified
    if error := verify_contracts(sorted(set(position_leg_codes(row))), settings, sweeper.fetcher):
        raise HTTPException(status_code=422, detail=error)
    session.add(row)
    session.commit()
    return _to_dict(row, settings.display_tz)


@router.delete("/{position_id}", status_code=204)
def delete_position(position_id: str, session: SessionDep):
    row = session.get(Position, position_id)
    if row is None:
        raise HTTPException(status_code=404, detail="position not found")
    session.delete(row)
    session.commit()
