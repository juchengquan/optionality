from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from optionality.notification import full_html_document
from optionality.service.deps import get_session, get_session_factory, get_settings, get_worker
from optionality.service.models import ConfigDoc, Report, Run
from optionality.service.settings import Settings
from optionality.service.timefmt import display_time
from optionality.service.worker import Worker, create_run

router = APIRouter(prefix="/runs", tags=["runs"])

SessionDep = Annotated[Session, Depends(get_session)]
SessionFactoryDep = Annotated[object, Depends(get_session_factory)]
WorkerDep = Annotated[Worker, Depends(get_worker)]
SettingsDep = Annotated[Settings, Depends(get_settings)]


class RunIn(BaseModel):
    task: Literal["strategy", "holdings"]
    config: str
    notify: bool = False


def _to_dict(row: Run, tz: str) -> dict:
    return {
        "id": row.id,
        "task_type": row.task_type,
        "config_name": row.config_name,
        "trigger": row.trigger,
        "notify": row.notify,
        "attempt": row.attempt,
        "status": row.status,
        "error": row.error,
        "created_at": display_time(row.created_at, tz),
        "started_at": display_time(row.started_at, tz),
        "finished_at": display_time(row.finished_at, tz),
    }


@router.post("", status_code=202)
def trigger_run(payload: RunIn, session: SessionDep, session_factory: SessionFactoryDep, worker: WorkerDep):
    config = session.scalar(select(ConfigDoc).where(ConfigDoc.name == payload.config))
    if config is None:
        raise HTTPException(status_code=404, detail=f"config '{payload.config}' not found")
    if config.task_type != payload.task:
        raise HTTPException(
            status_code=422,
            detail=f"config '{payload.config}' is a '{config.task_type}' config, not '{payload.task}'",
        )
    run_id = create_run(
        session_factory,
        task_type=payload.task,
        config_name=payload.config,
        trigger="api",
        notify=payload.notify,
    )
    worker.submit(run_id)
    return {"run_id": run_id, "status": "queued"}


@router.get("")
def list_runs(session: SessionDep, settings: SettingsDep, status: str | None = None, limit: int = 50):
    query = select(Run).order_by(Run.created_at.desc()).limit(min(limit, 500))
    if status:
        query = query.where(Run.status == status)
    return [_to_dict(r, settings.display_tz) for r in session.scalars(query).all()]


@router.get("/{run_id}")
def get_run(run_id: str, session: SessionDep, settings: SettingsDep):
    row = session.get(Run, run_id)
    if row is None:
        raise HTTPException(status_code=404, detail="run not found")
    return _to_dict(row, settings.display_tz)


def _get_report(run_id: str, session: Session) -> Report:
    report = session.get(Report, run_id)
    if report is None:
        raise HTTPException(status_code=404, detail="report not found")
    return report


@router.get("/{run_id}/report")
def get_report(run_id: str, session: SessionDep):
    return _get_report(run_id, session).summary


@router.get("/{run_id}/details")
def get_run_details(run_id: str, session: SessionDep, code: str | None = None):
    details = _get_report(run_id, session).summary.get("details") or []
    if code:
        details = [d for d in details if d.get("code") == code]
    return details


@router.get("/{run_id}/report.html")
def get_report_html(run_id: str, session: SessionDep):
    return HTMLResponse(full_html_document(_get_report(run_id, session).html))
