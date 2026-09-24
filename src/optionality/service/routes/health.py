import socket
from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from optionality.service.deps import get_session, get_settings, get_sweeper, get_worker
from optionality.service.models import Run
from optionality.service.monitor import MonitorSweeper
from optionality.service.settings import Settings
from optionality.service.timefmt import display_time
from optionality.service.worker import Worker

router = APIRouter(tags=["health"])


def _opend_reachable(host: str, port: int) -> bool:
    try:
        with socket.create_connection((host, port), timeout=1):
            return True
    except OSError:
        return False


@router.get("/health")
def health(
    session: Annotated[Session, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_settings)],
    worker: Annotated[Worker, Depends(get_worker)],
    sweeper: Annotated[MonitorSweeper, Depends(get_sweeper)],
):
    try:
        session.execute(text("SELECT 1"))
        db_ok = True
    except Exception:  # noqa: BLE001 - health must report, not raise
        db_ok = False

    last = session.scalar(select(Run).order_by(Run.created_at.desc()).limit(1))
    last_run = None
    if last is not None:
        last_run = {
            "id": last.id,
            "task_type": last.task_type,
            "status": last.status,
            "created_at": display_time(last.created_at, settings.display_tz),
        }

    return {
        "db": db_ok,
        "opend": _opend_reachable(settings.opend_host, settings.opend_port),
        "queue_depth": worker.queue_depth(),
        "last_run": last_run,
        "monitor": {
            "last_sweep_at": display_time(sweeper.last_sweep_at, settings.display_tz),
            "last_sweep_ok": sweeper.last_sweep_ok,
            "consecutive_failures": sweeper.consecutive_failures,
            # the human label the status strip shows; deriving it client-side would
            # duplicate the alarm engine's own account of its health
            "alarms": dict(zip(("label", "bad"), sweeper.alarm_state(), strict=True)),
            "fetched_at": display_time(sweeper.last_fetch_at, settings.display_tz),
        },
        # knobs a client cannot guess: the sweep cadence the meta line names, and the
        # retention window the muted table counts down to
        "settings": {
            "sweep_seconds": settings.monitor_interval_seconds,
            "expired_retention_days": settings.expired_retention_days,
            "display_tz": settings.display_tz,
        },
    }
