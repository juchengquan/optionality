from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from optionality.notification import full_html_document
from optionality.service.deps import get_session, get_session_factory, get_worker
from optionality.service.models import ConfigDoc, Report, Run
from optionality.service.worker import Worker, create_run

router = APIRouter(prefix="/runs", tags=["runs"])

SessionDep = Annotated[Session, Depends(get_session)]
SessionFactoryDep = Annotated[object, Depends(get_session_factory)]
WorkerDep = Annotated[Worker, Depends(get_worker)]


class RunIn(BaseModel):
    task: Literal["strategy", "holdings"]
    config: str
    notify: bool = False


def _to_dict(row: Run) -> dict:
    return {
        "id": row.id,
        "task_type": row.task_type,
        "config_name": row.config_name,
        "trigger": row.trigger,
        "notify": row.notify,
        "attempt": row.attempt,
        "status": row.status,
        "error": row.error,
        "created_at": str(row.created_at),
        "started_at": str(row.started_at) if row.started_at else None,
        "finished_at": str(row.finished_at) if row.finished_at else None,
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
def list_runs(session: SessionDep, status: str | None = None, limit: int = 50):
    query = select(Run).order_by(Run.created_at.desc()).limit(min(limit, 500))
    if status:
        query = query.where(Run.status == status)
    return [_to_dict(r) for r in session.scalars(query).all()]


@router.get("/{run_id}")
def get_run(run_id: str, session: SessionDep):
    row = session.get(Run, run_id)
    if row is None:
        raise HTTPException(status_code=404, detail="run not found")
    return _to_dict(row)


def _get_report(run_id: str, session: Session) -> Report:
    report = session.get(Report, run_id)
    if report is None:
        raise HTTPException(status_code=404, detail="report not found")
    return report


@router.get("/{run_id}/report")
def get_report(run_id: str, session: SessionDep):
    return _get_report(run_id, session).summary


@router.get("/{run_id}/report.html")
def get_report_html(run_id: str, session: SessionDep):
    return HTMLResponse(full_html_document(_get_report(run_id, session).html))
