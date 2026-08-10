from sqlalchemy import select

import optionality.service.worker as worker_mod
from optionality.core import RunResult
from optionality.service.models import ConfigDoc, Report, Run
from optionality.service.settings import Settings
from optionality.service.worker import Worker, create_run

SETTINGS = Settings(retry_delay_seconds=0)


def _insert_config(session_factory, holdings_body, name="c1"):
    with session_factory() as s:
        s.add(ConfigDoc(name=name, task_type="holdings", body=holdings_body))
        s.commit()


def _stub_runner(task, config, client_factory=None, opend_host=None, opend_port=None):
    return RunResult(html="<p>ok</p>", summary=[{"strike_date": "2026-12-18"}], warnings=None)


def _boom_runner(task, config, client_factory=None, opend_host=None, opend_port=None):
    raise RuntimeError("Client connection failed!")


def test_success_stores_report_and_notifies(session_factory, holdings_body, monkeypatch):
    _insert_config(session_factory, holdings_body)
    sent = []
    monkeypatch.setattr(worker_mod, "send_notifications", lambda cfg, html: sent.append(html))
    rid = create_run(session_factory, task_type="holdings", config_name="c1", trigger="api", notify=True)

    Worker(session_factory, SETTINGS, runner=_stub_runner)._execute(rid)

    with session_factory() as s:
        run = s.get(Run, rid)
        assert run.status == "succeeded"
        assert run.finished_at is not None
        report = s.get(Report, rid)
        assert report.html == "<p>ok</p>"
        assert report.summary["summary"] == [{"strike_date": "2026-12-18"}]
    assert sent == ["<p>ok</p>"]


def test_no_notify_flag_skips_notification(session_factory, holdings_body, monkeypatch):
    _insert_config(session_factory, holdings_body)
    sent = []
    monkeypatch.setattr(worker_mod, "send_notifications", lambda cfg, html: sent.append(html))
    rid = create_run(session_factory, task_type="holdings", config_name="c1", trigger="api", notify=False)
    Worker(session_factory, SETTINGS, runner=_stub_runner)._execute(rid)
    assert sent == []


def test_scheduled_failure_schedules_retry(session_factory, holdings_body, monkeypatch):
    _insert_config(session_factory, holdings_body)
    retries = []
    monkeypatch.setattr(Worker, "_schedule_retry", lambda self, delay, run_id: retries.append(run_id))
    rid = create_run(session_factory, task_type="holdings", config_name="c1", trigger="schedule", notify=True)

    Worker(session_factory, SETTINGS, runner=_boom_runner)._execute(rid)

    with session_factory() as s:
        assert s.get(Run, rid).status == "failed"
        retry = s.scalar(select(Run).where(Run.attempt == 2))
        assert retry is not None
        assert retry.trigger == "schedule"
        assert retries == [retry.id]


def test_final_scheduled_failure_sends_failure_email(session_factory, holdings_body, monkeypatch):
    body = dict(holdings_body)
    body["notification"] = {"gmail": {"subject": "report", "from_address": "a@b.co", "to_address": ["a@b.co"]}}
    _insert_config(session_factory, body)
    emails = []
    monkeypatch.setattr(worker_mod, "send_gmail_notification", lambda setting, msg: emails.append((setting, msg)))
    rid = create_run(
        session_factory, task_type="holdings", config_name="c1", trigger="schedule", notify=True, attempt=2
    )

    Worker(session_factory, SETTINGS, runner=_boom_runner)._execute(rid)

    assert len(emails) == 1
    setting, msg = emails[0]
    assert "failed" in setting["subject"]
    assert "Client connection failed" in msg
    assert "OpenD" in msg  # logged-out hint


def test_final_failure_sends_telegram_alert_without_gmail(session_factory, holdings_body, monkeypatch):
    _insert_config(session_factory, holdings_body)  # file-only notification, no gmail block
    alerts = []
    monkeypatch.setattr(worker_mod, "send_telegram_message", lambda token, chat, text: alerts.append(text))
    settings = Settings(retry_delay_seconds=0, telegram_bot_token="t", telegram_chat_id="42")
    rid = create_run(
        session_factory, task_type="holdings", config_name="c1", trigger="schedule", notify=True, attempt=2
    )

    Worker(session_factory, settings, runner=_boom_runner)._execute(rid)

    assert len(alerts) == 1
    assert "failed" in alerts[0]
    assert "OpenD" in alerts[0]  # logged-out hint


def test_healthcheck_ping_only_for_scheduled_success(session_factory, holdings_body, monkeypatch):
    _insert_config(session_factory, holdings_body)
    pings = []
    monkeypatch.setattr(Worker, "_ping_healthcheck", lambda self: pings.append(True))
    rid = create_run(session_factory, task_type="holdings", config_name="c1", trigger="schedule", notify=False)
    Worker(session_factory, SETTINGS, runner=_stub_runner)._execute(rid)
    assert pings == [True]
