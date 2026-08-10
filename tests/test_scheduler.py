import pytest
from sqlalchemy import select

from optionality.service.models import ConfigDoc, Run, Schedule
from optionality.service.scheduler import build_scheduler, fire_schedule, refresh_jobs, validate_cron
from optionality.service.settings import Settings
from optionality.service.worker import Worker


def test_validate_cron():
    validate_cron("35 9 * * mon-fri", "America/New_York")
    with pytest.raises(ValueError):
        validate_cron("not a cron", "America/New_York")
    with pytest.raises(ValueError):
        validate_cron("0 9 * * *", "Mars/Olympus")


def test_refresh_jobs_loads_enabled_only(session_factory, holdings_body):
    with session_factory() as s:
        s.add(ConfigDoc(name="c1", task_type="holdings", body=holdings_body))
        s.add(Schedule(cron_expr="35 9 * * mon-fri", task_type="holdings", config_name="c1", enabled=True))
        s.add(Schedule(cron_expr="0 16 * * mon-fri", task_type="holdings", config_name="c1", enabled=False))
        s.commit()
        enabled_id = s.scalar(select(Schedule).where(Schedule.enabled)).id

    worker = Worker(session_factory, Settings())
    scheduler = build_scheduler()
    count = refresh_jobs(scheduler, session_factory, worker)
    assert count == 1
    assert scheduler.get_job(f"schedule-{enabled_id}") is not None


def test_refresh_jobs_preserves_non_schedule_jobs(session_factory):
    scheduler = build_scheduler()
    scheduler.add_job(lambda: None, "interval", seconds=3600, id="monitor-sweep")
    refresh_jobs(scheduler, session_factory, Worker(session_factory, Settings()))
    assert scheduler.get_job("monitor-sweep") is not None


def test_fire_schedule_creates_and_submits_run(session_factory, holdings_body):
    with session_factory() as s:
        s.add(ConfigDoc(name="c1", task_type="holdings", body=holdings_body))
        sched = Schedule(cron_expr="35 9 * * mon-fri", task_type="holdings", config_name="c1")
        s.add(sched)
        s.commit()
        sched_id = sched.id

    worker = Worker(session_factory, Settings())  # not started; we inspect its queue
    fire_schedule(sched_id, session_factory, worker)

    with session_factory() as s:
        run = s.scalar(select(Run))
        assert run.trigger == "schedule"
        assert run.notify is True
        assert run.task_type == "holdings"
    assert worker.queue_depth() == 1
