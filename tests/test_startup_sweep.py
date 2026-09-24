"""The sweep must run at startup, not one interval later.

An interval job with no initial run time first fires after a full interval, so every
`make launchd-restart` left the alarm engine quiet and the dashboard's cache empty for that
long — MONITOR_INTERVAL_SECONDS is 15 in production and restarts follow every merge.
"""

import time

from optionality.service.models import Monitor
from tests.conftest import AUTH


def _wait_for(predicate, seconds: float = 3.0) -> bool:
    """The sweep runs on the scheduler's thread, so this polls rather than sleeping blind."""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return False


def test_the_sweep_runs_at_startup_rather_than_an_interval_later(client_factory):
    def fetcher(codes, opend_host=None, opend_port=None):
        return [{"code": c, "option_delta": 0.4, "mid_price": 1.0} for c in codes]

    # a long interval makes the distinction unmistakable: if the sweep only ran on the
    # schedule, nothing would have happened for ten minutes
    client = client_factory(snapshot_fetcher=fetcher, monitor_interval_seconds=600)
    sweeper = client.app.state.sweeper

    # last_sweep_at is stamped at the TOP of sweep(), so waiting on it would observe a run
    # in progress; last_sweep_ok is only set once it has finished
    assert _wait_for(lambda: sweeper.last_sweep_ok is not None), "no sweep within 3s of startup"
    assert sweeper.last_sweep_ok is True


def test_the_dashboard_is_not_blank_right_after_a_restart(client_factory):
    """The cache is what the dashboard reads, so an empty one is a blank screen."""

    def fetcher(codes, opend_host=None, opend_port=None):
        return [{"code": c, "option_delta": 0.4, "mid_price": 1.0} for c in codes]

    client = client_factory(snapshot_fetcher=fetcher, monitor_interval_seconds=600)
    with client.app.state.session_factory() as session:
        session.add(
            Monitor(
                code="US.SPXW261218C8100000",
                strike_date="2026-12-18",
                option_type="CALL",
                strike=8100.0,
                field="option_delta",
                threshold=0.6,
            )
        )
        session.commit()
    # the startup sweep predates this monitor; the next one picks it up and fills the cache
    client.app.state.sweeper.sweep()
    by_code, fetched = client.app.state.sweeper.cached_records()
    assert by_code and fetched


def test_the_interval_still_governs_after_the_first_run(client_factory):
    """Running at startup must not turn the sweep into a one-shot."""
    client = client_factory(monitor_interval_seconds=600)
    job = client.app.state.scheduler.get_job("monitor-sweep")
    assert job is not None
    assert job.trigger.interval.total_seconds() == 600
    # next_run_time has already advanced by one interval, which is itself the evidence that
    # the first run happened rather than being pending
    assert job.next_run_time is not None


def test_health_reports_a_live_alarm_engine_immediately(client_factory):
    """ "starting" is honest only until the first sweep; after a restart the strip should
    say active rather than leaving you unsure whether anything is watching."""
    client = client_factory(snapshot_fetcher=lambda codes, **_: [{"code": c} for c in codes])
    assert _wait_for(lambda: client.get("/health", headers=AUTH).json()["monitor"]["alarms"]["label"] == "active"), (
        "health still reported 'starting' 3s after startup"
    )
