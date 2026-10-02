"""The subprocess boundary the TypeScript service calls (ADR 0009, phase 6c).

The run pipeline stays in Python: porting it would mean replacing pandas, the option chain scan and
yfinance for a feature that has run twice. What is new is this thin entry point, and it is on the
deploy path, so it is tested here.
"""

import json

import pytest

import optionality.runner as runner_mod
from optionality.core import RunResult


def _request(tmp_path, payload: dict):
    path = tmp_path / "request.json"
    path.write_text(json.dumps(payload))
    return str(path)


def _invoke(tmp_path, payload: dict, monkeypatch) -> dict:
    out = tmp_path / "response.json"
    monkeypatch.setattr("sys.argv", ["runner", _request(tmp_path, payload), str(out)])
    assert runner_mod.main() == 0
    return json.loads(out.read_text())


def test_a_run_returns_the_result_and_whether_it_notified(tmp_path, holdings_body, monkeypatch):
    monkeypatch.setattr(
        runner_mod,
        "run_task",
        lambda task, config, opend_host=None, opend_port=None: RunResult(
            html="<p>ok</p>", summary=[{"strike_date": "2026-12-18"}], warnings=None, details=[{"code": "x"}]
        ),
    )
    sent = []
    monkeypatch.setattr(runner_mod, "send_notifications", lambda notification, html: sent.append(html))

    response = _invoke(
        tmp_path,
        {"mode": "run", "task": "holdings", "config": holdings_body, "notify": True},
        monkeypatch,
    )

    assert response["ok"] is True
    assert response["html"] == "<p>ok</p>"
    assert response["summary"] == [{"strike_date": "2026-12-18"}]
    assert response["details"] == [{"code": "x"}]
    assert response["notify_error"] is None
    assert sent == ["<p>ok</p>"]


def test_notify_false_sends_nothing(tmp_path, holdings_body, monkeypatch):
    monkeypatch.setattr(
        runner_mod,
        "run_task",
        lambda task, config, opend_host=None, opend_port=None: RunResult(html="x", summary=[], warnings=None),
    )
    sent = []
    monkeypatch.setattr(runner_mod, "send_notifications", lambda notification, html: sent.append(html))
    _invoke(tmp_path, {"mode": "run", "task": "holdings", "config": holdings_body, "notify": False}, monkeypatch)
    assert sent == []


def test_a_report_that_cannot_be_sent_is_still_a_report(tmp_path, holdings_body, monkeypatch):
    """A run that produced its figures and failed to email them succeeded. The two are different
    failures, and the caller records them differently."""

    def boom(notification, html):
        raise RuntimeError("smtp refused")

    monkeypatch.setattr(
        runner_mod,
        "run_task",
        lambda task, config, opend_host=None, opend_port=None: RunResult(html="x", summary=[], warnings=None),
    )
    monkeypatch.setattr(runner_mod, "send_notifications", boom)

    response = _invoke(
        tmp_path, {"mode": "run", "task": "holdings", "config": holdings_body, "notify": True}, monkeypatch
    )
    assert response["ok"] is True
    assert response["html"] == "x"
    assert response["notify_error"] == "smtp refused"


def test_a_failed_task_is_a_response_not_a_crash(tmp_path, holdings_body, monkeypatch):
    """Exit 0 with ok:false. A non-zero exit means the bridge itself failed and the response file may
    not exist; only this case carries an error worth showing on the run."""

    def boom(task, config, opend_host=None, opend_port=None):
        raise RuntimeError("Client connection failed!")

    monkeypatch.setattr(runner_mod, "run_task", boom)
    response = _invoke(
        tmp_path, {"mode": "run", "task": "holdings", "config": holdings_body, "notify": False}, monkeypatch
    )
    assert response["ok"] is False
    assert response["error"] == "Client connection failed!"
    assert response["type"] == "RuntimeError"


def test_an_invalid_config_fails_before_opend_is_touched(tmp_path, monkeypatch):
    monkeypatch.setattr(runner_mod, "run_task", lambda *a, **k: pytest.fail("run_task must not be reached"))
    response = _invoke(
        tmp_path, {"mode": "run", "task": "holdings", "config": {"nope": True}, "notify": False}, monkeypatch
    )
    assert response["ok"] is False
    assert response["type"] == "ValidationError"


def test_the_opend_address_is_passed_through(tmp_path, holdings_body, monkeypatch):
    seen = {}

    def spy(task, config, opend_host=None, opend_port=None):
        seen.update(host=opend_host, port=opend_port)
        return RunResult(html="x", summary=[], warnings=None)

    monkeypatch.setattr(runner_mod, "run_task", spy)
    _invoke(
        tmp_path,
        {
            "mode": "run",
            "task": "holdings",
            "config": holdings_body,
            "notify": False,
            "opend_host": "10.0.0.2",
            "opend_port": "11112",
        },
        monkeypatch,
    )
    assert seen == {"host": "10.0.0.2", "port": 11112}


def test_the_alert_mode_sends_the_failure_email(tmp_path, holdings_body, monkeypatch):
    body = dict(holdings_body)
    body["notification"] = {"gmail": {"subject": "report", "from_address": "a@b.co", "to_address": ["a@b.co"]}}
    emails = []
    monkeypatch.setattr(runner_mod, "send_gmail_notification", lambda setting, msg: emails.append((setting, msg)))

    response = _invoke(
        tmp_path,
        {"mode": "alert", "task": "holdings", "config": body, "subject": "failed", "message": "<p>why</p>"},
        monkeypatch,
    )

    assert response == {"ok": True, "sent": True}
    setting, message = emails[0]
    assert setting["subject"] == "failed"  # the run's subject replaces the config's
    assert message == "<p>why</p>"


def test_the_alert_mode_says_so_when_the_config_wants_no_email(tmp_path, holdings_body, monkeypatch):
    """A config with no gmail block is not a failure to email; it is a config that does not want one."""
    monkeypatch.setattr(
        runner_mod, "send_gmail_notification", lambda setting, msg: pytest.fail("no email was asked for")
    )
    response = _invoke(
        tmp_path,
        {"mode": "alert", "task": "holdings", "config": holdings_body, "subject": "s", "message": "m"},
        monkeypatch,
    )
    assert response["ok"] is True
    assert response["sent"] is False
    assert "gmail" in response["reason"]
