from typing import Annotated, Literal

from apscheduler.schedulers.background import BackgroundScheduler
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from optionality.service.deps import get_scheduler, get_session, get_session_factory, get_worker
from optionality.service.models import ConfigDoc, Schedule
from optionality.service.scheduler import refresh_jobs, validate_cron
from optionality.service.worker import Worker

router = APIRouter(prefix="/schedules", tags=["schedules"])

SessionDep = Annotated[Session, Depends(get_session)]
SessionFactoryDep = Annotated[object, Depends(get_session_factory)]
SchedulerDep = Annotated[BackgroundScheduler, Depends(get_scheduler)]
WorkerDep = Annotated[Worker, Depends(get_worker)]


class ScheduleIn(BaseModel):
    cron_expr: str
    tz: str = "America/New_York"
    task_type: Literal["strategy", "holdings"]
    config_name: str
    enabled: bool = True


def _validate(payload: ScheduleIn, session: Session) -> None:
    try:
        validate_cron(payload.cron_expr, payload.tz)
    except ValueError as err:
        raise HTTPException(status_code=422, detail=str(err)) from err
    if not session.scalar(select(ConfigDoc).where(ConfigDoc.name == payload.config_name)):
        raise HTTPException(status_code=422, detail=f"config '{payload.config_name}' does not exist")


def _to_dict(row: Schedule) -> dict:
    return {
        "id": row.id,
        "cron_expr": row.cron_expr,
        "tz": row.tz,
        "task_type": row.task_type,
        "config_name": row.config_name,
        "enabled": row.enabled,
    }


@router.get("")
def list_schedules(session: SessionDep):
    return [_to_dict(r) for r in session.scalars(select(Schedule).order_by(Schedule.id)).all()]


@router.post("", status_code=201)
def create_schedule(
    payload: ScheduleIn,
    session: SessionDep,
    session_factory: SessionFactoryDep,
    scheduler: SchedulerDep,
    worker: WorkerDep,
):
    _validate(payload, session)
    row = Schedule(**payload.model_dump())
    session.add(row)
    session.commit()
    refresh_jobs(scheduler, session_factory, worker)
    return _to_dict(row)


@router.put("/{schedule_id}")
def update_schedule(
    schedule_id: int,
    payload: ScheduleIn,
    session: SessionDep,
    session_factory: SessionFactoryDep,
    scheduler: SchedulerDep,
    worker: WorkerDep,
):
    row = session.get(Schedule, schedule_id)
    if row is None:
        raise HTTPException(status_code=404, detail="schedule not found")
    _validate(payload, session)
    for field, value in payload.model_dump().items():
        setattr(row, field, value)
    session.commit()
    refresh_jobs(scheduler, session_factory, worker)
    return _to_dict(row)


@router.delete("/{schedule_id}", status_code=204)
def delete_schedule(
    schedule_id: int,
    session: SessionDep,
    session_factory: SessionFactoryDep,
    scheduler: SchedulerDep,
    worker: WorkerDep,
):
    row = session.get(Schedule, schedule_id)
    if row is None:
        raise HTTPException(status_code=404, detail="schedule not found")
    session.delete(row)
    session.commit()
    refresh_jobs(scheduler, session_factory, worker)
