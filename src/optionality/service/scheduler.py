from functools import partial
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from sqlalchemy import select

from optionality.service.models import Schedule
from optionality.service.worker import Worker, create_run


def validate_cron(expr: str, tz: str) -> None:
    _make_trigger(expr, tz)


def _make_trigger(expr: str, tz: str) -> CronTrigger:
    try:
        timezone = ZoneInfo(tz)
    except (ZoneInfoNotFoundError, KeyError) as err:
        raise ValueError(f"unknown timezone: {tz}") from err
    try:
        return CronTrigger.from_crontab(expr, timezone=timezone)
    except ValueError as err:
        raise ValueError(f"invalid cron expression '{expr}': {err}") from err


def build_scheduler() -> BackgroundScheduler:
    return BackgroundScheduler(
        job_defaults={"coalesce": True, "max_instances": 1, "misfire_grace_time": 3600},
    )


def fire_schedule(schedule_id: int, session_factory, worker: Worker) -> None:
    with session_factory() as session:
        schedule = session.get(Schedule, schedule_id)
        if schedule is None or not schedule.enabled:
            return
        task_type, config_name = schedule.task_type, schedule.config_name
    run_id = create_run(
        session_factory,
        task_type=task_type,
        config_name=config_name,
        trigger="schedule",
        notify=True,
    )
    worker.submit(run_id)


def refresh_jobs(scheduler: BackgroundScheduler, session_factory, worker: Worker) -> int:
    # only reload schedule-* jobs; the monitor-sweep interval job must survive refreshes
    for job in scheduler.get_jobs():
        if job.id.startswith("schedule-"):
            scheduler.remove_job(job.id)
    with session_factory() as session:
        rows = session.scalars(select(Schedule).where(Schedule.enabled)).all()
    for row in rows:
        scheduler.add_job(
            partial(fire_schedule, row.id, session_factory, worker),
            trigger=_make_trigger(row.cron_expr, row.tz),
            id=f"schedule-{row.id}",
            replace_existing=True,
        )
    return len(rows)
