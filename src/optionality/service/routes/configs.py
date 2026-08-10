from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from optionality.core import load_config
from optionality.service.deps import get_session
from optionality.service.models import ConfigDoc, Schedule

router = APIRouter(prefix="/configs", tags=["configs"])

SessionDep = Annotated[Session, Depends(get_session)]


class ConfigIn(BaseModel):
    name: str
    task_type: Literal["strategy", "holdings"]
    body: dict


def _validate_body(task_type: str, body: dict) -> None:
    try:
        load_config(task_type, body)
    except ValidationError as err:
        raise HTTPException(status_code=422, detail=str(err)) from err


def _to_dict(row: ConfigDoc, with_body: bool = False) -> dict:
    data = {
        "name": row.name,
        "task_type": row.task_type,
        "created_at": str(row.created_at),
        "updated_at": str(row.updated_at),
    }
    if with_body:
        data["body"] = row.body
    return data


@router.get("")
def list_configs(session: SessionDep):
    rows = session.scalars(select(ConfigDoc).order_by(ConfigDoc.name)).all()
    return [_to_dict(r) for r in rows]


@router.post("", status_code=201)
def create_config(payload: ConfigIn, session: SessionDep):
    _validate_body(payload.task_type, payload.body)
    if session.scalar(select(ConfigDoc).where(ConfigDoc.name == payload.name)):
        raise HTTPException(status_code=409, detail=f"config '{payload.name}' already exists")
    row = ConfigDoc(name=payload.name, task_type=payload.task_type, body=payload.body)
    session.add(row)
    session.commit()
    return _to_dict(row, with_body=True)


@router.get("/{name}")
def get_config(name: str, session: SessionDep):
    row = session.scalar(select(ConfigDoc).where(ConfigDoc.name == name))
    if row is None:
        raise HTTPException(status_code=404, detail="config not found")
    return _to_dict(row, with_body=True)


@router.put("/{name}")
def update_config(name: str, payload: ConfigIn, session: SessionDep):
    row = session.scalar(select(ConfigDoc).where(ConfigDoc.name == name))
    if row is None:
        raise HTTPException(status_code=404, detail="config not found")
    _validate_body(payload.task_type, payload.body)
    row.task_type = payload.task_type
    row.body = payload.body
    session.commit()
    return _to_dict(row, with_body=True)


@router.delete("/{name}", status_code=204)
def delete_config(name: str, session: SessionDep):
    row = session.scalar(select(ConfigDoc).where(ConfigDoc.name == name))
    if row is None:
        raise HTTPException(status_code=404, detail="config not found")
    if session.scalar(select(Schedule).where(Schedule.config_name == name)):
        raise HTTPException(status_code=409, detail="config is referenced by a schedule")
    session.delete(row)
    session.commit()
